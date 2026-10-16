// Contas do período: série por dia, tendência, curva ABC e lucro.
// O MESMO arquivo roda no servidor (require) e no navegador (<script>): o lucro da
// listagem bate com o da análise, e a análise recalcula na hora enquanto o vendedor
// digita o custo, sem ida ao servidor.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Analise = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Múltiplos de 15: cada ponto do gráfico da listagem soma dias inteiros (30 dias = 15
  // pontos de 2 dias). 150 é o máximo da série diária de visitas do ML.
  const DIAS = [15, 30, 60, 90, 150];
  const PONTOS = 15;
  const diasValidos = (n) => (DIAS.includes(Number(n)) ? Number(n) : 30);

  // Brasil sem horário de verão desde 2019: o dia do vendedor é UTC-3. Um pedido das
  // 22h de segunda não pode cair na terça do gráfico.
  const FUSO_MS = -3 * 3600e3;
  const diaLocal = (iso) => new Date(Date.parse(iso) + FUSO_MS).toISOString().slice(0, 10);

  // Os dias da janela (AAAA-MM-DD), do mais antigo até ONTEM. Hoje fica de fora: é um dia
  // pela metade, e medido numa conta real o último ponto de todo gráfico afundava
  // (visitas 409 -> 227), empurrando qualquer anúncio para "em queda".
  function diasDaJanela(dias, agora = Date.now()) {
    const hoje = Date.parse(diaLocal(new Date(agora).toISOString()));
    return Array.from({ length: dias }, (_, i) =>
      new Date(hoje - (dias - i) * 864e5).toISOString().slice(0, 10));
  }

  // { 'AAAA-MM-DD': n } -> vetor na ordem da janela; dia sem dado vale 0.
  // Medido: a série de visitas do ML NÃO vem em ordem de data e pula dias sem visita.
  const serieNaJanela = (porDia, dias, agora) => diasDaJanela(dias, agora).map((d) => porDia?.[d] || 0);

  // Série diária -> 15 pontos. Dia a dia, a venda de quem vende pouco é só ruído.
  function agrupar(serie, pontos = PONTOS) {
    if (serie.length <= pontos) return serie.slice();
    const tam = Math.ceil(serie.length / pontos);
    const out = [];
    for (let i = 0; i < serie.length; i += tam) out.push(serie.slice(i, i + tam).reduce((a, b) => a + b, 0));
    return out;
  }

  // Primeira e segunda metade da janela. Com número ímpar de dias, o do meio fica de fora.
  function metades(serie) {
    const m = Math.floor(serie.length / 2);
    const soma = (a) => a.reduce((x, y) => x + y, 0);
    return [soma(serie.slice(0, m)), soma(serie.slice(serie.length - m))];
  }

  // Segunda metade contra a primeira. Abaixo do mínimo diz "poucos dados" em vez de
  // anunciar "queda de 100%" para quem vendeu 1 unidade e depois nenhuma.
  const LIMIAR = 0.15;
  function tendencia(antes, depois, minimo) {
    if (antes + depois < minimo) return { direcao: 'poucos_dados', antes, depois, delta: null };
    if (antes === 0) return { direcao: 'alta', antes, depois, delta: null };
    const delta = (depois - antes) / antes;
    return { direcao: Math.abs(delta) < LIMIAR ? 'estavel' : delta > 0 ? 'alta' : 'queda', antes, depois, delta };
  }
  const MINIMO = { vendas: 6, visitas: 30 };

  // Curva ABC por faturamento: A soma os primeiros 80%, B os 15% seguintes, C o resto.
  // Conta o acumulado ANTES do anúncio: o que cruza a linha dos 80% ainda é A.
  // Quem não vendeu no período fica fora do mapa (a tela mostra "C · sem vendas").
  function curvaABC(faturamentoPorItem) {
    const itens = Object.entries(faturamentoPorItem).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = itens.reduce((s, [, v]) => s + v, 0);
    const out = {};
    let acum = 0;
    itens.forEach(([id, v], i) => {
      const antes = acum / total;
      out[id] = { classe: antes < 0.8 ? 'A' : antes < 0.95 ? 'B' : 'C', participacao: v / total, ranking: i + 1 };
      acum += v;
    });
    return out;
  }

  // Lucro real do período. Preço e tarifa vêm dos pedidos (o que o ML cobrou de fato);
  // frete por unidade vem dos envios reais (já dilui o pedido de várias unidades);
  // custo do produto e "outros" são por unidade; imposto é % do faturamento. Sem o custo
  // do produto não há lucro para mostrar: lucro null e falta = ['custo'].
  function economia({ faturamento = 0, unidades = 0, tarifas = 0, freteUnidade = null,
    custo = null, outros = null, impostoPct = null }) {
    const c = {
      tarifas: tarifas || 0,
      frete: freteUnidade != null ? freteUnidade * unidades : (unidades ? null : 0),
      produto: custo != null ? custo * unidades : null,
      outros: (outros || 0) * unidades,
      imposto: ((impostoPct || 0) / 100) * faturamento,
    };
    const falta = [];
    if (custo == null) falta.push('custo');
    if (c.frete == null) falta.push('frete');
    const lucro = falta.length ? null
      : faturamento - c.tarifas - c.frete - c.produto - c.outros - c.imposto;
    return { custos: c, lucro, margem: lucro != null && faturamento > 0 ? lucro / faturamento : null, falta };
  }

  // Margem de contribuição de UMA venda no preço de hoje: o que sobra para pagar a
  // estrutura depois dos custos que só existem porque a venda aconteceu. Mesma conta da
  // calculadora do Henrique Niada (HN-devs-mentoria/calculadora-margem-hn): margem =
  // lucro ÷ preço e markup = lucro ÷ custo do produto.
  // O preço mínimo é aproximado: a tarifa percentual e a fixa mudam por faixa de preço.
  // Frete desconhecido (null) não vira zero: a margem sairia otimista. Fica sem valor.
  function margemUnitaria({ preco, tarifa = 0, tarifaPct = null, tarifaFixa = 0, frete = null,
    custo = null, outros = 0, impostoPct = 0 }) {
    if (!(preco > 0)) return null;
    const imposto = ((impostoPct || 0) / 100) * preco;
    const pronto = custo != null && frete != null;
    const valor = pronto ? preco - (tarifa || 0) - (frete || 0) - custo - (outros || 0) - imposto : null;
    const fracao = 1 - (tarifaPct != null ? tarifaPct / 100 : (tarifa || 0) / preco) - (impostoPct || 0) / 100;
    const minimo = pronto && fracao > 0
      ? (custo + (outros || 0) + (frete || 0) + (tarifaPct != null ? tarifaFixa || 0 : 0)) / fracao : null;
    const falta = [custo == null && 'custo', frete == null && 'frete'].filter(Boolean);
    return { preco, tarifa: tarifa || 0, frete, custo, outros: outros || 0, imposto, falta,
      valor, pct: valor != null ? valor / preco : null, markup: valor != null && custo > 0 ? valor / custo : null,
      preco_minimo: minimo };
  }

  return { DIAS, PONTOS, MINIMO, diasValidos, diaLocal, diasDaJanela, serieNaJanela, agrupar,
    metades, tendencia, curvaABC, economia, margemUnitaria };
}));
