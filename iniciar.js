#!/usr/bin/env node
'use strict';
// npm start — sobe tudo o que a aula precisa, num comando só:
//   1. painel em http://localhost:3100                               server.js
//   2. scraper Python em 127.0.0.1:8100 (reinicia sozinho se cair)   scraper-processo.js
// Ctrl+C encerra os dois; `npm run parar` também. Nada de Docker, nada exposto à internet.
const [maior, menor] = process.versions.node.split('.').map(Number);
if (maior < 22 || (maior === 22 && menor < 13)) {
  console.error(`\nNode ${process.versions.node} é antigo demais: o painel usa node:sqlite, que precisa do Node 22.13 ou mais novo.`
    + '\nInstale o Node LTS atual (https://nodejs.org) e rode de novo.\n');
  process.exit(1);
}

const { carregar } = require('./ambiente.js');
const amb = carregar(); // antes de qualquer require que leia o .env
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const P = require('./processos.js');
const { Scraper } = require('./scraper-processo.js');

const LOGS = path.join(__dirname, 'logs');
const PIDS = path.join(LOGS, 'processos.json');
fs.mkdirSync(LOGS, { recursive: true });

const hora = () => new Date().toLocaleTimeString('pt-BR');
const log = (...a) => console.log(`[${hora()}]`, ...a);

async function painelJaRodando(porta) {
  try {
    const r = await fetch(`http://127.0.0.1:${porta}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json()).app === 'aula-ml';
  } catch { return false; }
}

const lerPids = () => { try { return JSON.parse(fs.readFileSync(PIDS, 'utf8')); } catch { return {}; } };

// Uma cópia viva deste painel (em qualquer porta: se a 3100 estava ocupada, ela foi para
// outra). Duas cópias = dois scrapers brigando pelo mesmo perfil do Chromium.
async function instanciaViva() {
  const reg = lerPids();
  if (reg.painel && reg.painel !== process.pid && P.vivo(reg.painel)
    && /iniciar\.js/.test(P.comandoDo(reg.painel)) && await painelJaRodando(reg.porta)) return reg.porta;
  const pedida = Number(process.env.PORT) || 3100;
  return (await painelJaRodando(pedida)) ? pedida : null;
}

// Se a execução anterior morreu sem encerrar o scraper, ele segura a porta e o perfil do
// Chromium. Só mata o PID se a linha de comando confirmar que é nosso.
function limparOrfaos() {
  const reg = lerPids();
  const alvos = [['scraper', reg.scraper, /uvicorn.*api:app/]];
  for (const [nome, pid, marca] of alvos) {
    if (P.vivo(pid) && marca.test(P.comandoDo(pid))) {
      P.matarArvore(pid);
      log(`encerrei um ${nome} que ficou rodando de uma execução anterior (pid ${pid})`);
    }
  }
}

async function escolherPortas() {
  const usadas = new Set();
  const pegar = async (inicio) => {
    for (let p = inicio; ; p++) {
      p = await P.primeiraPortaLivre(p);
      if (!usadas.has(p)) { usadas.add(p); return p; }
    }
  };
  const pedida = Number(process.env.PORT) || 3100;
  const porta = await pegar(pedida);
  const portaScraper = await pegar(Number(process.env.SCRAPER_PORTA) || 8100);
  if (porta !== pedida) log(`a porta ${pedida} está ocupada por outro programa; o painel vai usar a ${porta}.`);
  return { porta, portaScraper };
}

function abrirNavegador(u) {
  if (process.env.ABRIR_NAVEGADOR === '0') return false;
  const [cmd, args] = P.WIN ? ['cmd', ['/c', 'start', '', u]]
    : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch {}
  return true;
}

function quadro(linhas) {
  const larg = Math.max(...linhas.map((l) => l.length));
  const borda = '-'.repeat(larg + 4);
  console.log(`\n${borda}\n${linhas.map((l) => `| ${l.padEnd(larg)} |`).join('\n')}\n${borda}\n`);
}

async function main() {
  const viva = await instanciaViva();
  if (viva) {
    const u = `http://localhost:${viva}`;
    log(`O painel já está rodando: ${u}${abrirNavegador(u) ? '  (abri no navegador)' : ''}`);
    log('Para reiniciar, encerre o outro com Ctrl+C no terminal dele e rode npm start de novo.');
    return;
  }
  limparOrfaos();
  const { porta, portaScraper } = await escolherPortas();
  const painelUrl = `http://localhost:${porta}`;

  const scraper = new Scraper({
    dir: path.join(__dirname, 'scraper'), porta: portaScraper, log, arquivoLog: path.join(LOGS, 'scraper.log'),
  });
  process.env.SCRAPER_URL = scraper.url;

  const S = require('./server.js');
  const D = require('./db.js');
  const srv = await S.iniciar({
    porta,
    servicos: { scraper: () => scraper.info(), reiniciarScraper: () => scraper.reiniciar() },
  });

  const salvarPids = () => {
    try { fs.writeFileSync(PIDS, JSON.stringify({ painel: process.pid, porta, scraper: scraper.pid })); } catch {}
  };
  salvarPids();

  console.log('\n  Aula Mercado Livre - Henrique Niada');
  log(`painel no ar: ${painelUrl}   (banco: ${path.relative(process.cwd(), D.DB_FILE) || D.DB_FILE})`);
  if (amb.criado) log('criei o .env com uma chave de cifra nova (não apague: ela abre os tokens do banco)');

  // ---- scraper ----
  let scraperJaSubiu = false;
  scraper.on('estado', (s) => {
    salvarPids();
    if (s.estado === 'rodando') {
      log(`${scraperJaSubiu ? 'scraper de volta' : 'scraper pronto'}: ${scraper.url}`);
      scraperJaSubiu = true;
    }
    if (s.estado === 'indisponivel') log(`scraper NÃO subiu: ${s.erro}`);
  });
  scraper.on('caiu', (motivo, ms) => log(`scraper caiu (${motivo}). Reiniciando em ${ms / 1000} s…`));
  log('subindo o scraper Python… (a primeira vez pode levar alguns minutos)');
  scraper.iniciar();

  // ---- app do Mercado Livre ----
  // Sem túnel não há URL que mude: confere uma vez e diz o próximo passo, se houver.
  avisarConfig().catch((e) => log(`não consegui conferir o app no Mercado Livre: ${e.message}`));
  async function avisarConfig() {
    const r = await S.resumoConfig(true);
    const cfg = `${painelUrl}/configuracao.html`;
    if (r.credenciais_invalidas) log(`o Mercado Livre recusou o App ID e a chave salvos: confira em ${cfg}`);
    else if (r.pendente === 'credenciais') {
      log(require('./app-ml.js').appDoPlugin()
        ? `achei o app do plugin hn-anuncio-ml: confirme em ${cfg} (os campos já vêm preenchidos)`
        : `primeiro acesso: abra ${cfg} e cadastre o seu app do Mercado Livre`);
    }
    if (r.pendente === 'url') {
      quadro([
        'Falta cadastrar no seu aplicativo do DevCenter do Mercado Livre:', '',
        `URI de redirect .......... ${r.situacao.redirect}`, '',
        `Passo a passo no painel: ${cfg}`,
      ]);
    }
    if (r.pendente === 'conta') log(`falta conectar a conta: ${cfg}`);
  }

  abrirNavegador(painelUrl);
  log('tudo subindo. Para fechar tudo: Ctrl+C (ou npm run parar)');

  // ---- encerramento: nada fica rodando para trás ----
  let encerrando = false;
  const encerrar = () => {
    if (encerrando) return;
    encerrando = true;
    log('encerrando painel e scraper…');
    scraper.parar();
    try { fs.unlinkSync(PIDS); } catch {}
    srv.fechar().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, encerrar);
  process.on('exit', () => scraper.parar());
}

main().catch((e) => {
  console.error(`\nNão consegui subir: ${e.message}\n`);
  process.exit(1);
});
