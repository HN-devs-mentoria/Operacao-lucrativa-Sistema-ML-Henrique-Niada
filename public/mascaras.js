// Máscaras e formatadores dos campos do painel. Sem dependência.
//
//   <input data-mascara="moeda">          R$ 1.234,56 — digitar 8990 vira 89,90; teto R$ 99.999.999,99
//   <input data-mascara="inteiro" data-max="99999">   só dígitos, sem zero à esquerda, com teto
//   <input data-mascara="decimal" data-casas="2">     88,5 — vírgula decimal, até N casas
//   <input data-mascara="categoria">      MLB183804 — 3 letras maiúsculas + dígitos
//   <input data-mascara="digitos">        só números (App ID)
//   <input data-mascara="maiusculas">     P, M, GG…
//   <input data-mascara="sem-espacos">    chave secreta colada com espaço
//   <input data-mascara="nome-tabela">    só letras, números e espaços (regra do ML)
//   <input data-mascara="youtube">        colar o link do vídeo deixa só o id
//   <input data-contador="60">            mostra "12/60" no rótulo do campo
//
// Campos criados depois (ficha técnica, tabela de medidas, edição rápida) são pegos sozinhos.
// Para LER um número: Mascara.numero(campo). Nunca Number(campo.value): "1.234,56" vira NaN.
(() => {
  const MOEDA = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MAX_DIGITOS_MOEDA = 10; // R$ 99.999.999,99

  // Texto livre -> número: "1.234,56", "1234.56", "89,9", "R$ 10". Separador decimal é o último
  // que aparece; ponto sozinho com 3 dígitos depois é milhar (1.234 = mil duzentos e trinta e quatro).
  function numeroDeTexto(txt) {
    let s = String(txt ?? '').replace(/[^\d.,]/g, '');
    if (!/\d/.test(s)) return NaN;
    const v = s.lastIndexOf(','), p = s.lastIndexOf('.');
    let dec = '';
    if (v > -1 && p > -1) dec = v > p ? ',' : '.';
    else if (v > -1) dec = ',';
    else if (p > -1 && s.indexOf('.') === p && s.length - p - 1 !== 3) dec = '.';
    if (dec) {
      const [int, frac] = [s.slice(0, s.lastIndexOf(dec)), s.slice(s.lastIndexOf(dec) + 1)];
      s = int.replace(/[.,]/g, '') + '.' + frac.replace(/[.,]/g, '');
    } else s = s.replace(/[.,]/g, '');
    return Number(s);
  }

  const posFinal = (el) => { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} };
  // Reescreve o valor mantendo o cursor à mesma distância do fim (não pula para o fim a cada tecla).
  function trocar(el, novo, noFim = false) {
    if (el.value === novo) return;
    let doFim = 0;
    try { doFim = el.value.length - el.selectionEnd; } catch {}
    el.value = novo;
    if (noFim || document.activeElement !== el) return posFinal(el);
    const pos = Math.max(0, novo.length - doFim);
    try { el.setSelectionRange(pos, pos); } catch {}
  }

  const FORMATOS = {
    moeda(el) {
      const d = el.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, MAX_DIGITOS_MOEDA);
      trocar(el, d ? MOEDA.format(Number(d) / 100) : '', true);
    },
    inteiro(el) {
      let d = el.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
      const max = Number(el.dataset.max);
      if (d && Number.isFinite(max) && Number(d) > max) d = String(max);
      trocar(el, d);
    },
    decimal(el) {
      const casas = Number(el.dataset.casas ?? 2);
      let s = el.value.replace(/\./g, ',').replace(/[^\d,]/g, '');
      const i = s.indexOf(',');
      if (i > -1) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/,/g, '').slice(0, casas);
      s = s.replace(/^0+(?=\d)/, '');
      if (s.startsWith(',')) s = '0' + s;
      const [int, frac] = s.split(',');
      trocar(el, int.slice(0, 9) + (frac !== undefined ? ',' + frac : ''));
    },
    categoria(el) {
      const s = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const letras = (s.match(/^[A-Z]{0,3}/) || [''])[0];
      trocar(el, (letras + s.slice(letras.length).replace(/\D/g, '')).slice(0, 15));
    },
    digitos(el) { trocar(el, el.value.replace(/\D/g, '')); },
    maiusculas(el) { trocar(el, el.value.toUpperCase()); },
    'sem-espacos'(el) { trocar(el, el.value.replace(/\s+/g, '')); },
    'nome-tabela'(el) { trocar(el, el.value.replace(/[^\p{L}\p{N} ]/gu, '').replace(/ {2,}/g, ' ')); },
    youtube(el) {
      const v = el.value.trim();
      const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(v);
      trocar(el, m ? m[1] : v.replace(/\s+/g, ''), true);
    },
  };

  const MODO_TECLADO = { moeda: 'numeric', inteiro: 'numeric', decimal: 'decimal', digitos: 'numeric' };

  function ligar(el) {
    const tipo = el.dataset.mascara;
    if (el.__mascara || !FORMATOS[tipo]) return;
    el.__mascara = true;
    if (MODO_TECLADO[tipo]) el.inputMode = MODO_TECLADO[tipo];
    el.setAttribute('autocomplete', 'off');
    // Colar "R$ 1.234,56" ou "89.9" em moeda: interpreta o número, não só os dígitos.
    if (tipo === 'moeda') {
      el.addEventListener('paste', (ev) => {
        const n = numeroDeTexto(ev.clipboardData?.getData('text'));
        if (!Number.isFinite(n)) return;
        ev.preventDefault();
        definir(el, n);
      });
    }
    el.addEventListener('input', () => FORMATOS[tipo](el));
    if (el.value) FORMATOS[tipo](el);
  }

  function ligarContador(el) {
    if (el.__contador) return;
    el.__contador = true;
    const max = Number(el.dataset.contador) || el.maxLength;
    if (max > 0 && !(el.maxLength > 0)) el.maxLength = max;
    const span = document.createElement('span');
    span.className = 'hint contador';
    span.setAttribute('aria-live', 'polite');
    const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    (lab || el.parentElement).appendChild(span);
    const pintar = () => { span.textContent = ` ${el.value.length}/${max}`; };
    el.addEventListener('input', pintar);
    pintar();
    el.__pintarContador = pintar;
  }

  function aplicar(raiz = document) {
    if (raiz.matches?.('[data-mascara]')) ligar(raiz);
    if (raiz.matches?.('[data-contador]')) ligarContador(raiz);
    raiz.querySelectorAll?.('[data-mascara]').forEach(ligar);
    raiz.querySelectorAll?.('[data-contador]').forEach(ligarContador);
  }

  // Número do campo, seja qual for a máscara. Vazio -> NaN.
  function numero(el) {
    const tipo = el?.dataset.mascara, v = String(el?.value ?? '').trim();
    if (!v) return NaN;
    if (tipo === 'moeda') { const d = v.replace(/\D/g, ''); return d ? Number(d) / 100 : NaN; }
    if (tipo === 'inteiro' || tipo === 'digitos') return parseInt(v.replace(/\D/g, ''), 10);
    return numeroDeTexto(v);
  }

  // Põe um número no campo já no formato da máscara (valor vindo do ML: 89.9 -> "89,90").
  function definir(el, n) {
    const tipo = el.dataset.mascara;
    const num = typeof n === 'number' ? n : numeroDeTexto(n);
    if (n === '' || n == null || !Number.isFinite(num)) el.value = '';
    else if (tipo === 'moeda') el.value = MOEDA.format(Math.round(num * 100) / 100);
    else if (tipo === 'inteiro') el.value = String(Math.trunc(num));
    else if (tipo === 'decimal') el.value = String(num).replace('.', ',');
    else el.value = String(n);
    el.__pintarContador?.();
  }

  window.Mascara = { aplicar, numero, definir, numeroDeTexto };
  aplicar();
  new MutationObserver((mudancas) => {
    for (const m of mudancas) for (const n of m.addedNodes) if (n.nodeType === 1) aplicar(n);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
