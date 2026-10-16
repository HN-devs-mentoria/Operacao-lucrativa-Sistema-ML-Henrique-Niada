#!/usr/bin/env node
'use strict';
// npm run parar — fecha painel e scraper, mesmo que o terminal do npm start tenha sumido.
const fs = require('node:fs');
const path = require('node:path');
const P = require('./processos.js');

const LOGS = path.join(__dirname, 'logs');
const PIDS = path.join(LOGS, 'processos.json');
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

(async () => {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(PIDS, 'utf8')); } catch {}

  // 1. painel (ele encerra o scraper junto); espera até 5 s pelo encerramento limpo
  if (P.vivo(reg.painel) && /iniciar\.js/.test(P.comandoDo(reg.painel))) {
    try { process.kill(reg.painel, 'SIGINT'); } catch {}
    for (let i = 0; i < 10 && P.vivo(reg.painel); i++) await dormir(500);
    if (P.vivo(reg.painel)) P.matarArvore(reg.painel);
    console.log(`painel encerrado (pid ${reg.painel})`);
  } else {
    console.log('painel: não estava rodando');
  }

  // 2. scraper que tenha sobrado
  if (P.vivo(reg.scraper) && /uvicorn.*api:app/.test(P.comandoDo(reg.scraper))) {
    P.matarArvore(reg.scraper);
    console.log(`scraper encerrado (pid ${reg.scraper})`);
  }

  try { fs.unlinkSync(PIDS); } catch {}
  console.log('\nTudo parado.');
})();
