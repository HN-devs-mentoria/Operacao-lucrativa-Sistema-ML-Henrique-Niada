'use strict';
// node test.js  — checa a montagem do payload e as validações de entrada.
// Banco temporário: rodar teste não pode criar nem mexer no dados.sqlite do aluno.
process.env.ML_DB_FILE = require('node:path').join(require('node:os').tmpdir(), `teste-ml-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_KEY = process.env.ML_DB_KEY || 'chave-de-teste-nao-usar-em-producao';
const assert = require('node:assert');
const { buildItem } = require('./server.js');

const base = { title:'Camiseta Preta', category_id:'MLB31447', price:'89.90', quantity:'3' };

const ok = buildItem({
  ...base,
  picture_ids: ['ML-1', ' ML-2 ', ''],
  pictures: 'https://a.com/9.jpg',
  attributes: { BRAND:'Nike', MODEL:'  ', COLOR:' Preto ' },
  free_shipping: true,
});
assert.strictEqual(ok.price, 89.9);
assert.strictEqual(ok.available_quantity, 3);
assert.strictEqual(ok.currency_id, 'BRL');
assert.strictEqual(ok.buying_mode, 'buy_it_now');
assert.strictEqual(ok.title, 'Camiseta Preta');
assert.strictEqual(ok.family_name, undefined, 'conta comum manda title, nunca family_name');
// conta "User Products": o ML exige family_name e recusa title (medido com /items/validate)
const up = buildItem(base, { userProduct: true });
assert.strictEqual(up.family_name, 'Camiseta Preta');
assert.ok(!('title' in up), 'com family_name, title não pode ir junto');
assert.deepStrictEqual(ok.pictures, [{id:'ML-1'},{id:'ML-2'},{source:'https://a.com/9.jpg'}]); // ids primeiro, vazio descartado
assert.deepStrictEqual(ok.attributes, [{id:'BRAND',value_name:'Nike'},{id:'COLOR',value_name:'Preto'}]); // vazio descartado, valor trimado
assert.strictEqual(ok.shipping.free_shipping, true);
assert.strictEqual(ok.shipping.local_pick_up, false);

const rejeita = (form, trecho) => assert.throws(() => buildItem(form), (e) => e.status === 400 && e.message.includes(trecho), trecho);
rejeita({ ...base, title:'' }, 'Título é obrigatório');
rejeita({ ...base, title:'x'.repeat(61) }, '60 caracteres');
rejeita({ ...base, category_id:'' }, 'Categoria');
rejeita({ ...base, price:'0' }, 'Preço');
rejeita({ ...base, price:'abc' }, 'Preço');
rejeita({ ...base, quantity:'0' }, 'Quantidade');
rejeita({ ...base, quantity:'1.5' }, 'Quantidade');
rejeita({ ...base, pictures:'http://inseguro.com/1.jpg' }, 'https');

console.log('OK — payload e validações');

// ---- buildEdicao: lista fechada de campos ----
const { buildEdicao } = require('./server.js');

const e1 = buildEdicao({ price: '199.90', available_quantity: '0', status: 'paused' });
assert.deepStrictEqual(e1, { price: 199.9, available_quantity: 0, status: 'paused' });
assert.strictEqual(buildEdicao({ available_quantity: 0 }).available_quantity, 0, 'estoque 0 é válido (pausa)');
assert.deepStrictEqual(buildEdicao({ picture_ids: ['A', 'B'] }).pictures, [{ id: 'A' }, { id: 'B' }]);

// campo fora da lista não passa
assert.deepStrictEqual(Object.keys(buildEdicao({ price: 10, seller_id: 9, id: 'MLB1', health: 1 })), ['price']);

const recusa = (f, t) => assert.throws(() => buildEdicao(f), (e) => e.status === 400 && e.message.includes(t), t);
recusa({}, 'Nada para alterar');
recusa({ price: 0 }, 'Preço');
recusa({ price: -5 }, 'Preço');
recusa({ available_quantity: -1 }, 'Estoque');
recusa({ available_quantity: 1.5 }, 'Estoque');
recusa({ title: '   ' }, 'vazio');
recusa({ title: 'x'.repeat(61) }, '60 caracteres');
recusa({ status: 'deleted' }, 'Status inválido');

// campos completos da modal (todos medidos como aceitos pela API do ML)
const cheio = buildEdicao({
  title: '  iMac 27  ', warranty: 'Garantia de 3 meses', condition: 'used',
  category_id: 'MLB1652', video_id: 'abc123', seller_custom_field: 'SKU-9',
  picture_ids: ['P3', 'P1', 'P2'],
  attributes: { BRAND: 'Apple', MODEL: '  ', COLOR: ' Prata ' },
  shipping: { mode: 'me2', free_shipping: true },
});
assert.strictEqual(cheio.title, 'iMac 27', 'título é trimado');
assert.strictEqual(cheio.warranty, 'Garantia de 3 meses');
assert.strictEqual(cheio.condition, 'used');
assert.strictEqual(cheio.category_id, 'MLB1652');
assert.strictEqual(cheio.video_id, 'abc123');
assert.strictEqual(cheio.seller_custom_field, 'SKU-9');
assert.deepStrictEqual(cheio.pictures, [{id:'P3'},{id:'P1'},{id:'P2'}], 'a ordem enviada é a ordem no anúncio');
assert.deepStrictEqual(cheio.attributes, [{id:'BRAND',value_name:'Apple'},{id:'COLOR',value_name:'Prata'}]);
assert.deepStrictEqual(cheio.shipping, { mode:'me2', free_shipping:true, local_pick_up:false });

// campos que limpam
assert.strictEqual(buildEdicao({ video_id: '' }).video_id, null, 'vídeo vazio remove o vídeo');
assert.strictEqual(buildEdicao({ seller_custom_field: '' }).seller_custom_field, null, 'SKU vazio limpa');

// listing_type_id nunca sai por aqui: tem endpoint próprio
assert.deepStrictEqual(Object.keys(buildEdicao({ title:'x', listing_type_id:'gold_pro' })), ['title']);

recusa({ condition: 'novinho' }, 'Condição inválida');
recusa({ category_id: 'xyz' }, 'Categoria inválida');
recusa({ picture_ids: [] }, 'ao menos uma foto');
recusa({ warranty: 'g'.repeat(256) }, 'Garantia passa');
recusa({ warranty: '  ' }, 'Garantia não pode');
recusa({ seller_custom_field: 's'.repeat(61) }, 'SKU passa');
recusa({ shipping: { mode: 'drone' } }, 'Modo de envio inválido');

console.log('OK — edição de anúncio (campos completos)');

// sale_terms (garantia) entram como os atributos: pares id/valor, vazios descartados
const st = buildEdicao({ sale_terms: { WARRANTY_TYPE: 'Garantia do vendedor', WARRANTY_TIME: ' 3 meses ', X: '' } });
assert.deepStrictEqual(st.sale_terms,
  [{id:'WARRANTY_TYPE', value_name:'Garantia do vendedor'}, {id:'WARRANTY_TIME', value_name:'3 meses'}]);
assert.strictEqual(buildEdicao({ title:'x', sale_terms: {} }).sale_terms, undefined, 'sale_terms vazio não vai');

console.log('OK — sale_terms');
