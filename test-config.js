'use strict';
// node test-config.js — a conferência da URI de redirect, o code colado e o app do plugin, sem rede.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { situacao, appDoPlugin, lerCodigoColado, REDIRECT_PADRAO } = require('./app-ml.js');

const R = REDIRECT_PADRAO;
const app = (callbacks, fluxos = ['authorization_code', 'client_credentials', 'refresh_token']) =>
  ({ callback_urls: callbacks, fluxos, use_pkce: false });

// sem conseguir ler o ML não há o que conferir — e não bloqueia o login
assert.strictEqual(situacao({ redirect: R, app: null }).estado, 'nao_verificado');

// cadastro certinho; o ML aceita várias URIs, a nossa no meio delas já basta
let s = situacao({ redirect: R, app: app(['https://outra.exemplo/cb', R]) });
assert.strictEqual(s.estado, 'confere');
assert.deepStrictEqual(s.dicas, []);

// não cadastrada (ex.: app antigo do túnel)
s = situacao({ redirect: R, app: app(['https://velha-url.trycloudflare.com/callback']) });
assert.strictEqual(s.estado, 'divergente');
assert.deepStrictEqual(s.cadastradas, ['https://velha-url.trycloudflare.com/callback']);

// barra no final: o ML compara caractere a caractere, então é erro — mas com dica certeira
s = situacao({ redirect: R, app: app([`${R}/`]) });
assert.strictEqual(s.estado, 'divergente');
assert.ok(s.dicas.some((d) => /barra/.test(d)));

// fluxo faltando no app vira dica, não bloqueio
s = situacao({ redirect: R, app: app([R], ['authorization_code']) });
assert.strictEqual(s.estado, 'confere');
assert.ok(s.dicas.some((d) => /Refresh Token/.test(d)));

// o aluno cola o endereço inteiro, o JSON do httpbin ou só o code
assert.deepStrictEqual(lerCodigoColado(`${R}?code=TG-abc-123&state=xyz`), { code: 'TG-abc-123', state: 'xyz' });
assert.deepStrictEqual(lerCodigoColado('    "code": "TG-abc-123",'), { code: 'TG-abc-123', state: null });
assert.deepStrictEqual(lerCodigoColado('  TG-abc-123 '), { code: 'TG-abc-123', state: null });
assert.deepStrictEqual(lerCodigoColado(''), { code: null, state: null });

// cofre do plugin: lido do caminho de ANUNCIO_OS_CONFIG; só o app e o apelido das contas
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-plugin-'));
const cfg = path.join(dir, 'config.json');
process.env.ANUNCIO_OS_CONFIG = cfg;
assert.strictEqual(appDoPlugin(), null, 'sem plugin instalado');
fs.writeFileSync(cfg, JSON.stringify({ client_id: '123' }));
assert.strictEqual(appDoPlugin(), null, 'sem chave secreta não serve');
fs.writeFileSync(cfg, JSON.stringify({ client_id: 123, client_secret: 'seg' }));
fs.mkdirSync(path.join(dir, 'contas'));
fs.writeFileSync(path.join(dir, 'contas', '555.json'), JSON.stringify({ nickname: 'LOJA_X', refresh_token: 'TG-r' }));
fs.writeFileSync(path.join(dir, 'contas', '555.lock'), '');
const p = appDoPlugin();
assert.deepStrictEqual(p, { clientId: '123', clientSecret: 'seg', redirect: R, contas: [{ id: 555, nickname: 'LOJA_X' }] });
fs.rmSync(dir, { recursive: true });

console.log('OK — URI de redirect: confere, divergente, barra, fluxos; code colado; app do plugin');
