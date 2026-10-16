'use strict';
// node test-servidor.js — sobe o painel de verdade (porta aleatória, banco e cofre do plugin
// temporários) e confere:
//   - o painel só atende localhost e recusa POST vindo de outro site (é isso que o protege:
//     sem túnel, não há senha);
//   - o app do plugin hn-anuncio-ml é reaproveitado, e as contas dele aparecem como sugestão;
//   - o login vai para a URI fixa de redirect e o code colado só vale para o login pendente.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
process.env.ML_DB_FILE = path.join(os.tmpdir(), `teste-srv-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_KEY = 'chave-de-teste-nao-usar-em-producao';
const COFRE = fs.mkdtempSync(path.join(os.tmpdir(), 'teste-srv-plugin-'));
process.env.ANUNCIO_OS_CONFIG = path.join(COFRE, 'config.json'); // vazio: "sem plugin"
delete process.env.ML_CLIENT_ID;
delete process.env.ML_CLIENT_SECRET;
delete process.env.ML_REDIRECT_URI;
const assert = require('node:assert');
const http = require('node:http');

// Mercado Livre falso: o teste não depende de internet nem de app de verdade.
const ML = { recusaApp: false, callbacks: ['https://httpbin.org/get'], pedidosToken: [] };
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, op = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.mercadolibre.com/')) return fetchReal(url, op);
  const resp = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/oauth/token')) {
    const f = Object.fromEntries(new URLSearchParams(String(op.body)));
    ML.pedidosToken.push(f);
    if (ML.recusaApp) return resp(400, { error: 'invalid_client', message: 'invalid client_id or client_secret' });
    if (f.grant_type === 'client_credentials') return resp(200, { access_token: 'APP_USR-do-app', expires_in: 21600 });
    if (f.code === 'TG-bom') return resp(200, { access_token: 'APP_USR-da-conta', refresh_token: 'TG-novo', expires_in: 21600 });
    return resp(400, { error: 'invalid_grant', message: 'Error validating grant.' });
  }
  if (u.includes('/applications/')) {
    return resp(200, { name: 'App Teste', callback_urls: ML.callbacks, use_pkce: true,
      allow_flow: ['authorization_code', 'client_credentials', 'refresh_token'] });
  }
  if (u.endsWith('/users/me')) return resp(200, { id: 555, nickname: 'LOJA_X', site_id: 'MLB' });
  return resp(404, { error: 'not_found' });
};
const S = require('./server.js');
const D = require('./db.js');

function pedir(porta, caminho, { metodo = 'GET', headers = {}, corpo = null } = {}) {
  return new Promise((ok, falha) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo,
      headers: { Host: `localhost:${porta}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, corpo: b }));
    });
    req.on('error', falha);
    if (corpo) req.write(corpo);
    req.end();
  });
}

(async () => {
  // Porta ocupada em qualquer pilha não pode parecer livre. Regressão real: um painel em
  // [::]:3100 passou por "livre" e a cópia da aula subiu por cima, em 127.0.0.1:3100.
  const net = require('node:net');
  const Pr = require('./processos.js');
  for (const host of [undefined, '127.0.0.1']) {
    const outro = net.createServer();
    await new Promise((ok) => outro.listen(0, host, ok));
    assert.strictEqual(await Pr.portaLivre(outro.address().port), false,
      `porta ocupada em ${host || 'todas as interfaces'} tem de contar como ocupada`);
    await new Promise((ok) => outro.close(ok));
  }

  const srv = await S.iniciar({ porta: 0, servicos: { scraper: () => null } });
  const P = srv.porta;
  const ORIGEM = { Origin: `http://localhost:${P}` };
  const json = (corpo) => ({ metodo: 'POST', headers: ORIGEM, corpo: JSON.stringify(corpo) });
  let r;

  try {
    // ---------- só localhost, sem senha ----------
    r = await pedir(P, '/', { headers: { Host: 'site-malicioso.com' } });
    assert.strictEqual(r.status, 403, 'Host de fora = DNS rebinding');
    r = await pedir(P, '/api/ping');
    assert.strictEqual(JSON.parse(r.corpo).app, 'aula-ml');
    r = await pedir(P, '/configuracao.html');
    assert.strictEqual(r.status, 200, 'sem senha: o painel abre direto');
    assert.strictEqual(r.headers['referrer-policy'], 'same-origin',
      'no-referrer faz o navegador mandar Origin: null no POST e recusa o próprio aluno');
    for (const [origem, site] of [['https://site-malicioso.com', 'cross-site'], ['null', undefined], ['null', 'cross-site']]) {
      const h = { Origin: origem, ...(site ? { 'Sec-Fetch-Site': site } : {}) };
      r = await pedir(P, '/api/config/credenciais', { metodo: 'POST', headers: h, corpo: JSON.stringify({ app_id: '1', secret: 'x' }) });
      assert.strictEqual(r.status, 403, `outro site (Origin ${origem}, ${site}) não posta no painel`);
    }
    for (const c of ['/login', '/primeiro-acesso', '/webhook', '/api/notifications']) {
      r = await pedir(P, c);
      assert.strictEqual(r.status, 404, `${c} saiu junto com o túnel`);
    }

    // ---------- configuração, sem app nenhum ----------
    r = await pedir(P, '/api/config');
    let c = JSON.parse(r.corpo);
    assert.strictEqual(c.pendente, 'credenciais');
    assert.strictEqual(c.plugin, null);
    assert.strictEqual(c.redirect, 'https://httpbin.org/get');
    r = await pedir(P, '/api/config/resumo');
    assert.strictEqual(JSON.parse(r.corpo).pendente, 'credenciais');
    r = await pedir(P, '/api/config/credenciais', json({ app_id: 'abc', secret: 'x' }));
    assert.strictEqual(r.status, 400, 'App ID com letra é recusado antes de ir ao ML');
    r = await pedir(P, '/auth');
    assert.strictEqual(r.headers.location, '/configuracao.html?erro=credenciais');
    // sem conta, só a Configuração: as outras telas voltam para ela
    for (const c of ['/', '/inicio.html', '/publicar.html', '/anuncios.html', '/navegador.html']) {
      assert.strictEqual((await pedir(P, c)).headers.location, '/configuracao.html', `${c} travada sem conta`);
    }
    assert.strictEqual((await pedir(P, '/aviso.js')).status, 200, 'o trava é só das telas, não dos arquivos');

    // ---------- plugin instalado antes: a tela pré-preenche com o app dele ----------
    fs.writeFileSync(process.env.ANUNCIO_OS_CONFIG, JSON.stringify({
      client_id: '1234567890', client_secret: 'segredo-falso-de-teste-123', redirect_uri: 'https://httpbin.org/get',
    }));
    fs.mkdirSync(path.join(COFRE, 'contas'));
    fs.writeFileSync(path.join(COFRE, 'contas', '555.json'), JSON.stringify({ nickname: 'LOJA_X', refresh_token: 'TG-nao-sai-daqui' }));
    r = await pedir(P, '/api/config');
    c = JSON.parse(r.corpo);
    assert.strictEqual(c.app_id, null, 'o app do plugin não vale sozinho: o aluno confirma');
    assert.strictEqual(c.pendente, 'credenciais');
    assert.deepStrictEqual(c.plugin, { app_id: '1234567890', contas: [{ id: 555, nickname: 'LOJA_X', conectada: false }] });
    assert.ok(!r.corpo.includes('segredo-falso') && !r.corpo.includes('TG-nao-sai-daqui'),
      'nem chave nem token do plugin na /api/config (é a ml_config do MCP)');
    r = await pedir(P, '/api/config/app-do-plugin');
    assert.deepStrictEqual(JSON.parse(r.corpo), { app_id: '1234567890', secret: 'segredo-falso-de-teste-123' });
    assert.ok(!r.corpo.includes('TG-nao-sai-daqui'), 'token das contas do plugin nunca');
    // "Salvar e validar" com o que veio pré-preenchido
    r = await pedir(P, '/api/config/credenciais', json({ app_id: '1234567890', secret: 'segredo-falso-de-teste-123' }));
    assert.strictEqual(r.status, 200, r.corpo);
    c = JSON.parse((await pedir(P, '/api/config')).corpo);
    assert.strictEqual(c.origem_credenciais, 'painel');
    assert.strictEqual(c.situacao.estado, 'confere');
    assert.strictEqual(c.pendente, 'conta');
    assert.strictEqual((await pedir(P, '/')).headers.location, '/configuracao.html', 'ainda travada: falta a conta');

    // ---------- OAuth: URI fixa e code colado ----------
    r = await pedir(P, '/auth');
    assert.strictEqual(r.status, 302);
    const destino = new URL(r.headers.location);
    assert.strictEqual(destino.host, 'auth.mercadolivre.com.br');
    assert.strictEqual(destino.searchParams.get('client_id'), '1234567890');
    assert.strictEqual(destino.searchParams.get('redirect_uri'), 'https://httpbin.org/get');
    assert.strictEqual(destino.searchParams.get('code_challenge_method'), 'S256');
    const state = destino.searchParams.get('state');
    assert.match(state, /^[a-f0-9]{32}$/);

    r = await pedir(P, '/api/config/conectar', json({ texto: '' }));
    assert.strictEqual(r.status, 400);
    r = await pedir(P, '/api/config/conectar', json({ texto: 'https://httpbin.org/get?code=TG-falso&state=outro' }));
    assert.strictEqual(r.status, 400);
    assert.match(JSON.parse(r.corpo).error, /login anterior/, 'endereço de outro login é recusado');
    r = await pedir(P, '/api/config/conectar', json({ texto: `https://httpbin.org/get?code=TG-falso&state=${state}` }));
    assert.strictEqual(r.status, 400);
    assert.match(JSON.parse(r.corpo).error, /recusou o código/, 'code inválido: o ML recusa e o painel explica');
    // colar só o code também vale: o login pendente é o único
    r = await pedir(P, '/api/config/conectar', json({ texto: ' TG-bom ' }));
    assert.strictEqual(r.status, 200, r.corpo);
    assert.strictEqual(JSON.parse(r.corpo).nickname, 'LOJA_X');
    const troca = ML.pedidosToken.findLast((f) => f.code === 'TG-bom');
    assert.strictEqual(troca.redirect_uri, 'https://httpbin.org/get', 'a MESMA redirect_uri do /auth');
    assert.ok(troca.code_verifier && troca.client_secret === 'segredo-falso-de-teste-123');
    c = JSON.parse((await pedir(P, '/api/config')).corpo);
    assert.strictEqual(c.pendente, null);
    assert.deepStrictEqual(c.plugin.contas, [{ id: 555, nickname: 'LOJA_X', conectada: true }]);
    r = await pedir(P, '/');
    assert.strictEqual(r.status, 200, 'com conta, as telas liberam');
    r = await pedir(P, '/api/config/conectar', json({ texto: 'TG-bom' }));
    assert.match(JSON.parse(r.corpo).error, /expirou|não começou/, 'code é de uso único: o login pendente acabou');

    // URI fora do cadastro: o /auth explica aqui em vez de cair no erro genérico do ML
    ML.callbacks = ['https://velha.trycloudflare.com/callback'];
    c = JSON.parse((await pedir(P, '/api/config?forcar=1')).corpo);
    assert.strictEqual(c.pendente, 'url');
    assert.strictEqual((await pedir(P, '/auth')).headers.location, '/configuracao.html?erro=url');
    ML.callbacks = ['https://httpbin.org/get'];

    // chave salva e depois trocada no DevCenter: o ML recusa o par e o painel pede a atual
    ML.recusaApp = true;
    c = JSON.parse((await pedir(P, '/api/config?forcar=1')).corpo);
    assert.strictEqual(c.credenciais_invalidas, true);
    assert.strictEqual(c.tem_credenciais, false);
    assert.strictEqual(c.pendente, 'credenciais');
    assert.strictEqual((await pedir(P, '/auth')).headers.location, '/configuracao.html?erro=credenciais');
    ML.recusaApp = false;

    // ---------- estáticos ----------
    r = await pedir(P, '/aviso.js');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/javascript/);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    for (const c of ['/..%2fserver.js', '/%2e%2e/db.js', '/..%5cserver.js', '/%E0%A4%A']) {
      r = await pedir(P, c);
      assert.ok([400, 403, 404].includes(r.status), `não pode escapar de public/: ${c} (deu ${r.status})`);
      assert.ok(!r.corpo.includes('use strict'), `não pode vazar código: ${c}`);
    }

    console.log('OK — só localhost, POST de outro site recusado, telas travadas sem conta, app do plugin pré-preenchido, login com code colado');
  } finally {
    await srv.fechar();
    D.db.close();
    fs.rmSync(COFRE, { recursive: true, force: true });
    for (const f of [process.env.ML_DB_FILE, process.env.ML_DB_FILE + '-wal', process.env.ML_DB_FILE + '-shm']) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
