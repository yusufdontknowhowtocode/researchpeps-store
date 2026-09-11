const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../public/catalog.html'), 'utf8');
function source(name) {
  const match = html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
  assert.ok(match, name + ' exists');
  return match[0];
}
test('saved carts with the old spelling keep their size, quantity and purchase type', () => {
  const old = { productName: 'R3tatrutide', key: 'R3tatrutide|RT10|single|2', optionCode: 'RT10', purchaseType: 'single', vialQuantity: 2, quantity: 3 };
  const context = { products: [{ name: 'Retatrutide', aliases: ['R3tatrutide'], options: [{ code: 'RT10' }] }], loadJsonStorage: () => [old], CART_STORAGE_KEY: 'test', cart: [] };
  vm.runInNewContext(source('getProductByName') + '\n' + source('loadStorefrontState') + '\nloadStorefrontState();', context);
  assert.equal(context.cart.length, 1); assert.equal(context.cart[0].productName, 'Retatrutide');
  assert.equal(context.cart[0].key, 'Retatrutide|RT10|single|2');
  for (const key of ['optionCode', 'purchaseType', 'vialQuantity', 'quantity']) assert.equal(context.cart[0][key], old[key]);
});
test('kit savings uses selected prices and vial count rather than a fixed claim', () => {
  const context = { getSingleVialPrice: option => option.singlePrice, getRaisedKitPrice: option => option.kitPrice, getVialCount: () => 10 };
  vm.createContext(context); vm.runInContext(source('getSingleVialSavingsPercent'), context);
  assert.equal(context.getSingleVialSavingsPercent({ singlePrice: 20, kitPrice: 150 }), 25);
  assert.equal(context.getSingleVialSavingsPercent({ singlePrice: 20, kitPrice: 220 }), 0);
  assert.equal(context.getSingleVialSavingsPercent(null), 0);
});
test('the complete inline storefront script remains valid JavaScript', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) if (match[1].trim()) new vm.Script(match[1]);
});

test('live catalog replacement removes retired options, search and category entries', () => {
  const context = { products: [{ name: 'Retired', options: [{ code: 'old' }] }], researchCategories: [] };
  vm.createContext(context);
  vm.runInContext(source('mergeLiveProductStock') + '\n' + source('getProductByName') + '\n' + source('getProductByNameMap') + '\n' + source('getProductsForResearchCategory'), context);
  context.mergeLiveProductStock([{ name: 'Available', options: [{ code: 'new' }] }]);
  assert.equal(context.getProductByName('Retired'), undefined);
  assert.equal(context.getProductsForResearchCategory({ names: ['Retired', 'Available'] }).length, 1);
});

test('stale cart strength is never substituted with the first available strength', () => {
  const context = { getCartProduct: () => ({ options: [{ code: 'NEW' }] }) };
  vm.createContext(context); vm.runInContext(source('getCartOption'), context);
  assert.equal(context.getCartOption({ optionCode: 'RETIRED' }), null);
});

test('catalog fetch failure does not revive an embedded or previous catalog', async () => {
  const context = { products: [{ name: 'Stale' }], apiRequest: async () => { throw new Error('offline'); } };
  vm.createContext(context); vm.runInContext(source('loadProductStockStatus'), context);
  assert.equal(await context.loadProductStockStatus(), false);
  assert.equal(context.products.length, 0);
});
