'use strict';
// Sobe o scraper Python junto com o painel e o mantém de pé.
//
//   uv run --frozen python -m uvicorn api:app --host 127.0.0.1 --port <porta>
//
// `python -m uvicorn` em vez do atalho `uvicorn`: o atalho do uv é um script de shell que,
// rodando sob o launchd do macOS, não consegue ler ~/Documents (TCC). Medido em produção.
// Escuta só em 127.0.0.1: ele dirige um navegador com a conta do ML logada.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const P = require('./processos.js');

const ESPERA_SUBIR_MS = 180000;          // 1ª vez o uv pode instalar dependências
const CHECAGEM_MS = 20000;               // vigia de processo travado
const FALHAS_PARA_REINICIAR = 3;
const REINICIO_MS = [2000, 5000, 15000, 30000, 60000];
const ESTAVEL_MS = 120000;               // rodou isso sem cair: zera a espera

class Scraper extends EventEmitter {
  constructor({ dir, porta, log = console.log, arquivoLog = null }) {
    super();
    this.dir = dir;
    this.porta = porta;
    this.url = `http://127.0.0.1:${porta}`;
    this.log = log;
    this.arquivoLog = arquivoLog;
    this.estado = 'parado';     // parado | iniciando | rodando | reiniciando | indisponivel
    this.pid = null;
    this.reinicios = 0;
    this.erro = null;
    this.desde = null;
    this._proc = null;
    this._parando = false;
    this._timer = null;
    this._vigia = null;
    this._falhasSeguidas = 0;
    this._cauda = [];
  }

  info() {
    return { estado: this.estado, porta: this.porta, url: this.url, pid: this.pid,
      reinicios: this.reinicios, erro: this.erro, desde: this.desde };
  }

  _gravar(txt) {
    const s = String(txt);
    for (const l of s.split('\n')) if (l.trim()) this._cauda.push(l.trim());
    this._cauda = this._cauda.slice(-8);
    if (this.arquivoLog) try { fs.appendFileSync(this.arquivoLog, s); } catch {}
  }

  iniciar() {
    this._parando = false;
    clearTimeout(this._timer);
    const uv = P.acharUv();
    if (!uv) {
      this.estado = 'indisponivel';
      this.erro = 'o "uv" não está instalado. Rode: npm run setup';
      this.emit('estado', this.info());
      return;
    }
    if (!fs.existsSync(`${this.dir}/api.py`)) {
      this.estado = 'indisponivel';
      this.erro = `não achei ${this.dir}/api.py`;
      this.emit('estado', this.info());
      return;
    }

    this.estado = this.reinicios ? 'reiniciando' : 'iniciando';
    this.erro = null;
    this._cauda = [];
    const args = ['run', '--frozen', 'python', '-m', 'uvicorn', 'api:app',
      '--host', '127.0.0.1', '--port', String(this.porta)];
    const proc = P.iniciar(uv, args, { cwd: this.dir, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    this._proc = proc;
    this.pid = proc.pid;
    // direto no arquivo: esta linha é nossa, não pode virar "motivo da queda"
    if (this.arquivoLog) {
      try { fs.appendFileSync(this.arquivoLog, `\n[${new Date().toISOString()}] iniciando scraper (pid ${proc.pid}, porta ${this.porta})\n`); } catch {}
    }
    proc.stdout.on('data', (b) => this._gravar(b));
    proc.stderr.on('data', (b) => this._gravar(b));
    proc.on('error', (e) => { this.erro = e.message; });
    proc.on('exit', (code, sinal) => this._saiu(proc, code, sinal));
    this.emit('estado', this.info());
    this._esperarSaude(proc);
  }

  async _esperarSaude(proc) {
    const fim = Date.now() + ESPERA_SUBIR_MS;
    while (Date.now() < fim && this._proc === proc && !this._parando) {
      if (await this._saudavel()) {
        this.estado = 'rodando';
        this.desde = Date.now();
        this.emit('estado', this.info());
        this._vigiar(proc);
        return;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    if (this._proc === proc && !this._parando && this.estado !== 'rodando') {
      this.erro = `não respondeu em ${ESPERA_SUBIR_MS / 1000} s`;
      P.matarArvore(proc.pid);   // o exit reagenda
    }
  }

  async _saudavel() {
    try {
      const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(4000) });
      return r.ok;
    } catch { return false; }
  }

  // Processo vivo mas surdo (travou) também conta como queda.
  _vigiar(proc) {
    clearInterval(this._vigia);
    this._falhasSeguidas = 0;
    this._vigia = setInterval(async () => {
      if (this._proc !== proc || this._parando) return clearInterval(this._vigia);
      if (await this._saudavel()) { this._falhasSeguidas = 0; return; }
      if (++this._falhasSeguidas >= FALHAS_PARA_REINICIAR) {
        clearInterval(this._vigia);
        this.erro = 'parou de responder';
        P.matarArvore(proc.pid);
      }
    }, CHECAGEM_MS);
  }

  _saiu(proc, code, sinal) {
    if (this._proc !== proc) return;
    clearInterval(this._vigia);
    this._proc = null;
    this.pid = null;
    if (this._parando) { this.estado = 'parado'; this.emit('estado', this.info()); return; }
    if (!this.erro) {
      const ultima = this._cauda.filter((l) => !/^INFO/.test(l)).slice(-1)[0];
      this.erro = `o processo Python terminou (código ${code ?? sinal})${ultima ? ': ' + ultima.slice(0, 200) : ''}`;
    }
    if (this.desde && Date.now() - this.desde > ESTAVEL_MS) this.reinicios = 0;
    const ms = REINICIO_MS[Math.min(this.reinicios, REINICIO_MS.length - 1)];
    this.reinicios++;
    this.estado = 'reiniciando';
    this.desde = null;
    this.emit('caiu', this.erro, ms);
    this.emit('estado', this.info());
    this._timer = setTimeout(() => this.iniciar(), ms);
  }

  reiniciar() {
    clearTimeout(this._timer);
    const proc = this._proc;
    if (!proc) return this.iniciar();
    this.erro = 'reiniciado pelo painel';
    this.reinicios = 0;
    P.matarArvore(proc.pid);   // o exit agenda a volta
  }

  parar() {
    this._parando = true;
    clearTimeout(this._timer);
    clearInterval(this._vigia);
    if (this._proc) P.matarArvore(this._proc.pid);
    this.estado = 'parado';
  }
}

module.exports = { Scraper };
