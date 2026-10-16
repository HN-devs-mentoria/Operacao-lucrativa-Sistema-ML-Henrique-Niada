'use strict';
// node test-analise.js — contas do período (public/analise.js) e a cópia local das vendas
// (db.js): janela de dias completos, tendência, curva ABC, lucro real e frete por unidade.
process.env.ML_DB_FILE = require('node:path').join(require('node:os').tmpdir(), `teste-analise-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_KEY = 'chave-de-teste-nao-usar-em-producao';
const assert = require('node:assert');
const A = require('./public/analise.js');
const D = require('./db.js');
const perto = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// ---------- janela ----------
// 19/09 às 01h de Brasília ainda é 19/09 (04h UTC); às 23h de 18/09 (02h UTC de 19/09), é 18/09.
const agora = Date.parse('2026-09-19T04:00:00Z');
const dias = A.diasDaJanela(30, agora);
assert.strictEqual(dias.length, 30);
assert.strictEqual(dias.at(-1), '2026-09-18', 'hoje (dia pela metade) fica de fora');
assert.strictEqual(dias[0], '2026-08-20');
assert.strictEqual(A.diasDaJanela(15, Date.parse('2026-09-19T02:00:00Z')).at(-1), '2026-09-17',
  '23h de 18/09 em Brasília: "hoje" ainda é 18/09');
assert.strictEqual(A.diaLocal('2026-09-19T01:30:00.000Z'), '2026-09-18', 'pedido das 22h30 cai no dia local');
assert.strictEqual(A.diasValidos('45'), 30, 'período fora da lista volta ao padrão');
assert.strictEqual(A.diasValidos('150'), 150);

// série fora de ordem e com dia faltando (como o ML devolve as visitas)
const serie = A.serieNaJanela({ '2026-09-18': 5, '2026-08-20': 2, '2026-09-19': 99 }, 30, agora);
assert.strictEqual(serie.length, 30);
assert.strictEqual(serie[0], 2); assert.strictEqual(serie[29], 5);
assert.strictEqual(serie.reduce((a, b) => a + b, 0), 7, 'hoje (99) não entra na janela');

// 30 dias -> 15 pontos de 2 dias; 150 -> 15 de 10
assert.deepStrictEqual(A.agrupar([1, 1, 2, 2, 3, 3]), [1, 1, 2, 2, 3, 3], 'curta fica como está');
const g = A.agrupar(Array.from({ length: 30 }, (_, i) => i));
assert.strictEqual(g.length, 15); assert.strictEqual(g[0], 1); assert.strictEqual(g[14], 57);
assert.strictEqual(A.agrupar(new Array(150).fill(1)).every((v) => v === 10), true);

assert.deepStrictEqual(A.metades([1, 2, 3, 4]), [3, 7]);
assert.deepStrictEqual(A.metades([1, 2, 100, 3, 4]), [3, 7], 'dia do meio fica de fora');

// ---------- tendência ----------
assert.strictEqual(A.tendencia(1, 0, 6).direcao, 'poucos_dados', '1 venda e depois nenhuma não é "queda de 100%"');
assert.strictEqual(A.tendencia(0, 8, 6).direcao, 'alta');
assert.strictEqual(A.tendencia(0, 8, 6).delta, null);
assert.strictEqual(A.tendencia(100, 86, 6).direcao, 'estavel', '−14% ainda é estável');
assert.strictEqual(A.tendencia(100, 85, 6).direcao, 'queda', '−15% é queda');
assert.strictEqual(A.tendencia(100, 120, 6).direcao, 'alta');
perto(A.tendencia(398, 340, 6).delta, -58 / 398, 'delta');

// ---------- curva ABC ----------
const abc = A.curvaABC({ a1: 500, a2: 300, b1: 100, b2: 50, c1: 30, c2: 20, zero: 0 });
assert.strictEqual(abc.a1.classe, 'A'); assert.strictEqual(abc.a2.classe, 'A', 'o que cruza os 80% ainda é A');
assert.strictEqual(abc.b1.classe, 'B'); assert.strictEqual(abc.b2.classe, 'B');
assert.strictEqual(abc.c1.classe, 'C'); assert.strictEqual(abc.c2.classe, 'C');
assert.strictEqual(abc.zero, undefined, 'quem não vendeu fica fora da curva');
assert.strictEqual(abc.a1.ranking, 1); perto(abc.a1.participacao, 0.5, 'participação');
assert.strictEqual(A.curvaABC({ so: 10 }).so.classe, 'A');
assert.deepStrictEqual(A.curvaABC({}), {});

// ---------- lucro real ----------
// 10 un. a R$ 50 = R$ 500; tarifas R$ 60; frete R$ 4/un.; custo R$ 20/un.; outros R$ 1/un.; imposto 6%
const e = A.economia({ faturamento: 500, unidades: 10, tarifas: 60, freteUnidade: 4, custo: 20, outros: 1, impostoPct: 6 });
perto(e.custos.imposto, 30, 'imposto sobre o faturamento');
perto(e.lucro, 500 - 60 - 40 - 200 - 10 - 30, 'lucro');
perto(e.margem, 160 / 500, 'margem');
assert.deepStrictEqual(e.falta, []);
const semCusto = A.economia({ faturamento: 500, unidades: 10, tarifas: 60, freteUnidade: 4 });
assert.strictEqual(semCusto.lucro, null, 'sem custo do produto não há lucro para mostrar');
assert.deepStrictEqual(semCusto.falta, ['custo']);
assert.deepStrictEqual(A.economia({ faturamento: 500, unidades: 10, custo: 20 }).falta, ['frete'],
  'vendeu e não se sabe o frete: não inventa lucro');
const parado = A.economia({ custo: 20 });
assert.strictEqual(parado.lucro, 0, 'sem venda no período: lucro zero, não "falta frete"');
assert.strictEqual(parado.margem, null);

// margem de contribuição de uma venda (números de um anúncio real, 19/09/2026)
const u = A.margemUnitaria({ preco: 69.9, tarifa: 8.04, tarifaPct: 11.5, tarifaFixa: 0, frete: 8.52,
  custo: 30, outros: 1.5, impostoPct: 6 });
perto(u.imposto, 4.194, 'imposto unitário');
perto(u.valor, 69.9 - 8.04 - 8.52 - 30 - 1.5 - 4.194, 'margem de contribuição');
perto(u.markup, u.valor / 30, 'markup = lucro ÷ custo');
// no preço mínimo a margem zera (com a tarifa percentual de hoje)
const min = A.margemUnitaria({ preco: u.preco_minimo, tarifa: u.preco_minimo * 0.115, tarifaPct: 11.5,
  frete: 8.52, custo: 30, outros: 1.5, impostoPct: 6 });
perto(min.valor, 0, 'preço mínimo zera a margem');
assert.strictEqual(A.margemUnitaria({ preco: 50, tarifa: 5, frete: 3 }).valor, null, 'sem custo, sem margem');
const semFrete = A.margemUnitaria({ preco: 50, tarifa: 5, custo: 10 });
assert.strictEqual(semFrete.valor, null, 'frete desconhecido não vira zero');
assert.deepStrictEqual(semFrete.falta, ['frete']);
assert.strictEqual(A.margemUnitaria({ preco: 50, tarifa: 5, custo: 10, frete: 0 }).valor, 35, 'frete zero (fora do Mercado Envios) é conhecido');
assert.strictEqual(A.margemUnitaria({ preco: 0, custo: 1 }), null);

// ---------- cópia local das vendas ----------
const CONTA = 555;
const linha = (order_id, item_id, data, extra = {}) => ({ order_id, item_id, ml_user_id: CONTA, data,
  status: 'paid', quantidade: 1, preco_unit: 100, tarifa_unit: 12, envio_id: order_id + 1000, ...extra });
D.vendasGravar([
  linha(1, 'MLB1', '2026-08-25T15:00:00.000Z'),                                   // 1ª metade
  linha(2, 'MLB1', '2026-09-10T15:00:00.000Z', { quantidade: 3 }),                // 2ª metade
  linha(3, 'MLB1', '2026-09-11T15:00:00.000Z'),
  linha(4, 'MLB2', '2026-09-12T15:00:00.000Z', { preco_unit: 40, tarifa_unit: 5 }),
  linha(5, 'MLB1', '2026-09-19T12:00:00.000Z'),                                   // hoje: fora
  linha(6, 'MLB1', '2026-08-19T12:00:00.000Z'),                                   // antes da janela
  linha(7, 'MLB2', '2026-09-13T15:00:00.000Z', { status: 'cancelled' }),          // não é venda
]);
const j = { de: '2026-08-20T03:00:00.000Z', meio: '2026-09-04T03:00:00.000Z', ate: '2026-09-19T03:00:00.000Z' };
const r = Object.fromEntries(D.vendasResumo(CONTA, j).map((x) => [x.item_id, x]));
assert.strictEqual(r.MLB1.unidades, 5, 'só a janela: nem hoje nem antes dela');
assert.strictEqual(r.MLB1.pedidos, 3);
perto(r.MLB1.faturamento, 500, 'faturamento = quantidade × preço de cada pedido');
perto(r.MLB1.tarifas, 60, 'sale_fee é por unidade: 5 un. × 12');
assert.strictEqual(r.MLB1.antes, 1); assert.strictEqual(r.MLB1.depois, 4);
assert.strictEqual(r.MLB2.unidades, 1, 'pedido cancelado não conta');

// o pedido muda de status na sincronização seguinte: o mesmo registro é atualizado
D.vendasGravar([linha(4, 'MLB2', '2026-09-12T15:00:00.000Z', { status: 'cancelled', preco_unit: 40 })]);
assert.strictEqual(D.vendasResumo(CONTA, j).find((x) => x.item_id === 'MLB2'), undefined, 'cancelou depois: sai da conta');
assert.strictEqual(D.vendasDiarias(['MLB1'], j).length, 3);

// frete por unidade: envio de 3 unidades custou 18 e o de 1 unidade custou 6 -> 24 / 4 = 6
assert.deepStrictEqual(D.enviosSemFrete('MLB1', j, 10).sort(), [1001, 1002, 1003]);
D.freteGravar(CONTA, 1002, 18);
D.freteGravar(CONTA, 1003, 6);
const f = D.fretePorUnidade('MLB1', j);
assert.strictEqual(f.amostra, 2);
perto(f.custo / f.unidades, 6, 'frete por unidade');
assert.deepStrictEqual(D.enviosSemFrete('MLB1', j, 10), [1001], 'envio já consultado não é consultado de novo');

// custos e imposto
assert.strictEqual(D.custoObter('MLB1'), null);
D.custoGravar(CONTA, 'MLB1', { custo: 30, outros: 1.5 });
assert.deepStrictEqual(D.custosDe(['MLB1', 'MLB9']), { MLB1: { custo: 30, outros: 1.5 } });
D.custoGravar(CONTA, 'MLB1', { custo: 32, outros: null });
assert.strictEqual(D.custoObter('MLB1').custo, 32, 'atualizar o custo sobrescreve');
assert.strictEqual(D.impostoLer(CONTA), null);
D.impostoGravar(CONTA, 6.5);
assert.strictEqual(D.impostoLer(CONTA), 6.5);
assert.strictEqual(D.impostoLer(999), null, 'imposto é por conta');

console.log('OK — janela, tendência, curva ABC, lucro real, frete por unidade e cópia local das vendas');
