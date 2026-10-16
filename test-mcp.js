'use strict';
// node test-mcp.js — o servidor MCP (mcp.js). Banco temporário: rodar teste não pode
// tocar no dados.sqlite do dono.
//
// O que aqui se protege:
//   1. toda ferramenta aponta para uma rota que EXISTE no painel (renomeou rota? quebra aqui,
//      não na frente do usuário);
//   2. o stdout só tem JSON-RPC — uma linha solta de log e o cliente MCP derruba a conexão;
//   3. notificação (sem id) não recebe resposta;
//   4. ML_MCP_ESCRITA=0 realmente esconde e bloqueia o que muda dados;
//   5. erro de ferramenta volta como isError, com a mensagem legível — não como erro de protocolo.
const path = require('node:path');
const os = require('node:os');
const BANCO = path.join(os.tmpdir(), `teste-mcp-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_FILE = BANCO;
process.env.ML_DB_KEY = 'chave-de-teste-nao-usar-em-producao';
// o cofre real do plugin, se houver nesta máquina, fica fora do teste
process.env.ANUNCIO_OS_CONFIG = path.join(os.tmpdir(), 'sem-plugin-nos-testes', 'config.json');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const M = require('./mcp.js');
const S = require('./server.js');

// Entradas de exemplo, uma por ferramenta. Ferramenta nova sem exemplo reprova o teste.
const EXEMPLOS = {
  ml_contas: {},
  ml_conta_usar: { ml_user_id: 123 },
  ml_anuncios: { status: 'active', sort: 'abc', dias: 30, limit: 20, offset: 0 },
  ml_periodo: { ids: ['MLB1234567890', 'MLB9876543210'], dias: 60 },
  ml_anuncio: { id: 'MLB1234567890' },
  ml_analise: { id: 'MLB1234567890', dias: 90 },
  ml_qualidade: { id: 'MLB1234567890' },
  ml_upgrades: { id: 'MLB1234567890' },
  ml_posicao: { item: 'MLB1234567890', termo: 'camiseta preta', paginas: 2 },
  ml_termos: { item: 'MLB1234567890' },
  ml_termo_add: { item: 'MLB1234567890', termo: 'camiseta preta' },
  ml_termo_remover: { item: 'MLB1234567890', termo: 'camiseta preta' },
  ml_publicar: { title: 'Camiseta', category_id: 'MLB31447', price: 89.9, quantity: 3 },
  ml_editar: { id: 'MLB1234567890', price: 99.9 },
  ml_editar_descricao: { id: 'MLB1234567890', texto: 'nova descrição' },
  ml_trocar_tipo: { id: 'MLB1234567890', listing_type_id: 'gold_pro' },
  ml_custo: { id: 'MLB1234567890', custo: 10, outros: 2 },
  ml_imposto: { pct: 8 },
  ml_prever_categoria: { q: 'camiseta preta' },
  ml_categoria: { id: 'MLB31447' },
  ml_tipos_anuncio: {},
  ml_config: { forcar: true },
  ml_scraper: {},
  ml_ads: {},
  ml_api: { caminho: '/users/me' },
};

// ---------- 1. cada ferramenta cai numa rota real do painel ----------
const semExemplo = M.FERRAMENTAS.filter((f) => !EXEMPLOS[f.nome]).map((f) => f.nome);
assert.deepStrictEqual(semExemplo, [], `ferramenta sem exemplo em test-mcp.js: ${semExemplo}`);
for (const f of M.FERRAMENTAS) {
  assert.ok(f.descricao && f.schema && f.titulo, `${f.nome}: falta título, descrição ou schema`);
  if (f.direta) continue; // ml_api não usa rota do painel: vai direto na API do ML
  const [metodo, caminho] = f.rota(EXEMPLOS[f.nome]);
  assert.ok(S.temRota(metodo, new URL(`http://painel.local${caminho}`)),
    `${f.nome} aponta para ${metodo} ${caminho}, que não é rota do painel`);
}

// ---------- 2. protocolo, por stdio de verdade ----------
function servidor(env = {}) {
  const p = spawn(process.execPath, [path.join(__dirname, 'mcp.js')], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const respostas = [];
  const esperando = new Map();
  let buffer = '';
  let lixo = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    buffer += c;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linha = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!linha) continue;
      let msg;
      try { msg = JSON.parse(linha); } catch { lixo += linha; continue; }
      respostas.push(msg);
      const ok = esperando.get(msg.id);
      if (ok) { esperando.delete(msg.id); ok(msg); }
    }
  });
  return {
    processo: p,
    respostas,
    lixo: () => lixo,
    pedir(id, method, params) {
      const promessa = new Promise((ok, falha) => {
        esperando.set(id, ok);
        setTimeout(() => falha(new Error(`sem resposta para ${method}`)), 10000).unref();
      });
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return promessa;
    },
    avisar(method, params) { p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    cru(texto) { p.stdin.write(`${texto}\n`); },
    fim() { p.stdin.end(); return new Promise((ok) => p.on('exit', ok)); },
  };
}

(async () => {
  const s = servidor({ ML_DB_FILE: BANCO });
  try {
    const ini = await s.pedir(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } });
    assert.strictEqual(ini.result.protocolVersion, '2025-06-18', 'devolve a versão que o cliente falou');
    assert.strictEqual(ini.result.serverInfo.name, 'HN-Gestor-ML');
    assert.ok(ini.result.capabilities.tools, 'anuncia a capacidade de ferramentas');

    // versão desconhecida: responde com a nossa, em vez de repetir a do cliente
    const antigo = await s.pedir(2, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    assert.strictEqual(antigo.result.protocolVersion, '2025-06-18');

    // notificação não tem resposta
    s.avisar('notifications/initialized', {});
    const pong = await s.pedir(3, 'ping', {});
    assert.deepStrictEqual(pong.result, {}, 'ping responde vazio');
    assert.ok(!s.respostas.some((r) => r.id === undefined || r.id === null),
      'notificação não pode gerar resposta');

    const lista = (await s.pedir(4, 'tools/list', {})).result.tools;
    assert.strictEqual(lista.length, M.FERRAMENTAS.length, 'com escrita ligada, todas aparecem');
    for (const nome of ['ml_anuncios', 'ml_periodo', 'ml_analise', 'ml_api', 'ml_publicar']) {
      assert.ok(lista.find((t) => t.name === nome), `falta a ferramenta ${nome}`);
    }
    for (const t of lista) {
      assert.ok(t.description.length > 20, `${t.name}: descrição curta demais para o modelo escolher`);
      assert.strictEqual(t.inputSchema.type, 'object', `${t.name}: inputSchema precisa ser object`);
    }
    // a de listagem precisa explicar como pedir "melhores produtos" e curva ABC
    const anuncios = lista.find((t) => t.name === 'ml_anuncios');
    assert.match(anuncios.description, /vendas_desc/);
    assert.match(anuncios.description, /abc/i);
    assert.ok(anuncios.inputSchema.properties.sort.enum.includes('queda'));
    assert.strictEqual(lista.find((t) => t.name === 'ml_anuncio').annotations.readOnlyHint, true);
    assert.strictEqual(lista.find((t) => t.name === 'ml_publicar').annotations.readOnlyHint, false);

    // banco vazio: contas responde sem tocar no Mercado Livre
    const contas = await s.pedir(5, 'tools/call', { name: 'ml_contas', arguments: {} });
    assert.ok(!contas.result.isError, 'ml_contas não deveria dar erro com banco vazio');
    const corpo = JSON.parse(contas.result.content[0].text);
    assert.deepStrictEqual(corpo, { ativa: null, contas: [] });

    // sem conta conectada: erro legível, como resultado (isError), não como erro de protocolo
    const semConta = await s.pedir(6, 'tools/call', { name: 'ml_anuncios', arguments: {} });
    assert.strictEqual(semConta.result.isError, true);
    assert.ok(!semConta.error, 'erro de ferramenta não vira erro de JSON-RPC');
    assert.match(semConta.result.content[0].text, /conta/i);

    const naoExiste = await s.pedir(7, 'tools/call', { name: 'ml_inventada', arguments: {} });
    assert.strictEqual(naoExiste.result.isError, true);
    assert.match(naoExiste.result.content[0].text, /desconhecida/i);

    // caminho inválido no repasse: recusado antes de chegar ao Mercado Livre
    const caminhoRuim = await s.pedir(8, 'tools/call', { name: 'ml_api', arguments: { caminho: 'users/me' } });
    assert.strictEqual(caminhoRuim.result.isError, true);
    assert.match(caminhoRuim.result.content[0].text, /começar com/i);

    // JSON quebrado não derruba o servidor
    s.cru('{isso não é json}');
    const erroParse = await new Promise((ok) => {
      const t = setInterval(() => {
        const r = s.respostas.find((x) => x.error?.code === -32700);
        if (r) { clearInterval(t); ok(r); }
      }, 20);
      t.unref();
    });
    assert.strictEqual(erroParse.error.code, -32700);
    const depois = await s.pedir(9, 'ping', {});
    assert.deepStrictEqual(depois.result, {}, 'o servidor continua vivo depois do JSON inválido');

    assert.strictEqual(s.lixo(), '', 'stdout só pode ter JSON-RPC (log vai para o stderr)');
  } finally {
    await s.fim();
  }

  // ---------- 3. só leitura ----------
  const so = servidor({ ML_DB_FILE: BANCO, ML_MCP_ESCRITA: '0' });
  try {
    await so.pedir(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const lista = (await so.pedir(2, 'tools/list', {})).result.tools;
    assert.ok(!lista.find((t) => t.name === 'ml_publicar'), 'com ML_MCP_ESCRITA=0, publicar some da lista');
    assert.ok(lista.find((t) => t.name === 'ml_anuncios'), 'leitura continua disponível');
    assert.ok(lista.every((t) => t.annotations.readOnlyHint), 'só leitura: nenhuma ferramenta de escrita');

    const bloqueada = await so.pedir(3, 'tools/call', { name: 'ml_publicar', arguments: { title: 'x' } });
    assert.strictEqual(bloqueada.result.isError, true);
    assert.match(bloqueada.result.content[0].text, /ML_MCP_ESCRITA/);

    // o repasse continua na lista — ler a API inteira é leitura —, mas só com GET
    assert.ok(lista.find((t) => t.name === 'ml_api'), 'ml_api continua disponível para leitura');
    const post = await so.pedir(4, 'tools/call', { name: 'ml_api', arguments: { caminho: '/users/me', metodo: 'POST' } });
    assert.strictEqual(post.result.isError, true);
    assert.match(post.result.content[0].text, /ML_MCP_ESCRITA/);
    assert.match(post.result.content[0].text, /GET/, 'a mensagem diz que só GET passa');
  } finally {
    await so.fim();
  }

  // ---------- 4. fechar o stdin não engole a resposta que já foi pedida ----------
  // O servidor saía no 'end' do stdin. Medido em 19/09/2026: um ml_api /users/me pedido e
  // seguido do fechamento voltava VAZIO — a chamada morria esperando o Mercado Livre.
  // Este teste é offline, então só cobre o caso rápido (a ferramenta responde num
  // microtask, antes do 'end'); o caso da rede está coberto pelo drain do mcp.js, que
  // espera as chamadas pendentes. Não confunda: com ferramenta local ele passa dos dois jeitos.
  const s3 = servidor({ ML_DB_FILE: BANCO });
  await s3.pedir(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const ultima = s3.pedir(2, 'tools/call', { name: 'ml_contas', arguments: {} });
  s3.processo.stdin.end();
  const r3 = await ultima;
  assert.ok(!r3.result.isError, 'a última chamada tem de ser respondida antes de o servidor sair');
  await new Promise((ok) => s3.processo.on('exit', ok));

  console.log('OK — MCP: rotas existem, protocolo, stdout limpo, notificação sem resposta, modo só leitura, saída sem engolir resposta');
  require('./db.js').db.close();
  for (const f of [BANCO, `${BANCO}-wal`, `${BANCO}-shm`]) {
    try { require('node:fs').unlinkSync(f); } catch {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
