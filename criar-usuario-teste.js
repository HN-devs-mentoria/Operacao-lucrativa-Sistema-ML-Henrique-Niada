'use strict';
// node criar-usuario-teste.js
// Cria um usuário de teste do Mercado Livre e MOSTRA a senha uma única vez —
// a ML não tem como recuperá-la depois. Guarde na hora.
// Usa o App ID e a chave secreta que você cadastrou no painel (tela Configurações).
require('./ambiente.js').carregar();
const D = require('./db.js');
const API = 'https://api.mercadolibre.com';

(async () => {
  const clientId = D.configLer('ml_client_id') || process.env.ML_CLIENT_ID;
  const clientSecret = D.configLer('ml_client_secret') || process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return console.error('Cadastre o App ID e a chave secreta no painel (tela Configurações) antes.');
  }
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const t = await r.json();
  if (!r.ok) return console.error('Falha ao obter token do app:', t.error, t.message);

  const u = await fetch(`${API}/users/test_user`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: process.env.ML_SITE || 'MLB' }),
  });
  const user = await u.json();
  if (!u.ok) {
    console.error('HTTP', u.status, '|', user.error || '', user.message || '');
    console.error(JSON.stringify(user, null, 2));
    return;
  }
  console.log('\n  GUARDE AGORA — a senha não é recuperável:\n');
  console.log('  usuário :', user.nickname);
  console.log('  senha   :', user.password);
  console.log('  user_id :', user.id);
  console.log('  status  :', user.site_status);
  console.log('\n  Abra uma janela anônima, entre em mercadolivre.com.br com esse usuário,');
  console.log(`  e só então clique em "Conectar conta" no painel (http://localhost:${process.env.PORT || 3100}/configuracao.html).\n`);
})();
