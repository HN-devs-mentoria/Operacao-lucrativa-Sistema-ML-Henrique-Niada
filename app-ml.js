'use strict';
// Conversa com o DevCenter do Mercado Livre usando SÓ as credenciais do aplicativo
// (grant client_credentials), sem login de vendedor. Serve para duas coisas:
//   1. validar App ID + chave secreta no momento em que o aluno cola os dois;
//   2. ler as URIs de redirect que o ML REALMENTE tem gravadas e conferir a nossa.
// Medido em 18/09/2026: GET /applications/{id} devolve callback_urls[], use_pkce e
// allow_flow; chave errada -> 400 invalid_client.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = 'https://api.mercadolibre.com';
// Sem túnel, o ML devolve o login numa página pública fixa que só mostra o endereço; o
// aluno copia o code de lá e cola no painel. É o mesmo padrão do plugin hn-anuncio-ml,
// então um app só serve aos dois sem tocar no DevCenter.
const REDIRECT_PADRAO = 'https://httpbin.org/get';

const ERROS = {
  invalid_client: 'App ID ou chave secreta incorretos. Copie os dois de novo do DevCenter.',
  unauthorized_client: 'O aplicativo não permite o fluxo "Client Credentials". No DevCenter, em '
    + 'Fluxos OAuth, marque Authorization Code, Client Credentials e Refresh Token, e salve.',
};

async function tokenDoApp(clientId, clientSecret) {
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(new Error(ERROS[j.error] || j.message || j.error || `o ML respondeu ${r.status}`),
      { status: 400, codigo: j.error || String(r.status) });
  }
  return j.access_token;
}

async function lerApp(clientId, clientSecret) {
  const token = await tokenDoApp(clientId, clientSecret);
  const r = await fetch(`${API}/applications/${encodeURIComponent(clientId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const a = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(new Error(a.message || `não deu para ler o aplicativo (${r.status})`),
      { status: 502, codigo: a.error || String(r.status) });
  }
  const callbacks = Array.isArray(a.callback_urls) && a.callback_urls.length
    ? a.callback_urls : (a.callback_url ? [a.callback_url] : []);
  return {
    nome: a.name || null,
    callback_urls: callbacks,
    use_pkce: !!a.use_pkce,
    fluxos: Array.isArray(a.allow_flow) ? a.allow_flow : [],
    bloqueado: !!a.blocked,
  };
}

const semBarra = (u) => String(u || '').trim().replace(/\/+$/, '');

// Confere a URI de redirect no cadastro do ML. Função pura, com teste próprio.
//   app -> o que lerApp devolveu (null quando não deu para consultar o ML)
function situacao({ redirect, app }) {
  if (!app) return { estado: 'nao_verificado', redirect };
  // O ML compara a redirect_uri caractere a caractere: barra no fim já recusa.
  const ok = app.callback_urls.includes(redirect);
  const dicas = [];
  if (!ok && app.callback_urls.map(semBarra).includes(semBarra(redirect))) {
    dicas.push('A URI de redirect está cadastrada com uma barra "/" a mais ou a menos no final. Copie exatamente a daqui.');
  }
  if (!app.fluxos.includes('authorization_code')) dicas.push('Marque "Authorization Code" em Fluxos OAuth.');
  if (!app.fluxos.includes('refresh_token')) {
    dicas.push('Marque "Refresh Token" em Fluxos OAuth — sem ele a conexão cai a cada 6 horas.');
  }
  return { estado: ok ? 'confere' : 'divergente', redirect, dicas, cadastradas: app.callback_urls };
}

// O plugin hn-anuncio-ml guarda o app dele em ~/.hn-anuncio-ml/config.json (ou no caminho
// de ANUNCIO_OS_CONFIG, a mesma variável que o plugin lê). Quem instalou o plugin antes já
// tem App ID, chave e URI de redirect prontos: o painel reaproveita, sem criar outro app.
// Só o APP. O token das contas fica onde está — o refresh_token é de uso único, e se os
// dois sistemas dividissem o mesmo, quem renovasse primeiro derrubaria o outro. Das
// contas, só o ID e o apelido, para o painel sugerir "conecte esta aqui também".
function appDoPlugin() {
  const arq = process.env.ANUNCIO_OS_CONFIG || path.join(os.homedir(), '.hn-anuncio-ml', 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return null; }
  if (!cfg?.client_id || !cfg?.client_secret) return null;
  let arquivos = [];
  try { arquivos = fs.readdirSync(path.join(path.dirname(arq), 'contas')).filter((f) => /^\d+\.json$/.test(f)); } catch {}
  const contas = arquivos.map((f) => {
    let nickname = null;
    try { nickname = JSON.parse(fs.readFileSync(path.join(path.dirname(arq), 'contas', f), 'utf8')).nickname || null; } catch {}
    return { id: Number(f.slice(0, -5)), nickname };
  });
  return {
    clientId: String(cfg.client_id), clientSecret: String(cfg.client_secret),
    redirect: cfg.redirect_uri || REDIRECT_PADRAO, contas,
  };
}

// Aceita o endereço inteiro que o navegador mostrou depois do login (…?code=TG-…&state=…)
// ou só o code. Devolve { code, state } — state é null quando o aluno colou só o code.
function lerCodigoColado(txt) {
  const t = String(txt || '').trim();
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    return { code: u.searchParams.get('code') || null, state: u.searchParams.get('state') };
  }
  // httpbin mostra um JSON; quem copiar a linha "code": "TG-…" também funciona
  const m = t.match(/TG-[A-Za-z0-9-]+/);
  return { code: m ? m[0] : (t || null), state: null };
}

module.exports = { tokenDoApp, lerApp, situacao, appDoPlugin, lerCodigoColado, REDIRECT_PADRAO };
