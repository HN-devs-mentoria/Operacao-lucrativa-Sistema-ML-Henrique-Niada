#!/usr/bin/env node
'use strict';
// npm run setup — deixa o projeto pronto para o "npm start". Pode rodar quantas vezes
// quiser: cada passo confere antes de fazer.
//   1. Node 22.13+                       (não instala: avisa como; o painel não tem dependências npm)
//   2. uv                                instalador oficial da Astral, se faltar
//   3. Python + dependências do scraper  uv sync (o uv baixa o Python 3.12 se preciso)
//   4. Chromium do Playwright            playwright install chromium
//   5. .env, banco e o app do plugin     ambiente.js; reaproveita o app do hn-anuncio-ml se houver
//   6. testes                            npm test
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const RAIZ = __dirname;
const SCRAPER = path.join(RAIZ, 'scraper');
const WIN = process.platform === 'win32';
const resultado = [];
const ok = (t) => { resultado.push(`[ok] ${t}`); console.log(`  [ok] ${t}`); };
const falhou = (t, dica) => { resultado.push(`[x]  ${t}${dica ? `\n       ${dica}` : ''}`); console.log(`  [x]  ${t}`); if (dica) console.log(`       ${dica}`); };
const etapa = (t) => console.log(`\n> ${t}`);

function rodar(cmd, args, opts = {}) {
  console.log(`  $ ${[path.basename(cmd), ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: opts.shell ?? false, cwd: opts.cwd || RAIZ, env: { ...process.env, ...opts.env } });
  return r.status === 0;
}

console.log('\nAula Mercado Livre - Henrique Niada — instalação\n');

// 1. Node
etapa('Node.js');
const [maior, menor] = process.versions.node.split('.').map(Number);
if (maior < 22 || (maior === 22 && menor < 13)) {
  falhou(`Node ${process.versions.node} (precisa 22.13 ou mais novo)`,
    WIN ? 'Instale com: winget install OpenJS.NodeJS.LTS   e abra um terminal novo.'
      : 'Instale o Node LTS: https://nodejs.org  (no Mac: brew install node)');
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

// 2. uv
etapa('uv (gerenciador do Python)');
const { acharUv } = require('./processos.js');
let uv = acharUv();
if (!uv) {
  console.log('  uv não encontrado — instalando pelo instalador oficial (astral.sh)…');
  if (WIN) rodar('powershell', ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex']);
  else rodar('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
  uv = acharUv();
}
if (!uv) {
  falhou('uv não instalado', 'Instale manualmente: https://docs.astral.sh/uv/getting-started/installation/ e rode npm run setup de novo.');
} else {
  const v = spawnSync(uv, ['--version'], { encoding: 'utf8' });
  ok(`${String(v.stdout).trim()} (${uv})`);

  // 3. dependências Python
  etapa('Scraper: Python e dependências');
  if (rodar(uv, ['sync', '--frozen'], { cwd: SCRAPER })) ok('uv sync');
  else falhou('uv sync falhou', 'Veja o erro acima.');

  // 4. Chromium
  etapa('Scraper: navegador Chromium (Playwright)');
  if (rodar(uv, ['run', '--frozen', 'playwright', 'install', 'chromium'], { cwd: SCRAPER })) ok('Chromium instalado');
  else {
    falhou('playwright install falhou', process.platform === 'linux'
      ? 'No Linux, instale as dependências do sistema: cd scraper && sudo $(which uv) run playwright install-deps chromium'
      : 'Veja o erro acima e rode npm run setup de novo.');
  }
}

// 5. .env, banco e o app do Mercado Livre
etapa('Configuração local');
const { criado } = require('./ambiente.js').carregar();
ok(criado ? '.env criado com uma chave de cifra nova' : '.env já existia (mantido)');
const D = require('./db.js');
ok('banco SQLite pronto');
// Quem instalou o plugin antes já tem o app criado no DevCenter: a tela pré-preenche com ele.
const plugin = require('./app-ml.js').appDoPlugin();
if (D.configLer('ml_client_id')) ok('app do Mercado Livre já cadastrado no painel');
else if (plugin) {
  const contas = plugin.contas.map((c) => c.nickname || c.id).join(', ');
  ok(`app do plugin hn-anuncio-ml encontrado (App ID ${plugin.clientId}): a tela de Configuração já vem preenchida com ele`);
  if (contas) console.log(`       conta(s) conectada(s) no plugin: ${contas} — conecte aqui também, na tela de Configuração (um clique).`);
} else console.log('  -   nenhum app ainda: o painel ensina a criar, na tela de Configuração.');

// 6. testes
etapa('Testes');
if (rodar('npm', ['test', '--silent'], { shell: WIN, env: { ABRIR_NAVEGADOR: '0' } })) ok('testes passaram');
else falhou('algum teste falhou', 'Veja a saída acima.');

console.log('\nResumo:\n' + resultado.map((r) => `  ${r}`).join('\n'));
const erros = resultado.filter((r) => r.startsWith('[x]')).length;
console.log(erros
  ? `\n${erros} item(ns) com problema. Corrija e rode "npm run setup" de novo.\n`
  : '\nTudo pronto. Agora rode:  npm start\n');
process.exit(erros ? 1 : 0);
