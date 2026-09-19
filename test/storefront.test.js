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

test('admin card shows complete items, the four fulfillment actions and direct-order search',()=>{
 const elements={adminOrdersResults:{},adminOrderFilters:{},adminOrderCount:{}};
 const context={document:{getElementById:id=>elements[id]},adminOrders:[{id:'RP-FIX',status:'Paid - Processing',customer:{name:'Fixture',email:'fixture@example.com'},shipping:{address:'123 St\nUnit 4'},items:[{name:'Fixture material',spec:'1 vial • 10mg each',code:'X',quantity:2,unitPrice:50,lineTotal:100}],total:115}],adminOrderFilter:'all',adminOrderSort:'newest',adminOrderGroups:[['all','All']],URLSearchParams,window:{location:{search:'?order=RP-FIX'}},formatMoney:n=>'$'+Number(n||0).toFixed(2)};
 vm.createContext(context);
 for(const name of ['escapeHtml','escapeForAttribute','adminOrderGroup','getAdminStatusOptions','adminPackLabel','renderAdminOrderResults','renderAdminDashboardShell'])vm.runInContext(source(name),context);
 context.renderAdminOrderResults();
 for(const text of ['Fixture material','1 vial • 10mg each','Single vial purchase','Qty 2','$50.00','$100.00','COPY SHIPPING ADDRESS','COPY ORDER #','SOURCE RECOMMENDATION','ADD TRACKING'])assert.ok(elements.adminOrdersResults.innerHTML.includes(text),text);
 assert.ok(context.renderAdminDashboardShell().includes('value="RP-FIX"'));
 assert.equal(context.adminPackLabel({spec:'10mg*10 vials'}),'10-vial kit');
});

test('copy shipping address preserves multiline address without adding contact metadata',async()=>{
 let copied;
 const context={adminOrders:[{id:'RP-FIX',customer:{name:'Fixture Buyer',email:'private@example.com',phone:'555'},shipping:{address:'123 St\nUnit 4',city:'Lansdale',state:'PA',zip:'19446',country:'United States'}}],navigator:{clipboard:{writeText:async text=>{copied=text;}}},document:{getElementById:()=>({})}};
 vm.createContext(context);vm.runInContext(source('copyAdminShipping'),context);
 await context.copyAdminShipping('RP-FIX');
 assert.equal(copied,'Fixture Buyer\n123 St\nUnit 4\nLansdale, PA 19446\nUnited States');
});
