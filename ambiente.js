'use strict';
// Carrega o .env da raiz. Se ele não existe, cria a partir do .env.example com uma
// ML_DB_KEY aleatória: o aluno nunca precisa abrir arquivo de configuração.
//
// Senha do painel, App ID e chave secreta NÃO moram aqui: são criados na tela de
// primeiro acesso e gravados no SQLite (a chave secreta vai cifrada com a ML_DB_KEY).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ENV = path.join(__dirname, '.env');
const EXEMPLO = path.join(__dirname, '.env.example');

function garantirEnv() {
  if (fs.existsSync(ENV)) return false;
  const base = fs.existsSync(EXEMPLO) ? fs.readFileSync(EXEMPLO, 'utf8') : '';
  const chave = crypto.randomBytes(32).toString('hex');
  const texto = /^ML_DB_KEY=.*$/m.test(base)
    ? base.replace(/^ML_DB_KEY=.*$/m, `ML_DB_KEY=${chave}`)
    : `${base}\nML_DB_KEY=${chave}\n`;
  fs.writeFileSync(ENV, texto, { mode: 0o600 });
  return true;
}

// Quem já está no ambiente (terminal, CI) vence o arquivo.
function carregar() {
  const criado = garantirEnv();
  process.loadEnvFile(ENV);
  return { criado, arquivo: ENV };
}

module.exports = { carregar, ENV };
