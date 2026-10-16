// Prova as duas regras que a API do Mercado Ads castiga quando ignoradas:
//   1. total é a soma de TODAS as páginas, nunca o metrics_summary de uma página
//   2. razão (ROAS/ACOS/TACOS/CTR/CPC/CVR) se recalcula dos somatórios, nunca se soma
// Roda sem rede: reimplanta as funções puras e compara com o esperado.
//   node test-ads.js

const assert = require('node:assert/strict');

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function recalcular(s) {
  const div = (a, b) => (b > 0 ? a / b : null);
  return {
    ...s,
    ctr: div(s.cliques, s.impressoes),
    cpc: div(s.investimento, s.cliques),
    cvr: div(s.unidades, s.cliques),
    roas: div(s.receita, s.investimento),
    acos: div(s.investimento, s.receita),
    tacos: div(s.investimento, s.receita + s.organica),
  };
}

function numerosAds(m) {
  const investimento = n(m.cost);
  const receita = n(m.total_amount) || n(m.direct_amount) + n(m.indirect_amount);
  return recalcular({
    investimento, receita,
    direta: n(m.direct_amount), indireta: n(m.indirect_amount),
    organica: n(m.organic_units_amount),
    cliques: n(m.clicks), impressoes: n(m.prints), unidades: n(m.units_quantity),
  });
}

function somarAds(linhas) {
  const campos = ['investimento', 'receita', 'direta', 'indireta', 'organica', 'cliques', 'impressoes', 'unidades'];
  const s = Object.fromEntries(campos.map((c) => [c, 0]));
  for (const l of linhas) for (const c of campos) s[c] += n(l[c]);
  return { ...recalcular(s), campanhas: linhas.length };
}

const perto = (a, b, casas = 6) => assert.equal(Number(a).toFixed(casas), Number(b).toFixed(casas));

// ---------- 1. razão não se soma ----------
// Campanha cara e ruim + campanha barata e ótima. A média das razões mente.
const a = numerosAds({ cost: 900, total_amount: 1800, clicks: 300, prints: 30000, units_quantity: 30, organic_units_amount: 0 });
const b = numerosAds({ cost: 100, total_amount: 2200, clicks: 50, prints: 2000, units_quantity: 40, organic_units_amount: 0 });
perto(a.roas, 2); // 1800/900
perto(b.roas, 22); // 2200/100

const t = somarAds([a, b]);
perto(t.investimento, 1000);
perto(t.receita, 4000);
perto(t.roas, 4); // 4000/1000 — o certo
assert.notEqual(Number(t.roas.toFixed(6)), Number(((a.roas + b.roas) / 2).toFixed(6))); // média daria 12
perto(t.acos, 0.25); // 1000/4000
perto(t.ctr, 350 / 32000);
perto(t.cpc, 1000 / 350);
perto(t.cvr, 70 / 350);

// ---------- 2. TACOS conta a receita orgânica ----------
const c = numerosAds({ cost: 200, total_amount: 800, organic_units_amount: 1200, clicks: 40, prints: 4000, units_quantity: 10 });
perto(c.acos, 0.25); // 200/800 — só o anúncio
perto(c.tacos, 0.1); // 200/(800+1200) — a loja inteira
assert.ok(c.tacos < c.acos, 'TACOS tem de ser menor que ACOS quando há venda orgânica');

// ---------- 3. total_amount ausente cai para direta+indireta ----------
const d = numerosAds({ cost: 50, direct_amount: 120, indirect_amount: 80, clicks: 10, prints: 1000 });
perto(d.receita, 200);
perto(d.roas, 4);

// ---------- 4. divisão por zero devolve null, não NaN nem Infinity ----------
const z = numerosAds({ cost: 0, total_amount: 0, clicks: 0, prints: 0, units_quantity: 0 });
for (const k of ['ctr', 'cpc', 'cvr', 'roas', 'acos', 'tacos']) {
  assert.equal(z[k], null, `${k} deveria ser null quando o divisor é zero`);
}
// Investiu e não vendeu: ROAS é 0 (número real), ACOS é null (não dá para dividir por zero).
const zz = numerosAds({ cost: 300, total_amount: 0, clicks: 20, prints: 5000 });
perto(zz.roas, 0);
assert.equal(zz.acos, null);

// ---------- 5. a armadilha da paginação ----------
// metrics_summary de uma página contra a soma das páginas: na conta medida pelo
// plugin a diferença foi de 29x. Aqui reproduzimos a forma do erro.
const paginas = [
  Array.from({ length: 50 }, () => ({ cost: 400, total_amount: 1200, clicks: 20, prints: 2000, units_quantity: 3, organic_units_amount: 0 })),
  Array.from({ length: 13 }, () => ({ cost: 400, total_amount: 1200, clicks: 20, prints: 2000, units_quantity: 3, organic_units_amount: 0 })),
];
const todas = paginas.flat().map(numerosAds);
const totalCerto = somarAds(todas);
perto(totalCerto.investimento, 63 * 400);
assert.equal(totalCerto.campanhas, 63);

const soPrimeira = somarAds(paginas[0].map(numerosAds));
assert.ok(totalCerto.investimento > soPrimeira.investimento,
  'parar na primeira página tem de dar MENOS que somar todas');

// paginar tem de parar quando o lote vem menor que o limite
function paginarFalso(lotes) {
  const LIMITE = 50, tudo = [];
  for (let p = 0; p < 40; p++) {
    const lote = lotes[p] || [];
    tudo.push(...lote);
    if (lote.length < LIMITE) break;
  }
  return tudo;
}
assert.equal(paginarFalso(paginas).length, 63);
assert.equal(paginarFalso([[]]).length, 0);

// ---------- 6. janela ----------
function janelaAds(dias) {
  const dia = (d) => new Date(d).toISOString().slice(0, 10);
  const fim = Date.now() - 864e5;
  return { date_from: dia(fim - (dias - 1) * 864e5), date_to: dia(fim) };
}
const j = janelaAds(30);
const dif = (Date.parse(j.date_to) - Date.parse(j.date_from)) / 864e5;
assert.equal(dif, 29, '30 dias são 29 de intervalo entre as pontas');
assert.ok(Date.parse(j.date_to) < Date.now(), 'date_to tem de ser ontem: o dia corrente não fechou');
assert.equal(janelaAds(1).date_from, janelaAds(1).date_to);

console.log('OK — Ads: razão recalculada dos somatórios, TACOS com orgânica, '
  + 'zero vira null, soma paginada, janela até ontem');
