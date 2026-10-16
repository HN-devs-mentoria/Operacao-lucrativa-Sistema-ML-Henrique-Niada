'use strict';
// Backend do painel de anúncios do Mercado Livre.
// Node 22.13+ (fetch e node:sqlite nativos). Tokens vivem no SQLite, cifrados, e NUNCA
// chegam ao browser.
//
// Um servidor só, em 127.0.0.1:PORT (padrão 3100), para quem está neste computador. Não
// há túnel nem porta pública: o login do ML volta para uma página fixa (REDIRECT_PADRAO)
// e o aluno cola o code no painel — o mesmo padrão do plugin hn-anuncio-ml.
if (require.main === module) require('./ambiente.js').carregar(); // antes do db.js ler a chave
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const D = require('./db.js');
const APP = require('./app-ml.js');
const A = require('./public/analise.js'); // o mesmo arquivo que a tela usa

const PORT = Number(process.env.PORT) || 3100;
const SITE_PADRAO = process.env.ML_SITE || 'MLB';
const API = 'https://api.mercadolibre.com';
const MAX_FOTO_BYTES = 10 * 1024 * 1024;
// Cada instalação tem o próprio banco: conta conectada em outro painel não aparece aqui.
const SEM_CONTA = 'Nenhuma conta do Mercado Livre conectada neste painel. Conecte em Configurações → passo 3 (“Conectar conta”).';

// O scraper é do iniciar.js. Rodando `node server.js` sozinho, valem estes padrões.
let servicos = { scraper: () => null, reiniciarScraper: null };

// App ID e chave: da tela de configuração (SQLite) ou do .env. O app do plugin
// hn-anuncio-ml NÃO entra aqui sozinho: a tela pré-preenche com ele e o aluno confirma em
// "Salvar e validar" — assim a chave passa pela validação no ML antes de valer.
function credenciais() {
  const id = D.configLer('ml_client_id'), seg = D.configLer('ml_client_secret');
  if (id && seg) return { clientId: id, clientSecret: seg, origem: 'painel' };
  if (process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET) {
    return { clientId: process.env.ML_CLIENT_ID, clientSecret: process.env.ML_CLIENT_SECRET, origem: 'env' };
  }
  return { clientId: '', clientSecret: '', origem: null };
}
// Para onde o ML devolve o login. Precisa estar em "URIs de redirect" no DevCenter.
const redirectUri = () => process.env.ML_REDIRECT_URI || APP.appDoPlugin()?.redirect || APP.REDIRECT_PADRAO;

// O painel só atende quem está NESTE computador. Host fora da lista barra DNS rebinding;
// Origin fora da lista barra um site aberto no navegador que tente postar em localhost.
// É isto, e não uma senha, que protege o painel: ele não existe fora deste computador.
const HOST_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function pedidoLocal(req) {
  if (!HOST_LOCAL.test(req.headers.host || '')) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origem = req.headers.origin;
  if (!origem) return true; // navegador sempre manda Origin em POST; sem ele é script local
  // "null" vem de iframe sandbox (ataque) e também de política de privacidade do próprio
  // navegador. Sec-Fetch-Site é escrito pelo navegador, não pela página: desempata.
  if (origem === 'null') return ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
  try { return HOST_LOCAL.test(new URL(origem).host); } catch { return false; }
}

// ---------- tokens ----------
async function renovar(conta) {
  const { clientId, clientSecret } = credenciais();
  if (!clientId || !clientSecret || !conta.refresh_token) return conta;
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: conta.refresh_token,
    }),
  });
  const t = await r.json();
  if (!r.ok) {
    throw Object.assign(new Error(`Não foi possível renovar o acesso de ${conta.nickname}. `
      + `Reconecte a conta. (${t.error || r.status})`), { status: 401 });
  }
  D.contaTokensAtualizar(conta.ml_user_id, t);
  return D.contaObter(conta.ml_user_id);
}

// A ML nao tem um campo fixo para a mensagem util: as vezes vem em "message",
// as vezes em "error", as vezes so dentro de cause[]. E um dos dois costuma ser
// um codigo (BODY_INVALID_FIELDS) que nao ajuda ninguem. Pegamos a mais descritiva.
function mensagemDoML(json, fallback) {
  // Tabela de medidas (e outras APIs de catálogo) põem o motivo em errors[], não em cause[]:
  // sem isto o aluno via só "Chart validation errors found".
  const detalhes = (Array.isArray(json?.errors) ? json.errors : []).map((e) => e?.message).filter(Boolean);
  if (detalhes.length) return detalhes.join(' · ');
  const candidatos = [json?.error, json?.message,
    ...(Array.isArray(json?.cause) ? json.cause.map((c) => c?.message) : [])]
    .filter((t) => typeof t === 'string' && t.trim());
  const humanas = candidatos.filter((t) => !/^[A-Z][A-Z0-9_]+$/.test(t.trim()));
  return (humanas.sort((a, b) => b.length - a.length)[0]) || candidatos[0] || fallback;
}

async function ml(pathname, opts = {}, contaId = null) {
  let conta = contaId ? D.contaObter(contaId) : D.contaAtiva();
  if (!conta) throw Object.assign(new Error(SEM_CONTA), { status: 401 });
  if (Date.now() > conta.expires_at) conta = await renovar(conta);

  const isForm = opts.body instanceof FormData; // multipart: o fetch monta o boundary
  const call = (c) => fetch(API + pathname, {
    ...opts,
    headers: {
      Authorization: `Bearer ${c.access_token}`,
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });

  let res = await call(conta);
  if (res.status === 401) { conta = await renovar(conta); res = await call(conta); }
  const body = await res.text();
  const json = body ? JSON.parse(body) : null;
  if (!res.ok) throw Object.assign(new Error(mensagemDoML(json, res.statusText)), { status: res.status, body: json });
  return json;
}

// Cliente do scraper local. Ele escuta em 127.0.0.1 e dirige um navegador com a
// sessão logada do vendedor: NUNCA exponha essa porta para fora deste computador.
// A porta é escolhida pelo iniciar.js na hora de subir (a primeira livre a partir de 8100).
const SCRAPER = () => servicos.scraper()?.url || process.env.SCRAPER_URL || 'http://127.0.0.1:8100';
const scraperFora = () => {
  const s = servicos.scraper();
  const detalhe = s?.estado === 'iniciando' || s?.estado === 'reiniciando'
    ? 'Ele está subindo agora; tente de novo em alguns segundos.'
    : s?.erro ? `Motivo: ${s.erro}. Veja a tela Configurações do painel.`
      : 'Suba o painel com "npm start": ele sobe o scraper junto.';
  return Object.assign(new Error(`O scraper não respondeu em ${SCRAPER()}. ${detalhe}`), { status: 503 });
};
async function scraper(pathname, ms = 120000, opts = {}) {
  let r;
  try {
    r = await fetch(SCRAPER() + pathname, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    // demorar não é estar fora do ar: o scraper está de pé, só lento (Mac sobrecarregado)
    if (e.name === 'TimeoutError') {
      throw Object.assign(new Error(`O scraper não terminou em ${Math.round(ms / 1000)} s. `
        + 'Costuma ser o computador sobrecarregado; tente de novo.'), { status: 504 });
    }
    throw scraperFora();
  }
  const j = await r.json().catch(() => ({ detail: `o scraper respondeu ${r.status} sem JSON` }));
  if (!r.ok) {
    const d = j.detail || {};
    const msg = Array.isArray(d) ? 'pedido inválido para o scraper' : (d.erro || d.acao || j.detail);
    throw Object.assign(new Error(msg || 'o scraper recusou'),
      { status: r.status, body: { cause: d } });
  }
  return j;
}
const scraperPost = (pathname, body, ms) => scraper(pathname, ms, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

// Só os campos que o scraper conhece passam; ele valida tipo e faixa de novo.
function acaoNavegador(b) {
  const out = { tipo: String(b.tipo || '') };
  if (b.x != null) out.x = Number(b.x);
  if (b.y != null) out.y = Number(b.y);
  if (b.dy != null) out.dy = Math.trunc(Number(b.dy));
  if (b.texto != null) out.texto = String(b.texto);
  if (b.tecla != null) out.tecla = String(b.tecla);
  return out;
}

// Estado da sessão do scraper, lembrado por 10 min. O /status do scraper abre uma listagem
// no ML: chamar a cada abertura da análise segurava o navegador por 5–10 s (atrasando o
// "Medir agora") e somava acessos que aumentam o risco de reCAPTCHA. As próprias medições
// e o desbloqueio atualizam o valor, então ele raramente fica velho.
const SESSAO_VALIDADE_MS = 10 * 60 * 1000;
let sessaoScraper = null;
const lembrarSessao = (sessao, acao = null) => { sessaoScraper = { sessao, acao, em: Date.now() }; };

// Marca, na lista INTEIRA da busca, o que é do próprio vendedor. O JSON da listagem não diz
// de quem é cada anúncio; a API responde 200 com seller_id para anúncio do vendedor e 403
// para o de outros (medido), então um multiget em lotes de 20 separa os dois.
// seu = null e meus = null quando não deu para checar.
async function classificarBusca(conta, itemId, resultados, posicaoEu) {
  const ids = [...new Set(resultados.map((r) => r.item_id))].filter((x) => x !== itemId);
  const lotes = [];
  for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
  let meusIds = null;
  try {
    const respostas = await Promise.all(lotes.map((l) =>
      ml(`/items?ids=${l.join(',')}&attributes=id,seller_id`, {}, conta.ml_user_id)));
    meusIds = new Set(respostas.flat()
      .filter((r) => r.code === 200 && Number(r.body?.seller_id) === Number(conta.ml_user_id))
      .map((r) => r.body.id));
  } catch (e) {
    console.warn('[posicao] não deu para checar os anúncios do vendedor:', e.message);
  }
  const lista = resultados.map((r) => ({
    ...r, seu: r.item_id === itemId ? true : (meusIds ? meusIds.has(r.item_id) : null),
  }));
  // o próprio anúncio medido entra quando aparece de novo em outra casa (pago e orgânico)
  const meus = meusIds && lista.filter((r) => r.seu && !(r.item_id === itemId && r.posicao === posicaoEu))
    .map(({ item_id, posicao, tipo, preco, preco_original, vendidos }) =>
      ({ item_id, posicao, tipo, preco, preco_original, vendidos }));
  return { lista, meus };
}

// Opções de garantia. Não há endpoint que liste: /sites/MLB/sale_terms dá 404 e
// /categories/{id}/sale_terms dá 403. Os ids abaixo foram lidos dos anúncios reais
// da conta. O valor que o anúncio já tem é unido a esta lista, então um termo novo
// do ML aparece mesmo sem estar aqui.
const GARANTIA_TIPOS = [
  { id: '2230280', nome: 'Garantia do vendedor' },
  { id: '2230279', nome: 'Garantia de fábrica' },
  { id: '6150835', nome: 'Sem garantia' },
];
const GARANTIA_UNIDADES = ['dias', 'meses', 'anos'];

function termosDoItem(item) {
  const tem = Object.fromEntries((item.sale_terms || []).map((t) => [t.id, t]));
  const tipos = [...GARANTIA_TIPOS];
  const atual = tem.WARRANTY_TYPE;
  if (atual?.value_name && !tipos.some((t) => t.nome === atual.value_name)) {
    tipos.unshift({ id: atual.value_id, nome: atual.value_name });
  }
  return [
    { id: 'WARRANTY_TYPE', name: 'Tipo de garantia', value_type: 'list',
      valor: atual?.value_name || '', values: tipos.map((t) => t.nome) },
    { id: 'WARRANTY_TIME', name: 'Tempo de garantia', value_type: 'number_unit',
      valor: tem.WARRANTY_TIME?.value_name || '', unidades: GARANTIA_UNIDADES,
      unidade_padrao: 'meses' },
  ];
}

const contaOuErro = () => {
  const c = D.contaAtiva();
  if (!c) throw Object.assign(new Error(SEM_CONTA), { status: 401 });
  return c;
};
const siteAtivo = () => D.contaAtiva()?.site_id || SITE_PADRAO;
const ITEM_ID = /^[A-Z]{3}\d+$/;
const exigeItemId = (id) => {
  if (!ITEM_ID.test(id || '')) throw Object.assign(new Error('id de anúncio inválido'), { status: 400 });
  return id;
};

// ---------- montagem do payload (lógica testável) ----------
// Conta no modelo "User Products" (tag user_product_seller): o ML EXIGE family_name e RECUSA
// title — o título do anúncio ele monta a partir do family_name. Medido em 19/09/2026 com
// POST /items/validate: só title -> "does not contains [family_name]"; title + family_name ->
// "The fields [title] are invalid". Nas outras contas continua sendo title.
function buildItem(form, { userProduct = false } = {}) {
  const errs = [];
  const title = String(form.title || '').trim();
  const price = Number(form.price);
  const quantity = Number(form.quantity);

  if (!title) errs.push('Título é obrigatório.');
  if (title.length > 60) errs.push('Título passa de 60 caracteres.');
  if (!form.category_id) errs.push('Categoria é obrigatória.');
  if (!Number.isFinite(price) || price <= 0) errs.push('Preço deve ser maior que zero.');
  if (!Number.isInteger(quantity) || quantity < 1) errs.push('Quantidade deve ser um inteiro ≥ 1.');

  const ids = (Array.isArray(form.picture_ids) ? form.picture_ids : [])
    .map((x) => String(x).trim()).filter(Boolean);
  const urls = String(form.pictures || '')
    .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const ruim = urls.find((u) => !/^https:\/\//i.test(u));
  if (ruim) errs.push(`Foto precisa ser URL https: "${ruim}"`);
  const pictures = [...ids.map((id) => ({ id })), ...urls.map((source) => ({ source }))];

  const attributes = Object.entries(form.attributes || {})
    .filter(([, v]) => String(v ?? '').trim() !== '')
    .map(([id, value_name]) => ({ id, value_name: String(value_name).trim() }));

  if (errs.length) throw Object.assign(new Error(errs.join(' ')), { status: 400, errors: errs });

  return {
    ...(userProduct ? { family_name: title } : { title }),
    category_id: form.category_id, price,
    currency_id: form.currency_id || 'BRL',
    available_quantity: quantity,
    buying_mode: 'buy_it_now',
    condition: form.condition || 'new',
    listing_type_id: form.listing_type_id || 'gold_special',
    pictures, attributes,
    shipping: {
      mode: form.shipping_mode || 'me2',
      local_pick_up: !!form.local_pick_up,
      free_shipping: !!form.free_shipping,
    },
  };
}

// Campos que a API do ML aceita num PUT /items — LISTA FECHADA, medida contra a API real
// (ver README). Fora daqui o PUT aceita coisa que quebra o anúncio em silêncio.
// price e available_quantity só passam com o anúncio ATIVO; listing_type_id nunca passa
// por aqui (tem endpoint próprio, /items/{id}/listing_type).
function buildEdicao(form) {
  const out = {};
  const errs = [];
  const texto = (v, max, nome, campo) => {
    const t = String(v).trim();
    if (!t) { errs.push(`${nome} não pode ficar vazio.`); return; }
    if (t.length > max) { errs.push(`${nome} passa de ${max} caracteres.`); return; }
    out[campo] = t;
  };

  if (form.title !== undefined) texto(form.title, 60, 'Título', 'title');
  if (form.warranty !== undefined) texto(form.warranty, 255, 'Garantia', 'warranty');
  if (form.seller_custom_field !== undefined) {
    const t = String(form.seller_custom_field).trim();
    if (t.length > 60) errs.push('SKU passa de 60 caracteres.');
    else out.seller_custom_field = t || null; // vazio limpa o campo
  }

  if (form.price !== undefined) {
    const p = Number(form.price);
    if (!Number.isFinite(p) || p <= 0) errs.push('Preço deve ser maior que zero.');
    else out.price = p;
  }
  if (form.available_quantity !== undefined) {
    const q = Number(form.available_quantity);
    if (!Number.isInteger(q) || q < 0) errs.push('Estoque deve ser inteiro ≥ 0.');
    else out.available_quantity = q;
  }
  if (form.status !== undefined) {
    if (!['active', 'paused', 'closed'].includes(form.status)) errs.push('Status inválido.');
    else out.status = form.status;
  }
  if (form.condition !== undefined) {
    if (!['new', 'used', 'not_specified'].includes(form.condition)) errs.push('Condição inválida.');
    else out.condition = form.condition;
  }
  if (form.category_id !== undefined) {
    if (!/^[A-Z]{3}\d+$/.test(String(form.category_id))) errs.push('Categoria inválida.');
    else out.category_id = String(form.category_id);
  }
  if (form.video_id !== undefined) {
    const v = String(form.video_id || '').trim();
    out.video_id = v || null; // vazio remove o vídeo
  }
  if (Array.isArray(form.picture_ids)) {
    const ids = form.picture_ids.map((x) => String(x).trim()).filter(Boolean);
    if (!ids.length) errs.push('O anúncio precisa de ao menos uma foto.');
    else out.pictures = ids.map((id) => ({ id })); // a ordem aqui é a ordem no anúncio
  }
  if (form.attributes && typeof form.attributes === 'object') {
    const attrs = Object.entries(form.attributes)
      .filter(([, v]) => String(v ?? '').trim() !== '')
      .map(([id, value_name]) => ({ id, value_name: String(value_name).trim() }));
    if (attrs.length) out.attributes = attrs;
  }
  // sale_terms: garantia e condições de venda. Medido: o PUT aceita.
  if (form.sale_terms && typeof form.sale_terms === 'object') {
    const termos = Object.entries(form.sale_terms)
      .filter(([, v]) => String(v ?? '').trim() !== '')
      .map(([id, value_name]) => ({ id, value_name: String(value_name).trim() }));
    if (termos.length) out.sale_terms = termos;
  }
  if (form.shipping && typeof form.shipping === 'object') {
    const modo = form.shipping.mode;
    if (modo && !['me2', 'not_specified', 'custom'].includes(modo)) errs.push('Modo de envio inválido.');
    else {
      out.shipping = {
        ...(modo ? { mode: modo } : {}),
        free_shipping: !!form.shipping.free_shipping,
        local_pick_up: !!form.shipping.local_pick_up,
      };
    }
  }

  if (errs.length) throw Object.assign(new Error(errs.join(' ')), { status: 400, errors: errs });
  if (!Object.keys(out).length) throw Object.assign(new Error('Nada para alterar.'), { status: 400 });
  return out;
}

// ---------- configuração: app do DevCenter x URI de redirect ----------
// O que o ML tem cadastrado, lido com as credenciais do app. Cache curto: a tela de
// configuração e o aviso de todas as páginas perguntam o tempo todo.
const CACHE_APP_MS = 60000;
let cacheApp = { chave: null, em: 0, app: null, erro: null, codigo: null };

async function appDoML(forcar = false) {
  const { clientId, clientSecret } = credenciais();
  if (!clientId || !clientSecret) return { app: null, erro: null, codigo: null };
  const chave = crypto.createHash('sha256').update(clientId + '\0' + clientSecret).digest('hex');
  if (!forcar && cacheApp.chave === chave && Date.now() - cacheApp.em < CACHE_APP_MS) return cacheApp;
  try {
    cacheApp = { chave, em: Date.now(), app: await APP.lerApp(clientId, clientSecret), erro: null, codigo: null };
  } catch (e) {
    cacheApp = { chave, em: Date.now(), app: null, erro: e.message, codigo: e.codigo || null };
  }
  return cacheApp;
}

async function situacaoAtual(forcar = false) {
  const { app, erro, codigo } = await appDoML(forcar);
  return { ...APP.situacao({ redirect: redirectUri(), app }), erro_ml: erro, codigo_ml: codigo };
}

// Resumo que toda página consulta para decidir se mostra o aviso do topo. URI não
// verificada (app sem Client Credentials, ML fora do ar) não vira aviso: o login testa.
async function resumoConfig(forcar = false) {
  const { clientId, clientSecret, origem } = credenciais();
  const situacao = await situacaoAtual(forcar);
  const contas = D.contasListar().length;
  // Chave trocada no DevCenter (ou a do plugin desatualizada): o ML recusa o par inteiro.
  const invalidas = situacao.codigo_ml === 'invalid_client';
  let pendente = null;
  if (!clientId || !clientSecret || invalidas) pendente = 'credenciais';
  else if (situacao.estado === 'divergente') pendente = 'url';
  else if (!contas) pendente = 'conta';
  return { pendente, situacao, contas, tem_credenciais: !!(clientId && clientSecret) && !invalidas, credenciais_invalidas: invalidas, origem_credenciais: origem };
}

// Login em andamento: /auth abre o ML numa aba, o aluno cola o code de volta no painel.
// Um por vez (um aluno, um computador) — abrir de novo substitui. Validade de 15 minutos.
let loginPendente = null;
const VALIDADE_LOGIN_MS = 15 * 60 * 1000;

// Troca o code colado pelo token. state vem junto quando o aluno cola o endereço inteiro;
// colando só o code, vale o login pendente (é o único, e expira em 15 minutos).
async function conectarComCodigo(texto) {
  const { code, state } = APP.lerCodigoColado(texto);
  if (!code) throw erro400('Cole o endereço que apareceu depois de autorizar (começa com https://) ou só o code (TG-…).');
  const p = loginPendente;
  if (!p || Date.now() - p.criado > VALIDADE_LOGIN_MS) {
    throw erro400('Esse login expirou ou não começou por este painel. Clique em "Conectar conta" de novo.');
  }
  if (state && state !== p.state) {
    throw erro400('Esse endereço é de um login anterior. Use o da última vez que clicou em "Conectar conta".');
  }
  const { clientId, clientSecret } = credenciais();
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code,
      redirect_uri: p.redirect, code_verifier: p.verifier, // os MESMOS enviados no /auth
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw erro400(`O Mercado Livre recusou o código (${t.error || r.status}${t.message ? `: ${t.message}` : ''}). `
      + 'O code vale poucos minutos e uma vez só: clique em "Conectar conta" de novo.');
  }
  loginPendente = null;
  // é a ML que diz de quem é o token — é isso que separa as contas
  const meRes = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  const me = await meRes.json().catch(() => ({}));
  if (!meRes.ok) throw Object.assign(new Error(`Token obtido, mas /users/me falhou (${meRes.status}).`), { status: 502 });
  D.contaSalvar(t, me); // grava só id, nickname e site — nada de CPF, e-mail ou endereço
  D.contaAtivaDefinir(me.id);
  return { ok: true, nickname: me.nickname, ...(await resumoConfig(true)) };
}

// ---------- recusa por falta de campo ----------
// Cada categoria do ML tem regras próprias (código de barras, tabela de medidas…). Em vez de
// mostrar o erro em inglês, diz QUAIS campos faltam, com o nome em português, e devolve os
// ids para a tela acrescentá-los à ficha técnica. Vale para qualquer categoria.
async function explicarRecusa(e, categoria, payload = null) {
  const causas = (Array.isArray(e.body?.cause) ? e.body.cause : []).filter((c) => c?.type !== 'warning');
  const ids = new Set();
  for (const c of causas) {
    if (!/missing|required/i.test(c.code || '')) continue;
    for (const [, grupo] of String(c.message || '').matchAll(/\[([A-Z0-9_,\s]+)\]/g)) {
      for (const id of grupo.split(',').map((x) => x.trim())) if (/^[A-Z][A-Z0-9_]+$/.test(id) && !/^[A-Z]{3}\d+$/.test(id)) ids.add(id);
    }
  }
  if (!ids.size) return e;
  const attrs = await fetch(`${API}/categories/${categoria}/attributes`).then((r) => r.json()).catch(() => []);
  const nome = (id) => (Array.isArray(attrs) && attrs.find((a) => a.id === id)?.name) || id;
  const lista = [...ids];
  // Medido em 19/09/2026 (MLB1714): com marca (Logitech, qualquer modelo) o ML recusa TODOS os
  // motivos de "sem código"; com a marca Genérica, aceita. O motivo não substitui o código real.
  const mandouMotivo = (payload?.attributes || []).some((a) => a.id === 'EMPTY_GTIN_REASON');
  if (ids.has('GTIN') && mandouMotivo) {
    return Object.assign(new Error('para este produto o Mercado Livre exige o código de barras real. Com marca '
      + '(como Logitech), ele não aceita o motivo "não tem código": isso vale para produto genérico, artesanal ou kit. '
      + 'O código fica na embalagem, embaixo das barras (quase sempre 13 dígitos). Desmarque "não tem código" e digite-o.'),
    { status: 400, body: e.body, faltando: ['GTIN'] });
  }
  const msg = `o Mercado Livre exige ${lista.length > 1 ? 'estes campos' : 'este campo'} nesta categoria: `
    + lista.map((id) => (id === 'GTIN' ? 'Código de barras (GTIN/EAN)' : nome(id))).join(', ')
    + '. Foi acrescentado à ficha técnica, em destaque: preencha e publique de novo.';
  return Object.assign(new Error(msg), { status: 400, body: e.body, faltando: lista });
}

// ---------- tabela de medidas (roupas e calçados) ----------
// Categorias de moda exigem SIZE_GRID_ID (a tabela) e SIZE_GRID_ROW_ID (a linha do tamanho).
// Medido em 19/09/2026 (camiseta masculina, MLB31447 / domínio MLB-T_SHIRTS):
//   - a busca de tabelas EXIGE Marca e Gênero, e devolve as tabelas da própria conta;
//     não havia tabela pronta para nenhuma marca testada, então o vendedor cria a sua;
//   - o que cada linha exige vem de POST /domains/{dom}/technical_specs?section=grids
//     (com Marca e Gênero): SIZE (main_attribute_candidate) + CHEST_CIRCUMFERENCE_FROM
//     (BODY_MEASURE, required). Tabela criada vale na hora e só se apaga se não estiver em uso.
async function contextoGrade(q) {
  const categoria = String(q.categoria || '');
  if (!ITEM_ID.test(categoria)) throw erro400('Categoria inválida.');
  const [cat, attrs] = await Promise.all([
    fetch(`${API}/categories/${categoria}`).then((r) => r.json()),
    fetch(`${API}/categories/${categoria}/attributes`).then((r) => r.json()),
  ]);
  const dominio = cat.settings?.catalog_domain;
  if (!dominio || !attrs.some((a) => a.id === 'SIZE_GRID_ID')) throw erro400('Esta categoria não usa tabela de medidas.');
  const acha = (id, nome) => (attrs.find((a) => a.id === id)?.values || []).find((v) => v.name === nome);
  const genero = acha('GENDER', q.genero);
  if (!genero) throw erro400('Escolha o Gênero na ficha técnica primeiro.');
  const marcaNome = String(q.marca || '').trim();
  if (!marcaNome) throw erro400('Escolha a Marca na ficha técnica primeiro.');
  const marca = acha('BRAND', marcaNome) || { name: marcaNome };
  const site = dominio.slice(0, 3);
  return { dominio, domainId: dominio.slice(4), site, genero, marca };
}

// O que a tabela exige em cada linha: o tamanho (atributo principal) e as medidas obrigatórias.
async function fichaGrade(ctx) {
  const attr = (id, v) => ({ id, value_id: v.id || null, value_name: v.name, values: [{ id: v.id || null, name: v.name }] });
  const f = await ml(`/domains/${ctx.dominio}/technical_specs?section=grids`, {
    method: 'POST', body: JSON.stringify({ attributes: [attr('BRAND', ctx.marca), attr('GENDER', ctx.genero)] }),
  });
  const todos = [];
  const visitar = (o) => {
    if (Array.isArray(o)) return o.forEach(visitar);
    if (!o || typeof o !== 'object') return;
    if (o.component && Array.isArray(o.attributes)) todos.push(...o.attributes);
    Object.values(o).forEach(visitar);
  };
  visitar(f.input);
  const tem = (a, t) => (a.tags || []).includes(t);
  const principal = todos.find((a) => a.id === 'SIZE' && tem(a, 'main_attribute_candidate'))
    || todos.find((a) => tem(a, 'main_attribute_candidate'));
  if (!principal) throw Object.assign(new Error('O ML não informou o campo de tamanho desta tabela.'), { status: 502 });
  const base = (a) => tem(a, 'required') && a.id !== principal.id && !tem(a, 'grid_filter');
  // Medidas corporais (padrão da tabela) obrigatórias; as medidas da peça ficam de fora.
  const medidas = todos.filter((a) => base(a) && a.value_type === 'number_unit' && !tem(a, 'CLOTHING_MEASURE'))
    .map((a) => ({ id: a.id, nome: a.name, unidade: a.default_unit_id
      || (a.units || a.allowed_units || []).map((u) => u.id || u.name).find(Boolean) || 'cm' }));
  // Listas obrigatórias por linha. A ficha marca FILTRABLE_SIZE como oculto, mas o POST
  // recusa a linha sem ele (medido): é a equivalência padrão (P, M, G…) usada nos filtros.
  const listas = todos.filter((a) => base(a) && a.value_type === 'list' && (a.values || []).length)
    .map((a) => ({ id: a.id, nome: a.id === 'FILTRABLE_SIZE' ? 'Equivalência' : a.name,
      valores: a.values.map((v) => ({ id: String(v.id), nome: v.name })) }));
  return { principal: { id: principal.id, nome: principal.name }, medidas, listas };
}

function tabelaSimples(ch, site) {
  const valor = (row, id) => (row.attributes || []).find((a) => a.id === id)?.values?.[0]?.name || '';
  const principal = ch.main_attribute_id || 'SIZE';
  return {
    id: String(ch.id), tipo: ch.type || null,
    nome: ch.names?.[site] || Object.values(ch.names || {})[0] || `Tabela ${ch.id}`,
    linhas: (ch.rows || []).map((r) => ({ id: String(r.id), tamanho: valor(r, 'SIZE') || valor(r, principal) })),
  };
}

// ---------- vendas do período (cópia local dos pedidos) ----------
// Medido em 19/09/2026 numa conta com 11 mil pedidos em 150 dias:
//   - /orders/search aceita limit até 51 e recusa offset+limit acima de 10000 (400):
//     janela com mais pedidos que isso é fatiada ao meio por data;
//   - order_items[].sale_fee é a tarifa POR UNIDADE (3 un. a R$ 31,47 -> sale_fee 3,62,
//     o mesmo que /listing_prices dá para uma unidade).
// A primeira abertura de uma janela baixa os pedidos dela; depois, só o que mudou desde a
// última vez (order.date_last_updated.from), o que também pega cancelamento de venda antiga.
const POR_PAGINA = 51, TETO_OFFSET = 10000;
const isoML = (d) => new Date(d).toISOString().replace('Z', '-00:00');
const SYNC_FRESCO_MS = 60e3;

async function emLotes(lista, simultaneos, fn) {
  const out = new Array(lista.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(simultaneos, lista.length) }, async () => {
    while (i < lista.length) { const k = i++; out[k] = await fn(lista[k], k); }
  }));
  return out;
}

// 429 em rajada de páginas: espera um pouco e tenta de novo, em vez de perder a sincronização.
async function mlPaciente(caminho, contaId) {
  for (let tentativa = 0; ; tentativa++) {
    try { return await ml(caminho, {}, contaId); }
    catch (e) {
      if (e.status !== 429 || tentativa >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 800 * (tentativa + 1)));
    }
  }
}

const linhasDoPedido = (o, contaId) => (o.order_items || []).filter((oi) => oi.item?.id).map((oi) => ({
  order_id: o.id, item_id: oi.item.id, variacao: oi.item.variation_id || 0, ml_user_id: contaId,
  data: new Date(o.date_created).toISOString(), status: o.status, quantidade: oi.quantity || 0,
  preco_unit: oi.unit_price ?? 0, tarifa_unit: oi.sale_fee ?? null, envio_id: o.shipping?.id ?? null,
}));

// Baixa os pedidos com `campo` (date_created ou date_last_updated) entre de e ate.
async function baixarPedidos(contaId, campo, de, ate) {
  const base = `/orders/search?seller=${contaId}&order.${campo}.from=${isoML(de)}`
    + `&order.${campo}.to=${isoML(ate)}&sort=date_asc&limit=${POR_PAGINA}`;
  const p1 = await mlPaciente(base, contaId);
  const total = p1.paging?.total ?? 0;
  if (total > TETO_OFFSET - 100 && ate - de > 3600e3) {
    const meio = new Date((de.getTime() + ate.getTime()) / 2);
    return (await baixarPedidos(contaId, campo, de, meio)).concat(await baixarPedidos(contaId, campo, meio, ate));
  }
  const offsets = [];
  for (let off = POR_PAGINA; off < total && off + POR_PAGINA <= TETO_OFFSET; off += POR_PAGINA) offsets.push(off);
  const paginas = await emLotes(offsets, 6, (off) => mlPaciente(`${base}&offset=${off}`, contaId));
  return [p1, ...paginas].flatMap((p) => p.results || []);
}

// Uma sincronização por vez em cada conta: duas abas abertas não baixam tudo em dobro.
const syncEmCurso = new Map();
function sincronizarVendas(conta, dias) {
  const id = conta.ml_user_id;
  const anterior = syncEmCurso.get(id) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(() => sincronizar(id, dias));
  syncEmCurso.set(id, atual);
  atual.finally(() => { if (syncEmCurso.get(id) === atual) syncEmCurso.delete(id); }).catch(() => {});
  return atual;
}

async function sincronizar(contaId, dias) {
  const chave = `vendas_sync:${contaId}`;
  let est = null;
  try { est = JSON.parse(D.configLer(chave) || 'null'); } catch {}
  const agora = new Date();
  const de = new Date(Date.parse(A.diasDaJanela(dias)[0] + 'T03:00:00.000Z')); // 00h do 1º dia, horário de Brasília
  let baixados = 0;
  const gravar = (pedidos) => {
    D.vendasGravar(pedidos.flatMap((o) => linhasDoPedido(o, contaId)));
    baixados += pedidos.length;
  };

  if (!est || !est.desde || !est.ate) {
    gravar(await baixarPedidos(contaId, 'date_created', de, agora));
    est = { desde: de.toISOString(), ate: agora.toISOString() };
  } else {
    if (de < new Date(est.desde)) {                       // janela maior que a já baixada
      gravar(await baixarPedidos(contaId, 'date_created', de, new Date(est.desde)));
      est.desde = de.toISOString();
    }
    if (agora - new Date(est.ate) > SYNC_FRESCO_MS) {     // o que mudou desde a última vez
      const desde = new Date(new Date(est.ate).getTime() - 5 * 60e3);
      gravar(await baixarPedidos(contaId, 'date_last_updated', desde, agora));
      est.ate = agora.toISOString();
    }
  }
  D.configGravar(chave, JSON.stringify(est));
  return { baixados, ate: est.ate };
}

// Janela do período em ISO (UTC), de dias completos: da 00h do primeiro dia até a 00h de
// hoje (exclusivo), no horário de Brasília. `meio` separa as metades da tendência.
function janela(dias) {
  const d = A.diasDaJanela(dias);
  const de = new Date(Date.parse(d[0] + 'T03:00:00.000Z'));
  const ate = new Date(de.getTime() + dias * 864e5);
  const meio = new Date(de.getTime() + (dias / 2) * 864e5);
  return { dias, de: de.toISOString(), meio: meio.toISOString(), ate: ate.toISOString(),
    primeiro: d[0], ultimo: d.at(-1) };
}

// Frete pago pelo vendedor, por unidade vendida. Medido em 19/09/2026: a estimativa do ML
// (/users/{id}/shipping_options/free) deu R$ 8,25 e o cobrado de verdade
// (/shipments/{id}/costs, senders[].cost) foi R$ 6,95 — e o vendedor pagou frete num
// anúncio de R$ 49,90 SEM frete grátis. Por isso o lucro usa o cobrado nos envios
// reais; a estimativa (de um envio de 1 unidade) só entra quando o anúncio não vendeu.
// Teto de envios medidos por anúncio na janela: com ele a listagem e a análise calculam
// sobre a MESMA amostra (sem o teto, cada abertura media mais envios e o lucro das duas
// telas diferia por alguns reais) e as chamadas ao ML param de crescer.
const META_FRETE = 20;
async function freteDoItem(conta, item, j, amostra) {
  const ja = D.fretePorUnidade(item.id, j)?.amostra || 0;
  const faltam = D.enviosSemFrete(item.id, j, Math.max(0, Math.min(amostra, META_FRETE - ja)));
  await emLotes(faltam, 4, async (envio) => {
    const c = await ml(`/shipments/${envio}/costs`, {}, conta.ml_user_id).catch(() => null);
    const s = (c?.senders || []).find((x) => Number(x.user_id) === Number(conta.ml_user_id));
    if (s && Number.isFinite(s.cost)) D.freteGravar(conta.ml_user_id, envio, s.cost);
  });
  const m = D.fretePorUnidade(item.id, j);
  if (m?.amostra && m.unidades > 0) return { por_unidade: m.custo / m.unidades, fonte: 'real', amostra: m.amostra };
  if (item.shipping && item.shipping.mode !== 'me2') return { por_unidade: 0, fonte: 'sem_mercado_envios', amostra: 0 };
  if (!item.shipping || item.status !== 'active') return null;   // o ML só estima anúncio ativo
  const est = await ml(`/users/${conta.ml_user_id}/shipping_options/free?item_id=${item.id}`
    + `&free_shipping=${!!item.shipping.free_shipping}&verbose=true`, {}, conta.ml_user_id).catch(() => null);
  const custo = est?.coverage?.all_country?.list_cost;
  return Number.isFinite(custo) ? { por_unidade: custo, fonte: 'estimativa', amostra: 0 } : null;
}

// Todos os anúncios da conta que passam no filtro, para ordenar pelo período.
// O /items/search para em offset 1000; acima disso a ordenação considera os 1000 mais recentes.
const idsCache = new Map();
async function idsDaConta(conta, status, q) {
  const chave = `${conta.ml_user_id}|${status || ''}|${q || ''}`;
  const c = idsCache.get(chave);
  if (c && Date.now() - c.em < 60e3) return c;
  const qs = new URLSearchParams({ limit: '100', orders: 'last_updated_desc' });
  if (status) qs.set('status', status);
  if (q) qs.set('q', q);
  const base = `/users/${conta.ml_user_id}/items/search?${qs}`;
  const p1 = await ml(`${base}&offset=0`);
  const total = p1.paging?.total ?? 0;
  const offsets = [];
  for (let off = 100; off < Math.min(total, 1000); off += 100) offsets.push(off);
  const resto = await emLotes(offsets, 4, (off) => ml(`${base}&offset=${off}`));
  const ids = [...new Set([p1, ...resto].flatMap((p) => p.results || []))];
  const r = { ids, total, cortado: total > ids.length, em: Date.now() };
  idsCache.set(chave, r);
  return r;
}

const ORDENS_PERIODO = ['vendas_desc', 'vendas_asc', 'abc', 'queda'];

// ---------- rotas de caminho fixo ----------
const ATRIBUTOS_LISTA = ['id', 'title', 'price', 'available_quantity', 'sold_quantity', 'status',
  'sub_status', 'secure_thumbnail', 'thumbnail', 'permalink', 'listing_type_id', 'health',
  'category_id', 'date_created', 'shipping', 'family_name', 'variations'].join(',');

const erro400 = (msg) => Object.assign(new Error(msg), { status: 400 });

const routes = {
  'GET /api/status': async () => {
    const c = contaOuErro();
    return { nickname: c.nickname, id: c.ml_user_id, site_id: c.site_id };
  },

  // ----- configuração (primeiro acesso) -----
  'GET /api/config': async (url) => {
    const r = await resumoConfig(url.searchParams.get('forcar') === '1');
    const { app } = await appDoML();
    const plugin = APP.appDoPlugin();
    const aqui = new Set(D.contasListar().map((c) => Number(c.ml_user_id)));
    return {
      ...r,
      app_id: credenciais().clientId || null,
      redirect: redirectUri(),
      app: app ? { nome: app.nome, fluxos: app.fluxos, use_pkce: app.use_pkce, bloqueado: app.bloqueado } : null,
      // App e contas do plugin, para a tela pré-preencher e sugerir. Sem a chave: esta rota
      // é a ml_config do MCP, e a chave não pode ir parar no chat.
      plugin: plugin ? { app_id: plugin.clientId, contas: plugin.contas.map((c) => ({ ...c, conectada: aqui.has(c.id) })) } : null,
      // Para a tela ensinar a ligar o Claude Code: a pasta onde abrir e se a escrita está
      // ligada. Caminho local não é segredo — e o painel só existe neste computador.
      mcp: { pasta: __dirname, escrita: process.env.ML_MCP_ESCRITA !== '0' },
      scraper: servicos.scraper(),
      scraper_gerenciado: !!servicos.reiniciarScraper,
    };
  },

  'GET /api/config/resumo': async () => ({ pendente: (await resumoConfig()).pendente }),

  // Só a tela de Configuração usa, para pré-preencher o passo 2. Fica FORA da tabela do
  // MCP de propósito (é a única rota que devolve uma chave secreta). Outro site não lê a
  // resposta: o painel não manda CORS e recusa Host que não seja local.
  'GET /api/config/app-do-plugin': async () => {
    const p = APP.appDoPlugin();
    return p ? { app_id: p.clientId, secret: p.clientSecret } : null;
  },

  // O aluno colou o endereço (ou o code) que o ML mostrou depois do login.
  'POST /api/config/conectar': async (_u, body) => conectarComCodigo(body.texto),

  // Valida no ML ANTES de gravar: App ID e chave trocados são o erro nº 1 da aula.
  'POST /api/config/credenciais': async (_u, body) => {
    const appId = String(body.app_id || '').trim();
    const secret = String(body.secret || '').trim();
    if (!/^\d{4,25}$/.test(appId)) throw erro400('O App ID tem só números. Copie de novo do DevCenter.');
    if (secret.length < 16 || secret.length > 128 || /\s/.test(secret)) {
      throw erro400('A chave secreta não parece certa. Copie de novo do DevCenter, sem espaços.');
    }
    const avisos = [];
    try {
      await APP.tokenDoApp(appId, secret);
    } catch (e) {
      if (e.codigo === 'unauthorized_client') avisos.push(e.message);
      else if (!e.codigo) avisos.push(`Não deu para validar com o Mercado Livre agora (${e.message}). Guardei assim mesmo.`);
      else throw erro400(e.message);
    }
    const anterior = credenciais().clientId;
    if (anterior && anterior !== appId && D.contasListar().length) {
      avisos.push('As contas conectadas com o aplicativo anterior vão precisar ser conectadas de novo.');
    }
    D.configGravar('ml_client_id', appId);
    D.configGravar('ml_client_secret', secret);
    return { ok: true, avisos, ...(await resumoConfig(true)) };
  },

  'POST /api/scraper/reiniciar': async () => {
    if (!servicos.reiniciarScraper) {
      throw Object.assign(new Error('O scraper não foi iniciado por este painel. Suba tudo com "npm start".'), { status: 409 });
    }
    servicos.reiniciarScraper();
    return servicos.scraper();
  },
  'GET /api/accounts': async () => ({
    ativa: D.contaAtivaId() ? Number(D.contaAtivaId()) : null,
    contas: D.contasListar(),
  }),
  'POST /api/accounts/active': async (_u, body) => {
    const id = Number(body.ml_user_id);
    if (!Number.isInteger(id)) throw Object.assign(new Error('ml_user_id inválido'), { status: 400 });
    D.contaAtivaDefinir(id);
    const c = D.contaObter(id);
    return { ativa: id, nickname: c.nickname, site_id: c.site_id };
  },
  'POST /api/accounts/remove': async (_u, body) => {
    const id = Number(body.ml_user_id);
    if (!Number.isInteger(id)) throw Object.assign(new Error('ml_user_id inválido'), { status: 400 });
    D.contaRemover(id); // só esquece o token aqui; a permissão segue viva no ML
    return { removida: id, ativa: D.contaAtivaId() ? Number(D.contaAtivaId()) : null };
  },

  // ----- listagem -----
  'GET /api/items': async (url) => {
    const conta = contaOuErro();
    const limite = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const dias = A.diasValidos(url.searchParams.get('dias'));
    const qs = new URLSearchParams({ limit: String(limite), offset: String(offset) });
    const status = url.searchParams.get('status');
    const statusOk = status && ['active', 'paused', 'closed', 'under_review'].includes(status) ? status : null;
    if (statusOk) qs.set('status', statusOk);
    // Sem isto o padrao do ML e stop_time_asc, que joga os anuncios mortos na 1a pagina
    // — e o vendedor conclui que as visitas estao zeradas.
    const ORDENS = ['stop_time_asc','stop_time_desc','start_time_asc','start_time_desc',
      'available_quantity_asc','available_quantity_desc','sold_quantity_asc','sold_quantity_desc',
      'price_asc','price_desc','last_updated_desc','last_updated_asc'];
    const ordem = url.searchParams.get('sort');
    qs.set('orders', ORDENS.includes(ordem) ? ordem : 'last_updated_desc');
    const q = (url.searchParams.get('q') || '').trim();
    if (q) qs.set('q', q);

    let ids, total, aviso = null;
    if (ORDENS_PERIODO.includes(ordem)) {
      // O ML só ordena pelo total de sempre. "No período" e curva ABC saem da cópia local
      // dos pedidos: pega todos os anúncios do filtro, ordena aqui e corta a página.
      const [lista] = await Promise.all([idsDaConta(conta, statusOk, q), sincronizarVendas(conta, dias)]);
      const j = janela(dias);
      const r = Object.fromEntries(D.vendasResumo(conta.ml_user_id, j).map((x) => [x.item_id, x]));
      const abc = A.curvaABC(Object.fromEntries(Object.entries(r).map(([id, x]) => [id, x.faturamento])));
      const un = (id) => r[id]?.unidades || 0;
      // [critério, desempate]: menor vem primeiro
      const chave = {
        vendas_desc: (id) => [-un(id), -(r[id]?.faturamento || 0)],
        vendas_asc: (id) => [un(id), 0],
        abc: (id) => [abc[id]?.ranking ?? Infinity, 0],
        // maior queda primeiro; no empate (vários -100%), quem perdeu mais vendas. Quem tem
        // pouca venda para medir vai para o fim.
        queda: (id) => {
          const t = A.tendencia(r[id]?.antes || 0, r[id]?.depois || 0, A.MINIMO.vendas);
          return t.delta == null ? [Infinity, 0] : [t.delta, -(r[id]?.antes || 0)];
        },
      }[ordem];
      const cmp = (x, y) => (x === y ? 0 : x < y ? -1 : 1);
      // empate total (e Infinity contra Infinity) fica na ordem do ML: atualizado recentemente primeiro
      const ordenados = lista.ids.map((id, i) => [id, chave(id), i])
        .sort((a, b) => cmp(a[1][0], b[1][0]) || cmp(a[1][1], b[1][1]) || a[2] - b[2]).map((x) => x[0]);
      ids = ordenados.slice(offset, offset + limite);
      total = ordenados.length;
      if (lista.cortado) aviso = `A ordenação considera os ${ordenados.length} anúncios atualizados mais recentemente, de ${lista.total}.`;
    } else {
      const busca = await ml(`/users/${conta.ml_user_id}/items/search?${qs}`);
      ids = busca.results || [];
      total = busca.paging?.total ?? 0;
    }
    if (!ids.length) return { total, offset, dias, itens: [], aviso };

    const multi = await ml(`/items?ids=${ids.join(',')}&attributes=${ATRIBUTOS_LISTA}`);
    // /visits/items aceita UM id por chamada — daí o leque em paralelo, não um multiget.
    const visitas = Object.fromEntries(await Promise.all(ids.map(async (id) => {
      const v = await ml(`/items/${id}/visits/time_window?last=${dias + 1}&unit=day`).catch(() => null);
      if (!v) return [id, null];
      const serie = A.serieNaJanela(Object.fromEntries((v.results || []).map((d) => [d.date.slice(0, 10), d.total])), dias);
      const [antes, depois] = A.metades(serie);
      return [id, { total: serie.reduce((a, b) => a + b, 0), serie: A.agrupar(serie),
        tendencia: A.tendencia(antes, depois, A.MINIMO.visitas) }];
    })));

    const custos = D.custosDe(ids);
    const porId = Object.fromEntries(multi.filter((x) => x.code === 200).map((x) => [x.body.id, x.body]));
    const itens = ids.filter((id) => porId[id]).map((id) => ({
      ...porId[id], visitas: visitas[id], custo: custos[id] || null,
      tem_familia: !!porId[id].family_name, tem_variacoes: (porId[id].variations || []).length > 0,
    }));
    for (const it of itens) D.produtoSincronizar(conta.ml_user_id, it);
    return { total, offset, dias, itens, aviso };
  },

  // Vendas, curva ABC, tendência e lucro do período para os anúncios da página.
  // A curva ABC é da conta inteira: o anúncio é A por faturar muito entre TODOS, não na página.
  'GET /api/periodo': async (url) => {
    const conta = contaOuErro();
    const dias = A.diasValidos(url.searchParams.get('dias'));
    const ids = [...new Set((url.searchParams.get('ids') || '').split(','))].filter((x) => ITEM_ID.test(x)).slice(0, 50);
    const sync = await sincronizarVendas(conta, dias);
    const j = janela(dias);
    const resumo = D.vendasResumo(conta.ml_user_id, j);
    const r = Object.fromEntries(resumo.map((x) => [x.item_id, x]));
    const abc = A.curvaABC(Object.fromEntries(resumo.map((x) => [x.item_id, x.faturamento])));
    const imposto = D.impostoLer(conta.ml_user_id);
    const custos = D.custosDe(ids);

    const porDia = {};
    for (const l of D.vendasDiarias(ids, j)) {
      const d = A.diaLocal(l.data);
      (porDia[l.item_id] ||= {})[d] = (porDia[l.item_id][d] || 0) + l.quantidade;
    }
    // Frete só de quem tem custo cadastrado e vendeu: sem custo não há lucro a mostrar.
    // Amostra pequena (5 envios novos por anúncio) — a análise do anúncio mede mais, e o
    // que ela mede fica guardado e vale aqui também.
    const precisaFrete = ids.filter((id) => custos[id]?.custo != null && r[id]?.envios > 0);
    const itensML = precisaFrete.length
      ? Object.fromEntries((await ml(`/items?ids=${precisaFrete.join(',')}&attributes=id,status,shipping`))
        .filter((x) => x.code === 200).map((x) => [x.body.id, x.body]))
      : {};
    const fretes = Object.fromEntries(await emLotes(precisaFrete, 4, async (id) =>
      [id, itensML[id] ? await freteDoItem(conta, itensML[id], j, 5) : null]));

    const itens = {};
    for (const id of ids) {
      const x = r[id] || { unidades: 0, pedidos: 0, faturamento: 0, tarifas: 0, envios: 0, antes: 0, depois: 0 };
      const c = custos[id] || {};
      const eco = A.economia({ faturamento: x.faturamento, unidades: x.unidades,
        tarifas: x.tarifas, freteUnidade: fretes[id]?.por_unidade ?? null, custo: c.custo ?? null,
        outros: c.outros ?? null, impostoPct: imposto });
      itens[id] = {
        unidades: x.unidades, pedidos: x.pedidos, faturamento: x.faturamento, tarifas: x.tarifas,
        abc: abc[id] || null,
        serie: A.agrupar(A.serieNaJanela(porDia[id], dias)),
        tendencia: A.tendencia(x.antes, x.depois, A.MINIMO.vendas),
        custo: c.custo ?? null, frete: fretes[id] || null,
        lucro: eco.lucro, margem: eco.margem, falta: eco.falta,
      };
    }
    const soma = (k) => resumo.reduce((s, x) => s + (x[k] || 0), 0);
    return {
      janela: { dias, de: j.primeiro, ate: j.ultimo }, imposto_pct: imposto,
      sincronizado_em: sync.ate, baixados_agora: sync.baixados,
      conta: { faturamento: soma('faturamento'), unidades: soma('unidades'), pedidos: soma('pedidos'),
        anuncios_com_venda: resumo.length },
      itens,
    };
  },

  // Tela de início: como foi o dia de hoje, contra ontem e contra os últimos dias.
  // Sai da cópia local dos pedidos (a mesma que a listagem usa), depois de sincronizar.
  // Hoje é um dia pela METADE: por isso não usa `janela()`, que só fecha dias inteiros.
  'GET /api/dashboard': async (url) => {
    const conta = contaOuErro();
    const dias = Math.min(30, Math.max(7, Number(url.searchParams.get('dias')) || 14));
    const sync = await sincronizarVendas(conta, dias);

    const hoje = A.diaLocal(new Date().toISOString());
    const meioDia = (d, n = 0) => new Date(Date.parse(`${d}T12:00:00.000Z`) + n * 864e5).toISOString().slice(0, 10);
    const inicio = (d) => new Date(Date.parse(`${d}T03:00:00.000Z`)).toISOString(); // 00h de Brasília
    const primeiro = meioDia(hoje, -(dias - 1));
    const amanha = meioDia(hoje, 1);

    const porDia = Object.fromEntries(D.vendasPorDia(conta.ml_user_id, inicio(primeiro), inicio(amanha))
      .map((l) => [l.dia, l]));
    const doDia = (d) => {
      const x = porDia[d] || {};
      const un = x.unidades || 0, ped = x.pedidos || 0, fat = x.faturamento || 0;
      return { dia: d, unidades: un, pedidos: ped, faturamento: fat, tarifas: x.tarifas || 0,
        ticket: ped ? fat / ped : 0 };
    };
    const serie = Array.from({ length: dias }, (_, i) => doDia(meioDia(primeiro, i)));
    const anteriores = serie.slice(0, -1);                       // sem hoje: dias inteiros
    const media = (k) => (anteriores.length
      ? anteriores.reduce((s, d) => s + d[k], 0) / anteriores.length : 0);

    // Top do dia; sem venda hoje, mostra o da última semana (com aviso de qual período é).
    const topHoje = D.vendasTopItens(conta.ml_user_id, inicio(hoje), inicio(amanha), 5);
    const periodo = topHoje.length ? 'hoje' : '7dias';
    const top = topHoje.length ? topHoje
      : D.vendasTopItens(conta.ml_user_id, inicio(meioDia(hoje, -6)), inicio(amanha), 5);
    let info = {};
    if (top.length) {
      // Título e foto são enfeite: se o ML falhar, a tela continua de pé com o código.
      try {
        info = Object.fromEntries((await ml(`/items?ids=${top.map((x) => x.item_id).join(',')}`
          + '&attributes=id,title,thumbnail,permalink')).filter((x) => x.code === 200)
          .map((x) => [x.body.id, x.body]));
      } catch { info = {}; }
    }

    return {
      dia: hoje, dias,
      hoje: doDia(hoje), ontem: doDia(meioDia(hoje, -1)),
      media: { faturamento: media('faturamento'), unidades: media('unidades'), pedidos: media('pedidos') },
      serie,
      top: {
        periodo,
        itens: top.map((x) => ({ ...x, titulo: info[x.item_id]?.title || null,
          foto: info[x.item_id]?.thumbnail || null, link: info[x.item_id]?.permalink || null })),
      },
      recentes: D.vendasRecentes(conta.ml_user_id, inicio(hoje), inicio(amanha), 8),
      sincronizado_em: sync.ate, baixados_agora: sync.baixados,
      conta: { nickname: conta.nickname || null },
    };
  },

  // Imposto sobre a venda (% do faturamento), da conta inteira.
  'PUT /api/imposto': async (_u, body) => {
    const conta = contaOuErro();
    const pct = body.pct === null || body.pct === '' ? null : Number(body.pct);
    if (pct != null && !(Number.isFinite(pct) && pct >= 0 && pct < 100)) throw erro400('Imposto deve ficar entre 0% e 99%.');
    D.impostoGravar(conta.ml_user_id, pct);
    return { imposto_pct: D.impostoLer(conta.ml_user_id) };
  },

  'GET /api/products': async () => {
    const c = D.contaAtiva();
    return c ? D.produtosListar(c.ml_user_id) : [];
  },

  // ----- posição na listagem (scraper local) -----
  // A API oficial não entrega: /sites/{site}/search responde 403. Quem mede é o
  // scraper, que roda em 127.0.0.1 — só funciona com os dois na mesma máquina.
  // ?forcar=1 ignora o que está lembrado e abre a listagem de teste de novo.
  'GET /api/scraper': async (url) => {
    try {
      await scraper('/health', 5000);
      const nav = await scraper('/navegador', 5000);  // não toca no ML
      if (nav.estado !== 'fechado') {
        return { ligado: true, sessao: 'em_uso', acao: 'conclua ou feche na aba Navegador do painel' };
      }
      const fresca = sessaoScraper && Date.now() - sessaoScraper.em < SESSAO_VALIDADE_MS;
      if (!fresca || url.searchParams.get('forcar')) {
        const s = await scraper('/status', 60000);
        if (s.sessao === 'em_uso') return { ligado: true, sessao: 'em_uso', acao: s.acao || null };
        lembrarSessao(s.sessao, s.acao || null);
      }
      return { ligado: true, sessao: sessaoScraper.sessao, acao: sessaoScraper.acao };
    } catch (e) {
      return { ligado: false, motivo: e.message };
    }
  },

  // ----- navegador do scraper: uma PESSOA faz login, 2FA ou reCAPTCHA pelo painel -----
  // O painel só repassa cliques e teclas e devolve a tela (GET /api/navegador/tela,
  // tratado antes do despacho por ser binário). A porta do scraper segue fechada.
  'GET /api/navegador': async () => scraper('/navegador', 5000),
  'POST /api/navegador/abrir': async (_u, body) => scraperPost('/navegador/abrir',
    { destino: body.destino === 'login' ? 'login' : 'desbloquear' }, 15000),
  'POST /api/navegador/acao': async (_u, body) => scraperPost('/navegador/acao', acaoNavegador(body), 65000),
  'POST /api/navegador/concluir': async () => {
    const r = await scraperPost('/navegador/concluir', {}, 130000);
    if (r.liberado) lembrarSessao('valida');
    return r;
  },
  'POST /api/navegador/fechar': async () => scraperPost('/navegador/fechar', {}, 65000),

  'GET /api/keywords': async (url) => {
    const id = exigeItemId(url.searchParams.get('item'));
    return D.palavrasListar(id);
  },

  'POST /api/keywords': async (_u, body) => {
    const conta = contaOuErro();
    const id = exigeItemId(body.item);
    const termo = String(body.termo || '').trim().toLowerCase();
    if (termo.length < 2) throw Object.assign(new Error('Termo curto demais.'), { status: 400 });
    if (termo.length > 80) throw Object.assign(new Error('Termo longo demais.'), { status: 400 });
    D.palavraAdicionar(id, conta.ml_user_id, termo);
    return D.palavrasListar(id);
  },

  'POST /api/keywords/remove': async (_u, body) => {
    const id = exigeItemId(body.item);
    D.palavraRemover(id, String(body.termo || '').trim().toLowerCase());
    return D.palavrasListar(id);
  },

  // Mede agora. ~3 s por página de listagem — o scraper serializa, não adianta paralelizar.
  'POST /api/posicao': async (_u, body) => {
    const id = exigeItemId(body.item);
    const termo = String(body.termo || '').trim().toLowerCase();
    if (termo.length < 2) throw Object.assign(new Error('Termo curto demais.'), { status: 400 });
    const paginas = Math.min(3, Math.max(1, Number(body.paginas) || 1));
    const conta = contaOuErro();
    let r;
    try {
      r = await scraper(`/posicao?item=${id}&q=${encodeURIComponent(termo)}&paginas=${paginas}`);
    } catch (e) {
      // só o 503 que o scraper devolve ao ver o bloqueio; lentidão (504) e scraper fora
      // do ar (503 sem corpo) não dizem nada sobre a sessão
      if (e.status === 503 && e.body?.cause?.acao) lembrarSessao('bloqueada', e.body.cause.acao);
      throw e;
    }
    lembrarSessao('valida');
    const { resultados = [], ...medicao } = r;
    Object.assign(medicao, await classificarBusca(conta, id, resultados, medicao.posicao));
    D.posicaoSalvar(id, termo, medicao);
    return { ...medicao, historico: D.posicoesHistorico(id, termo) };
  },

  // ----- Mercado Ads -----
  'GET /api/ads/status': async () => {
    try {
      // Api-Version com maiúsculas e valor 1: só esta rota é assim. Todo o resto
      // do Product Ads usa api-version: 2 minúsculo. Trocar quebra a descoberta.
      const a = await ml('/advertising/advertisers?product_id=PADS', { headers: { 'Api-Version': '1' } });
      return { habilitado: true, advertisers: a.advertisers || a };
    } catch (e) {
      if (e.status === 404) {
        return {
          habilitado: false,
          motivo: 'Esta conta não tem anunciante no Mercado Ads. Ative a publicidade no '
            + 'painel do Mercado Livre (Anúncios → Publicidade) e recarregue.',
        };
      }
      throw e;
    }
  },

  // ----- apoio ao cadastro -----
  'GET /api/predict': async (url) => {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return [];
    const r = await fetch(`${API}/sites/${siteAtivo()}/domain_discovery/search?limit=6&q=${encodeURIComponent(q)}`);
    return r.json();
  },
  'GET /api/listing-types': async () => ml(`/sites/${siteAtivo()}/listing_types`),
  'GET /api/category': async (url) => {
    const id = url.searchParams.get('id');
    if (!ITEM_ID.test(id || '')) throw Object.assign(new Error('category id inválido'), { status: 400 });
    const [cat, attrs] = await Promise.all([
      fetch(`${API}/categories/${id}`).then((r) => r.json()),
      fetch(`${API}/categories/${id}/attributes`).then((r) => r.json()),
    ]);
    // Devolve TUDO que dá para editar, não só os obrigatórios: numa categoria de
    // informática são 6 obrigatórios para 54 editáveis. Quem decide o que mostrar é
    // a tela — a de publicar usa só os obrigatórios, a de editar usa todos.
    const editaveis = attrs.filter((a) => !a.tags?.hidden && !a.tags?.read_only);
    return {
      name: cat.name,
      path: (cat.path_from_root || []).map((p) => p.name).join(' › '),
      settings: cat.settings,
      total_atributos: attrs.length,
      // Roupas e calçados: o ML exige tabela de medidas (SIZE_GRID_ID) e a linha do tamanho.
      grade: attrs.some((a) => a.id === 'SIZE_GRID_ID'),
      // Motivos para não ter código de barras (EMPTY_GTIN_REASON vem oculto na ficha do ML).
      sem_gtin: (attrs.find((a) => a.id === 'EMPTY_GTIN_REASON')?.values || []).map((v) => v.name),
      attributes: editaveis.map((a) => ({
        id: a.id,
        name: a.name,
        value_type: a.value_type,
        obrigatorio: !!(a.tags?.required || a.tags?.catalog_required),
        condicional: !!a.tags?.conditional_required,
        dica: a.hint || null,
        values: (a.values || []).slice(0, 200).map((v) => v.name),
        unidades: (a.allowed_units || []).map((u) => u.id),
        unidade_padrao: a.default_unit || (a.allowed_units || [])[0]?.id || null,
      })),
    };
  },

  // Tabelas de medidas da conta para esta categoria + Marca + Gênero, e o que é preciso para criar uma.
  'GET /api/tabelas': async (url) => {
    const conta = contaOuErro();
    const ctx = await contextoGrade(Object.fromEntries(url.searchParams));
    const marca = ctx.marca.id ? { id: ctx.marca.id } : { name: ctx.marca.name };
    const [busca, ficha] = await Promise.all([
      ml('/catalog/charts/search', { method: 'POST', body: JSON.stringify({
        domain_id: ctx.domainId, site_id: ctx.site, seller_id: conta.ml_user_id,
        attributes: [{ id: 'GENDER', values: [{ id: ctx.genero.id }] }, { id: 'BRAND', values: [marca] }],
      }) }),
      fichaGrade(ctx),
    ]);
    return { tabelas: (busca.charts || []).map((ch) => tabelaSimples(ch, ctx.site)), ficha };
  },

  // Cria a tabela de medidas do vendedor. As medidas aparecem para o comprador no anúncio.
  'POST /api/tabelas': async (_u, body) => {
    contaOuErro();
    const ctx = await contextoGrade(body);
    const ficha = await fichaGrade(ctx);
    // O ML só aceita letras, números e espaços no nome (até 60).
    const nome = String(body.nome || '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (nome.length < 3) throw erro400('Dê um nome à tabela (letras, números e espaços).');
    const linhas = Array.isArray(body.linhas) ? body.linhas : [];
    if (!linhas.length || linhas.length > 75) throw erro400('A tabela precisa de 1 a 75 tamanhos.');
    const vistos = new Set();
    const rows = linhas.map((l, i) => {
      const tam = String(l?.tamanho || '').trim();
      if (!tam) throw erro400(`Informe o tamanho da linha ${i + 1}.`);
      if (vistos.has(tam.toLowerCase())) throw erro400(`O tamanho "${tam}" aparece duas vezes.`);
      vistos.add(tam.toLowerCase());
      const medidas = ficha.medidas.map((m) => {
        const n = Number(String(l?.medidas?.[m.id] ?? '').replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) throw erro400(`Informe "${m.nome}" do tamanho ${tam}.`);
        return { id: m.id, values: [{ name: `${n} ${m.unidade}` }] };
      });
      const listas = ficha.listas.map((li) => {
        const v = li.valores.find((x) => x.id === String(l?.listas?.[li.id] ?? ''));
        if (!v) throw erro400(`Escolha "${li.nome}" do tamanho ${tam}.`);
        return { id: li.id, values: [{ id: v.id, name: v.nome }] };
      });
      return { attributes: [{ id: ficha.principal.id, values: [{ name: tam }] }, ...medidas, ...listas] };
    });
    // Motivos de recusa da tabela em português (os mais comuns na aula).
    const ch = await ml('/catalog/charts', { method: 'POST', body: JSON.stringify({
      names: { [ctx.site]: nome }, domain_id: ctx.domainId, site_id: ctx.site,
      main_attribute: { attributes: [{ site_id: ctx.site, id: ficha.principal.id }] },
      attributes: [
        { id: 'GENDER', values: [{ id: ctx.genero.id, name: ctx.genero.name }] },
        { id: 'BRAND', values: [ctx.marca.id ? { id: ctx.marca.id, name: ctx.marca.name } : { name: ctx.marca.name }] },
      ],
      rows,
    }) }).catch((e) => {
      const codigos = (e.body?.errors || []).map((x) => x.code);
      if (codigos.includes('chart_name_unavailable')) {
        throw erro400(`Já existe uma tabela chamada "${nome}" para esta marca e gênero. Ela aparece na lista "Tabela" acima: `
          + 'escolha-a, ou dê outro nome para criar uma nova.');
      }
      throw e;
    });
    return tabelaSimples(ch, ctx.site);
  },

  'POST /api/items': async (_u, body) => {
    const conta = contaOuErro();
    const me = await ml('/users/me').catch(() => null);
    const userProduct = (me?.tags || []).includes('user_product_seller');
    const payload = buildItem(body, { userProduct });
    const item = await ml('/items', { method: 'POST', body: JSON.stringify(payload) })
      .catch(async (e) => { throw await explicarRecusa(e, payload.category_id, payload); });
    const desc = String(body.description || '').trim();
    let description_ok = null;
    if (desc) {
      try {
        await ml(`/items/${item.id}/description`, { method: 'POST', body: JSON.stringify({ plain_text: desc }) });
        description_ok = true;
      } catch { description_ok = false; }
    }
    D.produtoSalvar(conta.ml_user_id, item, { ...payload, title: item.title || payload.title || payload.family_name });
    return { id: item.id, permalink: item.permalink, status: item.status, description_ok, conta: conta.nickname };
  },

  // ---------- Mercado Ads: os números, não só o status ----------
  // Caminhos medidos em conta real (ver references/api-product-ads.md do plugin).
  // A rota antiga /advertising/product_ads/ads/{item_id} devolve status e campanha;
  // métrica só existe sob o ANUNCIANTE, que é o que estas rotas usam.
  'GET /api/ads/metricas': async (q) => {
    const dias = Math.min(90, Math.max(1, Number(q.dias) || 30)); // a API recusa acima de 90
    const { date_from, date_to } = janelaAds(dias);

    const adv = await anunciante();
    if (!adv) {
      return {
        habilitado: false, dias, date_from, date_to,
        motivo: 'Esta conta não tem anunciante no Mercado Ads. Ative a publicidade no '
          + 'painel do Mercado Livre (Anúncios → Publicidade) e recarregue.',
      };
    }

    const campanhas = await paginarAds(
      `/advertising/${siteAtivo()}/advertisers/${adv.advertiser_id}/product_ads/campaigns/search`,
      { date_from, date_to }, 'results',
    );

    const linhas = campanhas.map((c) => ({
      id: c.id, nome: c.name, status: c.status,
      ...numerosAds(c.metrics || c),
    })).sort((a, b) => b.investimento - a.investimento);

    return {
      habilitado: true, dias, date_from, date_to,
      advertiser_id: adv.advertiser_id,
      campanhas: linhas,
      total: somarAds(linhas),
      // Sem isto o instrutor lê o número de ontem achando que é o de hoje.
      nota: 'O Mercado Livre fecha os dados do dia anterior às 10h (horário de Brasília).',
    };
  },
};

// ---------- apoio do Mercado Ads ----------

// Métricas que a API entrega por campanha e por anúncio. Pedir o que não existe
// derruba a resposta inteira, então esta lista é fechada.
const METRICAS_ADS = ['clicks', 'prints', 'ctr', 'cost', 'cpc', 'cvr', 'roas', 'acos',
  'total_amount', 'direct_amount', 'indirect_amount', 'organic_units_amount', 'units_quantity'].join(',');

// date_from/date_to são obrigatórios: sem eles a resposta vem sem métrica nenhuma.
// date_to é ontem porque o dia corrente ainda não fechou.
function janelaAds(dias) {
  const dia = (d) => new Date(d).toISOString().slice(0, 10);
  const fim = Date.now() - 864e5;
  return { date_from: dia(fim - (dias - 1) * 864e5), date_to: dia(fim) };
}

let advCache = null;
async function anunciante() {
  const conta = D.contaAtiva()?.ml_user_id ?? null;
  if (advCache && advCache.conta === conta) return advCache.adv;
  let adv = null;
  try {
    const r = await ml('/advertising/advertisers?product_id=PADS', { headers: { 'Api-Version': '1' } });
    adv = (r.advertisers || [])[0] || null;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  advCache = { conta, adv };
  return adv;
}

// metrics_summary resume só a PÁGINA, não o resultado: medido com limit=1 dando
// R$ 724,20 e limit=50 dando R$ 20.853,13 no mesmo período. O total só sai
// somando todas as páginas, então é isso que esta função faz.
async function paginarAds(caminho, params, chave) {
  const LIMITE = 50, TETO = 40; // 2000 registros; acima disso algo está errado
  const tudo = [];
  for (let pagina = 0; pagina < TETO; pagina++) {
    const qs = new URLSearchParams({ ...params, metrics: METRICAS_ADS, limit: LIMITE, offset: pagina * LIMITE });
    const r = await ml(`${caminho}?${qs}`, { headers: { 'api-version': '2' } });
    const lote = r[chave] || [];
    tudo.push(...lote);
    if (lote.length < LIMITE) break;
  }
  return tudo;
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Só os valores que se somam. Razão fica de fora de propósito — ver recalcular().
function numerosAds(m) {
  const investimento = n(m.cost);
  const receita = n(m.total_amount) || n(m.direct_amount) + n(m.indirect_amount);
  return recalcular({
    investimento, receita,
    direta: n(m.direct_amount), indireta: n(m.indirect_amount),
    organica: n(m.organic_units_amount),
    cliques: n(m.clicks), impressoes: n(m.prints), unidades: n(m.units_quantity),
  });
}

// ROAS, ACOS, TACOS, CTR, CPC e CVR são razões: somá-las ou tirar média delas dá
// número errado. Sempre recalcular a partir dos totais.
function recalcular(s) {
  const div = (a, b) => (b > 0 ? a / b : null);
  return {
    ...s,
    ctr: div(s.cliques, s.impressoes),
    cpc: div(s.investimento, s.cliques),
    cvr: div(s.unidades, s.cliques),
    roas: div(s.receita, s.investimento),
    acos: div(s.investimento, s.receita),
    tacos: div(s.investimento, s.receita + s.organica),
  };
}

// Números de UM anúncio na janela. Devolve null quando a conta não anuncia ou
// quando o item nunca entrou em campanha — o cartão simplesmente não mostra a faixa.
async function metricasDoItem(id, dias) {
  const adv = await anunciante();
  if (!adv) return null;
  const { date_from, date_to } = janelaAds(Math.min(90, Math.max(1, Number(dias) || 30)));
  const achados = await paginarAds(
    `/advertising/${siteAtivo()}/advertisers/${adv.advertiser_id}/product_ads/ads/search`,
    { date_from, date_to, 'filters[item_id]': id }, 'results',
  );
  if (!achados.length) return null;
  // Um item pode estar em mais de uma campanha: soma as linhas e recalcula as razões.
  return { ...somarAds(achados.map((a) => numerosAds(a.metrics || a))), janela: { date_from, date_to, dias } };
}

function somarAds(linhas) {
  const campos = ['investimento', 'receita', 'direta', 'indireta', 'organica', 'cliques', 'impressoes', 'unidades'];
  const s = Object.fromEntries(campos.map((c) => [c, 0]));
  for (const l of linhas) for (const c of campos) s[c] += n(l[c]);
  return { ...recalcular(s), campanhas: linhas.length };
}

// ---------- rotas com parâmetro no caminho ----------
const rotasParam = [
  { m: 'GET', re: /^\/api\/items\/([A-Z]{3}\d+)$/, fn: async ([id]) => {
    exigeItemId(id);
    const item = await ml(`/items/${id}`);
    const descricao = await ml(`/items/${id}/description`).then((d) => d.plain_text || '').catch(() => '');
    const visitas = await ml(`/items/${id}/visits/time_window?last=30&unit=day`).catch(() => null);
    // o que a ML usa para travar campos — medido, nao suposto:
    //   family_name presente  -> titulo nao muda
    //   variations com itens   -> preco e estoque vivem na variacao
    return { ...item, descricao, visitas_30d: visitas?.total_visits ?? null,
      tem_familia: !!item.family_name, tem_variacoes: (item.variations || []).length > 0,
      termos: termosDoItem(item) };
  } },

  { m: 'PUT', re: /^\/api\/items\/([A-Z]{3}\d+)$/, fn: async ([id], body) => {
    const conta = contaOuErro();
    const mudancas = buildEdicao(body);
    const item = await ml(`/items/${exigeItemId(id)}`, { method: 'PUT', body: JSON.stringify(mudancas) });
    D.produtoSincronizar(conta.ml_user_id, item);
    return { id: item.id, ...mudancas, status: item.status, permalink: item.permalink };
  } },

  { m: 'PUT', re: /^\/api\/items\/([A-Z]{3}\d+)\/description$/, fn: async ([id], body) => {
    const texto = String(body.plain_text ?? '').trim();
    if (!texto) throw Object.assign(new Error('Descrição vazia.'), { status: 400 });
    await ml(`/items/${exigeItemId(id)}/description`, {
      method: 'PUT', body: JSON.stringify({ plain_text: texto }),
    });
    return { id, ok: true };
  } },

  // health + o que o ML sugere melhorar no anúncio
  { m: 'GET', re: /^\/api\/items\/([A-Z]{3}\d+)\/quality$/, fn: async ([id]) =>
    ml(`/items/${exigeItemId(id)}/health/actions`).catch(async () => ({
      health: (await ml(`/items/${id}?attributes=health`)).health, actions: [],
    })) },

  // Painel do anúncio. TUDO na mesma janela de dias — misturar janelas (pedidos de
  // 5 meses sobre visitas de 30 dias) infla a conversão em vezes, não em pontos.
  // Limites medidos na API: série diária de visitas vai até 150 dias; /visits/items
  // ignora as datas e sempre devolve o total histórico.
  { m: 'GET', re: /^\/api\/items\/([A-Z]{3}\d+)\/analytics$/, fn: async ([id], _b, url) => {
    exigeItemId(id);
    const conta = contaOuErro();
    const dias = A.diasValidos(url?.searchParams.get('dias'));
    const j = janela(dias);
    const nada = () => null;

    const [item, visitas, historico, perguntas, avaliacoes, ads, , adsMetricas] = await Promise.all([
      ml(`/items/${id}`),
      ml(`/items/${id}/visits/time_window?last=${dias + 1}&unit=day`).catch(nada),
      ml(`/visits/items?ids=${id}&date_from=${j.primeiro}&date_to=${j.ultimo}`).catch(nada),
      ml(`/questions/search?item=${id}&limit=50`).catch(nada),
      ml(`/reviews/item/${id}`).catch(nada),
      ml(`/advertising/product_ads/ads/${id}`, { headers: { 'api-version': '2' } }).catch(nada),
      sincronizarVendas(conta, dias),
      metricasDoItem(id, dias).catch(nada),
    ]);

    // Pedidos da janela saem da cópia local (a mesma da listagem): sem o teto de 200
    // pedidos da busca textual, e só venda paga — cancelado não é faturamento.
    const x = D.vendasResumo(conta.ml_user_id, j).find((v) => v.item_id === id)
      || { unidades: 0, pedidos: 0, faturamento: 0, tarifas: 0, envios: 0, antes: 0, depois: 0 };
    const porDia = {};
    for (const l of D.vendasDiarias([id], j)) {
      const d = A.diaLocal(l.data);
      porDia[d] = (porDia[d] || 0) + l.quantidade;
    }

    const [custo, tendencias, frete] = await Promise.all([
      ml(`/sites/${item.site_id}/listing_prices?price=${item.price}`
        + `&listing_type_id=${item.listing_type_id}&category_id=${item.category_id}`).catch(nada),
      ml(`/trends/${item.site_id}/${item.category_id}`).catch(nada),
      freteDoItem(conta, item, j, 20).catch(nada),
    ]);

    const notas = (avaliacoes?.reviews || []).map((r) => r.rate).filter(Number.isFinite);
    // Medido: a série do ML não vem em ordem de data e pula dia sem visita. Alinha pela data.
    const visitasDia = A.serieNaJanela(Object.fromEntries((visitas?.results || [])
      .map((d) => [d.date.slice(0, 10), d.total])), dias);
    const vendasDia = A.serieNaJanela(porDia, dias);
    const datas = A.diasDaJanela(dias);
    const pico = visitasDia.reduce((m, v, i) => (v > (m?.total ?? -1) ? { data: datas[i], total: v } : m), null);
    const [vAntes, vDepois] = A.metades(visitasDia);

    return {
      janela: { dias, de: j.primeiro, ate: j.ultimo },
      item: {
        id: item.id, titulo: item.title, preco: item.price, moeda: item.currency_id,
        status: item.status, sub_status: item.sub_status, estoque: item.available_quantity,
        vendidos: item.sold_quantity, health: item.health, tipo: item.listing_type_id,
        criado_em: item.date_created, permalink: item.permalink,
        thumb: (item.secure_thumbnail || item.thumbnail || '').replace(/^http:/, 'https:'),
        catalogo: !!item.catalog_listing, frete_gratis: !!item.shipping?.free_shipping,
      },
      visitas: {
        janela: visitas ? visitasDia.reduce((a, b) => a + b, 0) : null,
        historico: historico?.[id] ?? null,   // a API ignora as datas aqui: é o total de sempre
        datas, serie: visitasDia, pico: pico?.total ? pico : null,
        tendencia: A.tendencia(vAntes, vDepois, A.MINIMO.visitas),
      },
      vendas: {
        pedidos: x.pedidos, unidades: x.unidades, faturamento: x.faturamento, tarifas: x.tarifas,
        envios: x.envios, serie: vendasDia,
        tendencia: A.tendencia(x.antes, x.depois, A.MINIMO.vendas),
        ticket_medio: x.pedidos ? x.faturamento / x.pedidos : null,
        conversao: visitas && visitasDia.some(Boolean) ? x.pedidos / visitasDia.reduce((a, b) => a + b, 0) : null,
        vendidos_historico: item.sold_quantity,
        ultimos: D.vendasUltimas(id, 5).map((o) => ({
          id: o.order_id, data: o.data, total: o.total, status: o.status, quantidade: o.quantidade,
        })),
      },
      // O que entra na conta do lucro. A tela recalcula com public/analise.js quando o
      // vendedor digita o custo — os mesmos números, sem voltar ao servidor.
      lucro: {
        custo: D.custoObter(id), imposto_pct: D.impostoLer(conta.ml_user_id), frete,
        tarifa_unit: custo?.sale_fee_amount ?? null,
        tarifa_pct: custo?.sale_fee_details?.percentage_fee ?? null,
        tarifa_fixa: custo?.sale_fee_details?.fixed_fee ?? 0,
      },
      custo: custo ? {
        taxa_venda: custo.sale_fee_amount,
        taxa_percentual: item.price ? custo.sale_fee_amount / item.price : null,
        taxa_anuncio: custo.listing_fee_amount,
        exposicao: custo.listing_exposure,
        liquido: item.price - (custo.sale_fee_amount || 0),
      } : null,
      perguntas: perguntas ? {
        total: perguntas.total ?? 0,
        sem_resposta: (perguntas.questions || []).filter((q) => q.status === 'UNANSWERED').length,
      } : null,
      avaliacoes: avaliacoes ? {
        total: avaliacoes.paging?.total ?? 0,
        nota: notas.length ? notas.reduce((a, b) => a + b, 0) / notas.length : null,
      } : null,
      // status e campanha vêm do anúncio; os números só existem sob o anunciante.
      // O status é de HOJE — um item em hold agora pode ter faturado na janela,
      // por isso os dois vêm separados e nenhum filtra o outro.
      ads: ads || adsMetricas
        ? {
          status: ads?.status ?? null,
          campanha: ads?.campaign_id ?? null,
          grupo: ads?.ad_group_id ?? null,
          ...(adsMetricas || {}),
        }
        : null,
      tendencias: (tendencias || []).slice(0, 8).map((t) => t.keyword),
    };
  } },

  // Custo do produto e outros custos por unidade (embalagem, etiqueta…). Só existem aqui:
  // o Mercado Livre não sabe quanto o vendedor pagou no produto.
  { m: 'PUT', re: /^\/api\/items\/([A-Z]{3}\d+)\/custo$/, fn: async ([id], body) => {
    const conta = contaOuErro();
    const valor = (v, nome) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1e7) throw erro400(`${nome} inválido.`);
      return Math.round(n * 100) / 100;
    };
    D.custoGravar(conta.ml_user_id, exigeItemId(id), {
      custo: valor(body.custo, 'Custo do produto'), outros: valor(body.outros, 'Outros custos'),
    });
    return D.custoObter(id);
  } },

  // tipo de anúncio tem endpoint próprio: o PUT /items recusa listing_type_id
  { m: 'GET', re: /^\/api\/items\/([A-Z]{3}\d+)\/upgrades$/, fn: async ([id]) =>
    ml(`/items/${exigeItemId(id)}/available_upgrades`) },

  { m: 'POST', re: /^\/api\/items\/([A-Z]{3}\d+)\/listing-type$/, fn: async ([id], body) => {
    const tipo = String(body.listing_type_id || '').trim();
    if (!/^[a-z_]+$/.test(tipo)) throw Object.assign(new Error('Tipo de anúncio inválido.'), { status: 400 });
    await ml(`/items/${exigeItemId(id)}/listing_type`, { method: 'POST', body: JSON.stringify({ id: tipo }) });
    return { id, listing_type_id: tipo };
  } },

  // Ads: repasse restrito a /advertising/*. Não invento caminho de campanha —
  // a ML muda esses endpoints, e a conta aqui não tem anunciante para eu validar.
  { m: 'GET', re: /^\/api\/ads\/(advertising\/.+)$/, fn: async ([resto]) =>
    ml('/' + resto, { headers: { 'api-version': '2' } }) },
];

// ---------- despacho ----------
// Uma rota, um caminho. O HTTP chama isto DEPOIS de conferir a origem; o mcp.js
// (stdio, só neste computador, sem rede) chama direto, mas só as rotas da tabela dele.
const achaRota = (metodo, url) => {
  const exato = routes[`${metodo} ${url.pathname}`];
  if (exato) return (corpo) => exato(url, corpo);
  for (const r of rotasParam) {
    if (r.m !== metodo) continue;
    const m = r.re.exec(url.pathname);
    if (m) return (corpo) => r.fn(m.slice(1), corpo, url);
  }
  return null;
};
const temRota = (metodo, url) => !!achaRota(metodo, url);
function despachar(metodo, url, corpo = {}) {
  const fn = achaRota(metodo, url);
  if (!fn) throw Object.assign(new Error(`rota desconhecida: ${metodo} ${url.pathname}`), { status: 404 });
  return fn(corpo);
}

// ---------- HTTP ----------
// Referrer-Policy "same-origin", NUNCA "no-referrer": com no-referrer o navegador manda
// Origin: null no POST de formulário, e a checagem de origem recusa o próprio aluno.
// Medido em 19/09/2026 com Chromium; o teste com curl não pega (curl manda o Origin que quiser).
const SEGURANCA = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
const enviarJson = (res, code, obj, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...SEGURANCA, ...extra });
  res.end(JSON.stringify(obj));
};
const redirecionar = (res, destino, extra = {}) => { res.writeHead(302, { Location: destino, ...extra }); res.end(); };

async function lerCorpo(req, max = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error('corpo grande demais'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

function falhaInterna(res, e) {
  console.error('[erro]', e);
  if (!res.headersSent) enviarJson(res, e.status || 500, { error: e.message || 'erro interno' });
  else res.end();
}

// ---------- servidor do PAINEL: só este computador ----------
const PUBLIC = path.join(__dirname, 'public');
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

async function tratarPainel(req, res) {
  if (!pedidoLocal(req)) return enviarJson(res, 403, { error: 'O painel só atende quem está neste computador (localhost).' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, obj) => enviarJson(res, code, obj);

  // O iniciar.js usa para não subir duas cópias. Não revela nada.
  if (url.pathname === '/api/ping') return send(200, { ok: true, app: 'aula-ml' });

  // Tela do navegador do scraper: JPEG repassado sem passar pelo despacho JSON.
  if (req.method === 'GET' && url.pathname === '/api/navegador/tela') {
    let r;
    try {
      r = await fetch(SCRAPER() + '/navegador/tela', { signal: AbortSignal.timeout(65000) });
    } catch { return send(503, { error: scraperFora().message }); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      return send(r.status, { error: j.detail?.erro || 'sem tela', detail: j.detail || null });
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }

  // Upload de foto: bytes crus -> multipart para o ML.
  if (req.method === 'POST' && url.pathname === '/api/pictures') {
    try {
      const type = String(req.headers['content-type'] || '');
      if (!/^image\/(jpeg|png|webp|gif)$/i.test(type)) {
        throw Object.assign(new Error('Formato não aceito. Use JPG, PNG, WEBP ou GIF.'), { status: 415 });
      }
      const chunks = []; let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_FOTO_BYTES) throw Object.assign(new Error('Imagem acima de 10 MB.'), { status: 413 });
        chunks.push(c);
      }
      if (!size) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.concat(chunks)], { type }), 'foto.' + type.split('/')[1]);
      const up = await ml('/pictures/items/upload', { method: 'POST', body: fd });
      const menor = (up.variations || []).reduce((a, b) => (a && a.size < b.size ? a : b), null);
      return send(200, { id: up.id, thumb: menor?.secure_url || menor?.url || null });
    } catch (e) {
      return send(e.status || 500, { error: e.message, detail: e.body?.cause || null });
    }
  }

  // OAuth: cada passagem CONECTA MAIS UMA conta. A tela abre isto numa aba nova; o ML
  // devolve para a página fixa de redirect e o aluno cola o endereço de volta no painel.
  if (url.pathname === '/auth') {
    const { clientId, clientSecret } = credenciais();
    // App recusado ou redirect_uri fora do cadastro dão uma tela genérica de erro lá no ML.
    // Melhor explicar aqui.
    const { pendente } = await resumoConfig();
    if (!clientId || !clientSecret || pendente === 'credenciais') return redirecionar(res, '/configuracao.html?erro=credenciais');
    if (pendente === 'url') return redirecionar(res, '/configuracao.html?erro=url');
    // PKCE sempre, como o plugin: vale com o app exigindo ou não
    const verifier = crypto.randomBytes(32).toString('base64url');
    const desafio = crypto.createHash('sha256').update(verifier).digest('base64url');
    loginPendente = { state: crypto.randomBytes(16).toString('hex'), verifier, redirect: redirectUri(), criado: Date.now() };
    return redirecionar(res, 'https://auth.mercadolivre.com.br/authorization?response_type=code'
      + `&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(loginPendente.redirect)}`
      + `&state=${loginPendente.state}&code_challenge=${desafio}&code_challenge_method=S256`);
  }

  // despacho
  if (temRota(req.method, url)) {
    try {
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') body = JSON.parse((await lerCorpo(req)) || '{}');
      return send(200, await despachar(req.method, url, body));
    } catch (e) {
      return send(e.status || 500, { error: e.message, detail: e.faltando ? null : (e.body?.cause || e.errors || null),
        ...(e.faltando ? { faltando: e.faltando } : {}) });
    }
  }

  // Sem conta conectada, só a Configuração faz sentido: as outras telas dependem dela.
  if ((url.pathname === '/' || url.pathname.endsWith('.html')) && url.pathname !== '/configuracao.html'
      && !D.contasListar().length) {
    return redirecionar(res, '/configuracao.html');
  }

  // estáticos
  let file;
  // A raiz é a tela de início (dashboard do dia); publicar virou /publicar.html.
  try { file = url.pathname === '/' ? 'inicio.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); }
  catch { return send(400, { error: 'caminho inválido' }); }
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC + path.sep)) return send(403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) return send(404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache', ...SEGURANCA,
    });
    res.end(data);
  });
}

// Sobe o painel. O iniciar.js passa o scraper em `servicos`.
function iniciar({ porta = PORT, servicos: extra } = {}) {
  if (extra) servicos = { ...servicos, ...extra };
  const painel = http.createServer((req, res) => tratarPainel(req, res).catch((e) => falhaInterna(res, e)));
  return new Promise((ok, falhou) => {
    painel.once('error', falhou);
    painel.listen(porta, '127.0.0.1', () => ok());
  }).then(() => ({
    painel, porta: painel.address().port,
    fechar: () => new Promise((ok) => { painel.close(() => ok()); painel.closeAllConnections?.(); }),
  }));
}

if (require.main === module) {
  iniciar().then(({ porta }) => {
    console.log(`→ painel http://localhost:${porta}   (banco: ${D.DB_FILE})`);
    console.log('  Dica: "npm start" sobe também o scraper.');
  }).catch((e) => { console.error(`Não subiu: ${e.message}`); process.exit(1); });
}
// `ml` sai daqui para o mcp.js fazer o repasse à API do Mercado Livre com o token da conta
// ativa. De propósito NÃO existe rota HTTP de repasse: seria "faça qualquer coisa na conta
// do vendedor" a um pedido de distância, e o MCP já roda no mesmo processo.
module.exports = { buildItem, buildEdicao, iniciar, situacaoAtual, resumoConfig, despachar, temRota, ml };
