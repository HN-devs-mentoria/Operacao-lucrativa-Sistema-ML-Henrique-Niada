'use strict';
// Utilidades de processo que funcionam igual em macOS, Linux e Windows.
//
// Por que existe: matar só o processo filho deixa neto vivo — `uv run` sobe um Python,
// que sobe o Chromium. Encerrar só o primeiro deixa os outros órfãos.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';

// No Unix o filho vira líder de um grupo próprio: dá para matar a árvore inteira de uma vez.
function iniciar(cmd, args, opts = {}) {
  return spawn(cmd, args, {
    ...opts,
    detached: !WIN,
    windowsHide: true,
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

function vivo(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function matarArvore(pid) {
  if (!vivo(pid)) return;
  if (WIN) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
}

// Linha de comando de um PID, para conferir que ele é MESMO nosso antes de matar
// (o sistema reaproveita números de PID).
function comandoDo(pid) {
  if (!vivo(pid) || !Number.isInteger(pid)) return '';
  const r = WIN
    ? spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
    { encoding: 'utf8', windowsHide: true })
    : spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return String(r.stdout || '').trim();
}

function tentarOuvir(porta, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code));
    s.listen({ port: porta, host, exclusive: true }, () => s.close(() => resolve(null)));
  });
}

// Livre = ninguém escuta nela, nem em IPv4 nem em IPv6. Testar só 127.0.0.1 engana:
// medido em 18/09/2026 no macOS, um servidor em [::]:3100 convive com um bind em
// 127.0.0.1:3100 — e aí o tráfego IPv4 cai num programa e o IPv6 (localhost -> ::1) no outro.
// Só "em uso" e "sem permissão" contam: máquina sem IPv6 dá outro erro no ::1, e ignoramos.
async function portaLivre(porta) {
  for (const host of [undefined, '127.0.0.1', '::1']) {
    const erro = await tentarOuvir(porta, host);
    if (erro === 'EADDRINUSE' || erro === 'EACCES') return false;
  }
  return true;
}

async function primeiraPortaLivre(inicio, tentativas = 30) {
  for (let p = inicio; p < inicio + tentativas; p++) if (await portaLivre(p)) return p;
  throw new Error(`nenhuma porta livre entre ${inicio} e ${inicio + tentativas - 1}`);
}

// Acha um executável no PATH ou nos lugares onde os instaladores oficiais o deixam.
// Logo depois de instalar o uv, o terminal aberto ainda não tem ~/.local/bin no PATH.
function acharExecutavel(nome, extras = []) {
  const exts = WIN ? ['.exe', '.cmd', ''] : [''];
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), ...extras].filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const f = path.join(d, nome + e);
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
  }
  return null;
}

const acharUv = () => acharExecutavel('uv', [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin',
]);

module.exports = { WIN, iniciar, vivo, matarArvore, comandoDo, portaLivre, primeiraPortaLivre, acharExecutavel, acharUv };
