const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-orders-test-'));
const sent = []; const sessions = new Map(); let server, db, base, adminCookie, buyerCookie;
const RealStripe = require('stripe');
const stripe = new RealStripe('sk_test_local');
stripe.checkout.sessions.create = async (options) => {
  const session = { id: 'cs_' + options.metadata.orderId, metadata: options.metadata, currency: 'usd', amount_total: options.line_items.reduce((sum, line) => sum + line.quantity * line.price_data.unit_amount, 0), payment_status: 'unpaid', status: 'open', url: 'https://example.com/checkout', createOptions: options };
  sessions.set(session.id, session); return session;
};
stripe.checkout.sessions.retrieve = async id => sessions.get(id);
Object.assign(process.env, { NODE_ENV: 'test', SESSION_SECRET: 'test-session-secret-not-for-production', DATABASE_PATH: path.join(tempDir, 'test.sqlite'), ADMIN_EMAILS: 'admin@example.com', SMTP_HOST: 'fake.local', MAIL_FROM: 'orders@example.com', ADMIN_ORDER_NOTIFY_EMAIL: 'owner@example.com', STRIPE_SECRET_KEY: 'sk_test_local', STRIPE_WEBHOOK_SECRET: 'whsec_test_only', PUBLIC_URL: 'https://example.com', PAYPAL_PAYMENT_EMAIL: 'payments@example.com' });
const sourceFixtures = Object.fromEntries(require('../data/products.json').filter(p=>p.active).flatMap(p=>p.options.filter(o=>o.active).map(o=>[o.code,{productName:p.name,spec:o.spec,vialsPerKit:10,preferred:{source:'PRIVATE_TEST_SOURCE',code:'PRIVATE_SUPPLIER_CODE',supplierCost:100,shipping:30,landedCost:130},fallback:{source:'PRIVATE_BACKUP',code:'BACKUP_CODE',supplierCost:112,shipping:30,landedCost:142},options:[{source:'PRIVATE_TEST_SOURCE',code:'PRIVATE_SUPPLIER_CODE',supplierCost:100,shipping:30,landedCost:130},{source:'PRIVATE_BACKUP',code:'BACKUP_CODE',supplierCost:112,shipping:30,landedCost:142}]}])));
process.env.INTERNAL_SOURCING_JSON = JSON.stringify({version:'integration-fixture',fulfillmentShipping:{PRIVATE_TEST_SOURCE:{type:'shipment',fee:20},PRIVATE_BACKUP:{type:'shipment',fee:0}},variants:sourceFixtures});
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'stripe') return function() { return stripe; };
  if (name === 'nodemailer') return { createTransport: () => ({ async verify() {}, async sendMail(mail) { sent.push(mail); return { accepted: [mail.to] }; } }) };
  return originalLoad.call(this, name, ...args);
};
const backend = require('../server');
Module._load = originalLoad;
db = backend.db;
async function api(url, method = 'GET', body, cookie) {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const checkout = { customer: { name: 'Checkout Buyer', email: 'shipping@example.com', phone: '+1 555 010 9999' }, shipping: { address: '123 Fixture St, Suite 8', city: 'Lansdale', state: 'PA', zip: '19446', country: 'United States' }, notes: 'Side door <img src=x onerror=alert(1)>', researchUseAccepted: true, paymentMethod: 'paypal', items: [{ productName: 'R3tatrutide', optionCode: 'RT10', quantity: 1, purchaseType: 'kit' }, { productName: 'Semaglutide', optionCode: 'SM10', quantity: 1, vialQuantity: 1, purchaseType: 'single' }] };
before(async () => {
  server = backend.app.listen(0); await new Promise(resolve => server.once('listening', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  adminCookie = (await api('/api/auth/register', 'POST', { name: 'Admin', email: 'admin@example.com', password: 'Test-password-123' })).cookie;
  buyerCookie = (await api('/api/auth/register', 'POST', { name: 'Buyer', email: 'buyer@example.com', password: 'Test-password-123' })).cookie;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
test('admin API rejects unauthenticated and non-admin accounts', async () => {
  assert.ok([401, 403].includes((await api('/api/admin/orders')).status));
  assert.equal((await api('/api/admin/orders', 'GET', null, buyerCookie)).status, 403);
});
test('pending manual order stays private; confirmation sends one complete basket fulfillment email', async () => {
  const response = await api('/api/orders', 'POST', checkout, buyerCookie);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const order = response.body.order;
  assert.equal(order.status, 'Awaiting PayPal Payment');
  assert.equal(order.items[0].name, 'Retatrutide');
  const currentCatalog = await api('/api/products');
  assert.ok(currentCatalog.body.products.some(p => p.name === 'Retatrutide'));
  assert.ok(!currentCatalog.body.products.some(p => p.name === 'R3tatrutide'));
  const search = await api('/api/admin/orders?q=RT10', 'GET', null, adminCookie);
  assert.equal(search.body.orders[0].id, order.id);
  assert.equal(search.body.orders[0].items[0].quantity, 1);
  assert.deepEqual(search.body.orders[0].shipping, checkout.shipping);
  assert.equal(search.body.orders[0].customer.email, checkout.customer.email);
  assert.ok(!sent.some(mail => mail.to === 'owner@example.com' && mail.subject.includes(order.id)));
  assert.equal(search.body.orders[0].ownerNotification, null);
  assert.equal((await api('/api/admin/orders/' + order.id + '/notify-owner', 'POST', {}, adminCookie)).status, 409);
  const beforeConfirmation = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  await api('/api/admin/orders/' + order.id + '/status', 'PATCH', {status:'Payment Received - Processing'}, adminCookie);
  const afterConfirmation = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  for(const key of Object.keys(beforeConfirmation).filter(k=>!['status','updated_at'].includes(k)))assert.deepEqual(afterConfirmation[key], beforeConfirmation[key], key);
  const owner = sent.find(mail => mail.to === 'owner@example.com' && mail.subject.includes(order.id));
  assert.ok(owner); assert.ok(owner.text.includes('Suite 8')); assert.ok(owner.text.includes('RT10'));
  assert.ok(!owner.html.includes('<img src=x'));
  assert.equal((await api('/api/admin/orders?q='+order.id, 'GET', null, adminCookie)).body.orders[0].ownerNotification.status, 'sent');
  const customer = sent.find(mail => mail.to === 'shipping@example.com' && mail.subject.includes(order.id));
  assert.ok(customer); assert.ok(customer.text.includes('payments@example.com'));
  assert.ok(owner.text.includes('PRIVATE_TEST_SOURCE'));
  assert.ok(owner.text.includes('Supplier kit price: $100.00'));
  assert.ok(owner.text.includes('supplier kits $200.00 USD + inbound $20.00 USD = $220.00 USD'));
  assert.ok(owner.text.includes('Single vial purchase'));
  assert.ok(owner.text.includes('10-vial kit'));
  assert.ok(owner.text.includes('/admin?order='+order.id));
  for(const value of [...Object.values(checkout.customer), ...Object.values(checkout.shipping), 'Payment status: Confirmed'])assert.ok(owner.text.includes(value), value);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempDir,'order-sourcing',order.id+'.json'))).fulfillmentPlan.totalLandedCost,220);
  assert.ok(!JSON.stringify(customer).includes('PRIVATE_TEST_SOURCE'));
  assert.ok(!JSON.stringify(response.body).includes('PRIVATE_TEST_SOURCE'));
  assert.ok(!JSON.stringify(currentCatalog.body).includes('PRIVATE_TEST_SOURCE'));
  const snapshotPath = path.join(tempDir, 'order-sourcing', order.id + '.json');
  assert.ok(fs.existsSync(snapshotPath));
  assert.equal((await api('/api/admin/orders/' + order.id + '/sourcing', 'GET', null, buyerCookie)).status, 403);
  assert.ok((await api('/api/admin/orders/' + order.id + '/sourcing', 'GET', null, adminCookie)).body.text.includes('PRIVATE_TEST_SOURCE'));
  const savedSnapshot = fs.readFileSync(snapshotPath, 'utf8');
  const before = sent.filter(mail => mail.to === 'shipping@example.com').length;
  assert.equal((await api('/api/admin/orders/' + order.id + '/notify-owner', 'POST', {}, adminCookie)).status, 200);
  assert.equal(sent.filter(mail => mail.to === 'shipping@example.com').length, before);
  assert.equal(fs.readFileSync(snapshotPath, 'utf8'), savedSnapshot);
  await api('/api/admin/orders/' + order.id + '/status', 'PATCH', {status:'Payment Received - Processing'}, adminCookie);
  assert.equal(sent.filter(mail=>mail.to==='owner@example.com' && mail.subject.includes(order.id)).length,1);
  assert.equal((await api('/api/admin/orders/' + order.id + '/notify-owner', 'POST', {}, buyerCookie)).status, 403);
});
test('card creation backs up checkout details in Stripe; unpaid completion is not paid; verified repeat events do not reset shipped orders', async () => {
  const response = await api('/api/checkout/stripe', 'POST', { ...checkout, paymentMethod: 'stripe' }, buyerCookie);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const id = response.body.order.id; const session = sessions.get('cs_' + id);
  assert.ok(!sent.some(mail => mail.to === 'owner@example.com' && mail.subject.includes(id)));
  assert.equal(session.createOptions.customer_email, checkout.customer.email);
  assert.ok(!JSON.stringify(session.createOptions).includes('PRIVATE_TEST_SOURCE'));
  assert.equal(session.createOptions.client_reference_id, id);
  assert.equal(session.createOptions.metadata.orderId, id);
  assert.equal(session.createOptions.payment_intent_data.metadata.orderId, id);
  assert.deepEqual(session.createOptions.payment_intent_data.shipping, {
    name: checkout.customer.name,
    phone: checkout.customer.phone,
    address: {
      line1: checkout.shipping.address,
      city: checkout.shipping.city,
      state: checkout.shipping.state,
      postal_code: checkout.shipping.zip,
      country: 'US'
    }
  });
  session.status = 'complete';
  const unpaid = await api('/api/checkout/stripe/confirm', 'POST', { orderId: id }, buyerCookie);
  assert.equal(unpaid.body.order.status, 'Pending Payment');
  async function webhook(paymentSession) {
    const payload = JSON.stringify({ id: 'evt_local', type: 'checkout.session.completed', data: { object: paymentSession } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_only' });
    return fetch(base + '/api/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
  }
  assert.equal((await webhook({ ...session, metadata: {} })).status, 200);
  await webhook(session);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'Pending Payment');
  session.payment_status = 'paid';
  await webhook({ ...session, amount_total: 1 });
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'Pending Payment');
  await webhook(session);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'Paid - Processing');
  assert.equal(sent.filter(mail => mail.to === 'owner@example.com' && mail.subject.includes(id) && mail.subject.startsWith('Payment confirmed')).length, 1);
  await api('/api/admin/orders/' + id + '/status', 'PATCH', { status: 'Shipped', trackingCarrier: 'FedEx', trackingNumber: 'TEST123' }, adminCookie);
  await webhook(session);
  await api('/api/checkout/stripe/confirm', 'POST', { orderId: id }, buyerCookie);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'Shipped');
  assert.equal(sent.filter(mail => mail.to === 'owner@example.com' && mail.subject.includes(id) && mail.subject.startsWith('Payment confirmed')).length, 1);
  await api('/api/admin/orders/' + id + '/status', 'PATCH', { status:'Payment Received - Processing' }, adminCookie);
  const keptTracking=db.prepare('SELECT tracking_number, tracking_carrier FROM orders WHERE id = ?').get(id);
  assert.deepEqual(keptTracking,{tracking_number:'TEST123',tracking_carrier:'FedEx'});
});

test('confirmed Stripe retries on a cancelled order do not reactivate or send fulfillment',async()=>{
 const response=await api('/api/checkout/stripe','POST',{...checkout,paymentMethod:'stripe'},buyerCookie);
 const id=response.body.order.id,session=sessions.get('cs_'+id);
 await api('/api/admin/orders/'+id+'/status','PATCH',{status:'Cancelled'},adminCookie);
 session.status='complete';session.payment_status='paid';
 const before=sent.length;
 await api('/api/checkout/stripe/confirm','POST',{orderId:id},buyerCookie);
 await api('/api/checkout/stripe/confirm','POST',{orderId:id},buyerCookie);
 assert.equal(sent.length,before);
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status,'Cancelled');
 assert.equal(db.prepare("SELECT count(*) n FROM owner_order_emails WHERE order_id=? AND event='paid'").get(id).n,0);
});

test('retired variants are absent everywhere and rejected before creating an order or payment session', async () => {
  const catalog = require('../data/products.json');
  const publicResponse = await api('/api/products');
  const published = publicResponse.body.products;
  assert.equal(catalog.length, 79);
  assert.equal(catalog.reduce((n, p) => n + p.options.length, 0), 150);
  assert.equal(published.reduce((n, p) => n + p.options.length, 0), 105);
  for (const p of published) for (const o of p.options) {
    assert.ok(!('price' in o));
    assert.ok(!('availabilityStatus' in o));
    assert.ok(!('active' in o));
  }
  const priorOrders = db.prepare('SELECT * FROM orders ORDER BY id').all();
  const priorItems = db.prepare('SELECT * FROM order_items ORDER BY id').all();
  const priorSessions = sessions.size;
  for (const p of catalog) for (const o of p.options.filter(o => !o.active)) {
    assert.ok(!published.find(x => x.name === p.name)?.options.some(x => x.code === o.code));
    for (const endpoint of ['/api/cart/quote', '/api/orders', '/api/checkout/stripe']) {
      const response = await api(endpoint, 'POST', { ...checkout, items: [{ productName: p.name, optionCode: o.code, quantity: 1, purchaseType: 'kit' }] }, buyerCookie);
      assert.equal(response.status, 400, p.name + ' ' + o.code + ' ' + endpoint);
    }
  }
  assert.equal(sessions.size, priorSessions);
  assert.deepEqual(db.prepare('SELECT * FROM orders ORDER BY id').all(), priorOrders);
  assert.deepEqual(db.prepare('SELECT * FROM order_items ORDER BY id').all(), priorItems);
  assert.equal((await fetch(base + '/product/igf-des')).status, 404);
  assert.equal((await fetch(base + '/product/hgh?option=H15')).status, 404);
  assert.equal((await fetch(base + '/product/retatrutide?option=RT10')).status, 200);
});

test('all single and kit cart quotes use the current retail prices without rewriting stored orders', async () => {
  const catalog = require('../data/products.json');
  const expected = catalog.filter(p => p.active).flatMap(p => p.options.filter(o => o.active).flatMap(o =>
    ['single', 'kit'].map(purchaseType => ({ productName: p.name, optionCode: o.code, purchaseType, vialQuantity: 1, quantity: 1, retail: purchaseType === 'single' ? o.singlePrice : o.kitPrice }))));
  const ordersBefore = db.prepare('SELECT * FROM orders ORDER BY id').all();
  const itemsBefore = db.prepare('SELECT * FROM order_items ORDER BY id').all();
  const sessionsBefore = sessions.size;
  const response = await api('/api/cart/quote', 'POST', { paymentMethod: 'paypal', items: expected.map(({retail, ...item}) => ({ ...item, unitPrice: 0.01 })) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.items.length, 210);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(response.body.items[i].optionCode, expected[i].optionCode);
    assert.equal(response.body.items[i].unitPrice, expected[i].retail);
    assert.equal(response.body.items[i].lineTotal, expected[i].retail);
  }
  assert.equal(sessions.size, sessionsBefore);
  assert.deepEqual(db.prepare('SELECT * FROM orders ORDER BY id').all(), ordersBefore);
  assert.deepEqual(db.prepare('SELECT * FROM order_items ORDER BY id').all(), itemsBefore);
});

test('historical retired item snapshots remain visible in customer and admin order views', async () => {
  const response = await api('/api/orders', 'POST', checkout, buyerCookie);
  const id = response.body.order.id;
  // Only this disposable fixture is changed to simulate an order placed before retirement.
  db.prepare('UPDATE order_items SET product_name=?, option_code=?, spec=?, unit_price_cents=?, quantity=?, line_total_cents=? WHERE order_id=?')
    .run('IGF-DES', 'IGD', 'Historical 2mg*10 vials', 12345, 2, 24690, id);
  db.prepare('UPDATE orders SET tracking_number=?, tracking_carrier=?, status=? WHERE id=?').run('OLD-TRACKING', 'FedEx', 'Shipped', id);
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const item = db.prepare('SELECT * FROM order_items WHERE order_id=?').get(id);
  for (const endpoint of ['/api/orders', '/api/admin/orders']) {
    const result = await api(endpoint, 'GET', null, endpoint.includes('/admin/') ? adminCookie : buyerCookie);
    const old = result.body.orders.find(o => o.id === id);
    assert.equal(old.items[0].name, item.product_name);
    assert.equal(old.items[0].spec, item.spec);
    assert.equal(old.items[0].unitPrice, 123.45);
    assert.equal(old.items[0].quantity, 2);
    assert.deepEqual(old.customer, JSON.parse(row.customer_json));
    assert.deepEqual(old.shipping, JSON.parse(row.shipping_json));
    assert.equal(old.trackingNumber, row.tracking_number);
    assert.equal(old.trackingCarrier, row.tracking_carrier);
    assert.equal(old.status, row.status);
    assert.equal(old.paymentMethod, row.payment_method);
    assert.equal(old.createdAt, row.created_at);
    assert.equal(old.updatedAt, row.updated_at);
  }
  assert.deepEqual(db.prepare('SELECT * FROM orders WHERE id=?').get(id), row);
  assert.deepEqual(db.prepare('SELECT * FROM order_items WHERE order_id=?').get(id), item);
});
