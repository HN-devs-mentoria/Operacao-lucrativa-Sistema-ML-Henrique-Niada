'use strict';
// node test-db.js  — exercita cifra, multi-conta, troca de conta, senha, sessão e URLs públicas.
process.env.ML_DB_FILE = require('node:path').join(require('node:os').tmpdir(), `teste-ml-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_KEY = process.env.ML_DB_KEY || 'chave-de-teste-nao-usar-em-producao';
const assert = require('node:assert');
const D = require('./db.js');

// cifra ida e volta, e o texto cifrado NÃO contém o segredo
const claro = 'APP_USR-123-abc-token-secreto';
const cif = D.cifrar(claro);
assert.ok(cif.startsWith('v1:'), 'deve estar cifrado');
assert.ok(!cif.includes('token-secreto'), 'o cifrado não pode conter o segredo em claro');
assert.strictEqual(D.decifrar(cif), claro);
assert.strictEqual(D.decifrar('texto-antigo-em-claro'), 'texto-antigo-em-claro'); // compat

// duas contas
const tk = (n) => ({ access_token: 'AT-' + n, refresh_token: 'RT-' + n, expires_in: 21600, scope: 'read write' });
D.contaSalvar(tk(1), { id: 111, nickname: 'LOJA_UM', site_id: 'MLB' });
D.contaSalvar(tk(2), { id: 222, nickname: 'LOJA_DOIS', site_id: 'MLB' });

assert.strictEqual(D.contasListar().length, 2);
assert.strictEqual(Number(D.contaAtivaId()), 111, 'a primeira conectada vira a ativa');

// o que vai para o browser não pode ter token
const publico = JSON.stringify(D.contasListar());
assert.ok(!publico.includes('AT-') && !publico.includes('RT-'), 'contasListar não pode vazar token');

// troca de conta
D.contaAtivaDefinir(222);
assert.strictEqual(D.contaAtiva().nickname, 'LOJA_DOIS');
assert.strictEqual(D.contaAtiva().access_token, 'AT-2', 'token decifrado da conta certa');
assert.throws(() => D.contaAtivaDefinir(999), (e) => e.status === 404);

// renovação troca o token só da conta alvo
D.contaTokensAtualizar(222, { access_token: 'AT-2-novo', refresh_token: 'RT-2-novo', expires_in: 21600 });
assert.strictEqual(D.contaObter(222).access_token, 'AT-2-novo');
assert.strictEqual(D.contaObter(111).access_token, 'AT-1', 'a outra conta não pode ser afetada');

// produtos ficam separados por conta
D.produtoSalvar(111, { id: 'MLB1', status: 'active', permalink: 'x' },
  { title: 'A', category_id: 'MLB1', price: 10, available_quantity: 1 });
D.produtoSalvar(222, { id: 'MLB2', status: 'active', permalink: 'y' },
  { title: 'B', category_id: 'MLB1', price: 20, available_quantity: 2 });
assert.deepStrictEqual(D.produtosListar(111).map((p) => p.item_id), ['MLB1']);
assert.deepStrictEqual(D.produtosListar(222).map((p) => p.item_id), ['MLB2']);

// remover conta reaponta a ativa para a que sobrou
D.contaRemover(222);
assert.strictEqual(D.contasListar().length, 1);
assert.strictEqual(Number(D.contaAtivaId()), 111);

// configuração: a chave secreta do DevCenter vai cifrada; o App ID não é segredo
D.configGravar('ml_client_id', '1234567890');
D.configGravar('ml_client_secret', 'segredo-do-devcenter-123');
assert.strictEqual(D.configLer('ml_client_secret'), 'segredo-do-devcenter-123');
const cru = (k) => D.db.prepare('SELECT valor FROM estado WHERE chave=?').get(k).valor;
assert.ok(cru('ml_client_secret').startsWith('v1:') && !cru('ml_client_secret').includes('segredo'),
  'a chave secreta não pode ficar em claro no banco');
assert.strictEqual(cru('ml_client_id'), '1234567890');

D.db.close();
for (const f of [process.env.ML_DB_FILE, process.env.ML_DB_FILE + '-wal', process.env.ML_DB_FILE + '-shm']) {
  try { require('node:fs').unlinkSync(f); } catch {}
}
console.log('OK — cifra, multi-conta, troca, isolamento e configuração');
