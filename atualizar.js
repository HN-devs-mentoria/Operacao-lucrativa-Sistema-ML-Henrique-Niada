#!/usr/bin/env node
'use strict';
// npm run atualizar — traz as correções mais novas do repositório da aula.
//
// Fork no GitHub é uma cópia parada: não recebe sozinho o que muda no original. Quem fez o
// fork antes de uma correção instala a versão antiga (aconteceu na aula: o login do scraper
// quebrado já tinha sido corrigido, mas o fork do aluno era de antes). Este comando busca
// direto do repositório da aula e AVANÇA a sua cópia — nunca apaga mudança sua.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { acharUv } = require('./processos.js');

const ORIGINAL = 'https://github.com/ElioBonfim/Aula-Mercado-Livre-Henrique-Niada.git';
const RAIZ = __dirname;
const WIN = process.platform === 'win32';

const git = (...args) => spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8' });
const sair = (msg, codigo = 1) => { console.log(msg); process.exit(codigo); };

if (git('--version').status !== 0) sair('O git não está instalado. Instale-o e rode de novo.');
if (git('rev-parse', '--is-inside-work-tree').stdout.trim() !== 'true') {
  sair('Esta pasta não é um repositório git (foi baixada como ZIP?). Clone de novo pelo git.');
}

// Mudança sua ainda não commitada: não mexo, para não misturar nem perder nada.
const sujos = git('status', '--porcelain', '--untracked-files=no').stdout.trim();
if (sujos) {
  sair('Você tem alterações suas que ainda não foram salvas (commit) nestes arquivos:\n'
    + sujos.split('\n').map((l) => '   ' + l).join('\n')
    + '\n\nSalve-as antes (git commit) ou peça ao Claude Code para trazer a versão nova sem perdê-las.');
}

const antes = git('rev-parse', 'HEAD').stdout.trim();
console.log('Buscando a versão mais nova da aula…');
const f = git('fetch', '--quiet', ORIGINAL, 'main');
if (f.status !== 0) sair(`Não consegui buscar (${(f.stderr || '').trim().split('\n')[0]}). Confira a internet e rode de novo.`);

if (git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD').status === 0) {
  sair('Você já está na versão mais nova. Nada a fazer.', 0);
}
const m = git('merge', '--ff-only', 'FETCH_HEAD');
if (m.status !== 0) {
  sair('A sua cópia tem commits seus que o repositório da aula não tem, então não dá para só avançar.\n'
    + 'Peça ao Claude Code: "integre as atualizações de FETCH_HEAD com as minhas mudanças".');
}

const mudou = git('diff', '--name-only', antes, 'HEAD').stdout.split('\n').filter(Boolean);
console.log('\nO que chegou:');
console.log(git('log', '--oneline', `${antes}..HEAD`).stdout.trim().split('\n').map((l) => '   ' + l).join('\n'));

if (mudou.some((a) => /^package(-lock)?\.json$/.test(a))) {
  console.log('\nDependências Node mudaram: npm install…');
  spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: RAIZ, stdio: 'inherit', shell: WIN });
}
if (mudou.some((a) => /^scraper\/(pyproject\.toml|uv\.lock)$/.test(a))) {
  const uv = acharUv();
  if (uv) {
    console.log('\nDependências do scraper mudaram: uv sync…');
    spawnSync(uv, ['sync', '--frozen'], { cwd: path.join(RAIZ, 'scraper'), stdio: 'inherit' });
  }
}

const rodando = (() => { try { return JSON.parse(fs.readFileSync(path.join(RAIZ, 'logs', 'processos.json'), 'utf8')).painel; } catch { return null; } })();
console.log('\nAtualizado.' + (rodando
  ? ' Para valer, reinicie: Ctrl+C no terminal do npm start e rode npm start de novo (a URL pública não muda).'
  : ' Rode: npm start'));
console.log('Para o seu fork no GitHub ficar igual (opcional): git push');
