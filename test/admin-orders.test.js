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
const checkout = { customer: { name: 'Checkout Buyer', email: 'shipping@example.com', phone: '+1 555 010 9999' }, shipping: { address: '123 Fixture St, Suite 8', city: 'Lansdale', state: 'PA', zip: '19446', country: 'United States' }, notes: 'Side door <img src=x onerror=alert(1)>', researchUseAccepted: true, paymentMethod: 'paypal', items: [{ productName: 'R3tatrutide', optionCode: 'RT10', quantity: 1, purchaseType: 'kit' }] };
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
test('manual order is persisted, fully visible, searchable by product/SKU, and owner notified', async () => {
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
  const owner = sent.find(mail => mail.to === 'owner@example.com' && mail.subject.includes(order.id));
  assert.ok(owner); assert.ok(owner.text.includes('Suite 8')); assert.ok(owner.text.includes('RT10'));
  assert.ok(!owner.html.includes('<img src=x'));
  assert.equal(search.body.orders[0].ownerNotification.status, 'sent');
  const customer = sent.find(mail => mail.to === 'shipping@example.com' && mail.subject.includes(order.id));
  assert.ok(customer); assert.ok(customer.text.includes('payments@example.com'));
  const before = sent.filter(mail => mail.to === 'shipping@example.com').length;
  assert.equal((await api('/api/admin/orders/' + order.id + '/notify-owner', 'POST', {}, adminCookie)).status, 200);
  assert.equal(sent.filter(mail => mail.to === 'shipping@example.com').length, before);
  assert.equal((await api('/api/admin/orders/' + order.id + '/notify-owner', 'POST', {}, buyerCookie)).status, 403);
});
test('card creation backs up checkout details in Stripe; unpaid completion is not paid; verified repeat events do not reset shipped orders', async () => {
  const response = await api('/api/checkout/stripe', 'POST', { ...checkout, paymentMethod: 'stripe' }, buyerCookie);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const id = response.body.order.id; const session = sessions.get('cs_' + id);
  assert.ok(sent.find(mail => mail.to === 'owner@example.com' && mail.subject.includes(id) && mail.text.includes('Pending Payment')));
  assert.equal(session.createOptions.customer_email, checkout.customer.email);
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
});
