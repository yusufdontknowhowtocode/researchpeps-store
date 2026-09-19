const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ownerMessage, createOrderNotifier, DEFAULT_OWNER_EMAIL } = require('../lib/order-notifications');
const order = {
  id: 'RP-TEST-1', createdAt: '2026-09-08T14:00:00.000Z', status: 'Paid - Processing', paymentMethod: 'paypal', paymentMethodLabel: 'PayPal',
  customer: { name: 'Test <Buyer>', email: 'checkout@example.com', phone: '+1 555 010 1234' },
  shipping: { address: '123 Test Street\nSuite 4', city: 'Lansdale', state: 'PA', zip: '19446', country: 'United States' },
  items: [{ name: 'Sample <Item>', code: 'TEST-10', spec: '10mg × 10 vials', quantity: 2, unitPrice: 50, lineTotal: 100 }],
  subtotal: 100, shippingCharge: 15, tax: 0, discount: 5, discountCode: 'TEST5', total: 110, researchUseAccepted: true,
  notes: 'Leave at receiving. <script>alert(1)</script>',
};
function fixture(transporter, clock) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE orders (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO orders VALUES (?)').run(order.id);
  const config = { db, transporter, from: 'orders@example.com', to: DEFAULT_OWNER_EMAIL, publicUrl: 'https://example.com', getOrder: () => order, logger: { error() {} }, clock };
  return { db, config, notifier: createOrderNotifier(config) };
}
test('owner email includes all checkout fields, item quantities, prices and escaped HTML', () => {
  const mail = ownerMessage(order, { from: 'orders@example.com', to: DEFAULT_OWNER_EMAIL, publicUrl: 'https://example.com' });
  for (const value of [order.id, order.createdAt, order.status, ...Object.values(order.customer), ...Object.values(order.shipping), order.notes, order.discountCode, 'TEST-10', '10mg × 10 vials', 'Quantity: 2', '$110.00 USD', 'Tax: $0.00 USD', 'Accepted']) assert.ok(mail.text.includes(value), value);
  assert.equal(mail.to, 'ykaymakusa@gmail.com');
  assert.equal(mail.replyTo, 'checkout@example.com');
  assert.ok(mail.html.includes('&lt;script&gt;'));
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.text.includes('Payment status: Confirmed'));
  assert.ok(mail.text.includes('/admin?order=RP-TEST-1'));
  assert.ok(mail.text.includes('MANUAL SOURCING REVIEW REQUIRED'));
});
test('unpaid and created events never send; paid retries and concurrent flushes send once', async () => {
  const sent = [];
  const { db, notifier, config } = fixture({ async sendMail(mail) { sent.push(mail); await new Promise(resolve => setTimeout(resolve, 5)); return { accepted: [mail.to] }; } });
  const original = order.status; order.status = 'Pending Payment';
  notifier.enqueue(order.id); notifier.enqueue(order.id, 'created');
  await notifier.flush(); assert.equal(sent.length, 0); assert.equal(notifier.latest(order.id), null);
  // An old pre-upgrade unpaid job must not leak an internal email either.
  db.prepare('INSERT INTO owner_order_emails (order_id,event,recipient) VALUES (?,?,?)').run(order.id,'created',DEFAULT_OWNER_EMAIL);
  await notifier.flush(); assert.equal(sent.length, 0);
  order.status = original;
  notifier.enqueue(order.id, 'paid'); notifier.enqueue(order.id, 'paid');
  await Promise.all([notifier.flush(), notifier.flush()]);
  assert.equal(sent.length, 1); assert.equal(notifier.latest(order.id).status, 'sent');
  notifier.enqueue(order.id, 'paid'); notifier.enqueue(order.id, 'resend-test');
  await createOrderNotifier(config).flush();
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /^Payment confirmed/);
  db.close();
});
test('SMTP failures persist and retry after backoff; success is not re-sent on restart', async () => {
  let time = 1000; let failing = true; const sent = [];
  const { db, notifier, config } = fixture({ async sendMail(mail) { if (failing) throw new Error('temporary SMTP failure'); sent.push(mail); return { accepted: [mail.to] }; } }, () => time);
  notifier.enqueue(order.id); await notifier.flush();
  assert.equal(notifier.latest(order.id).status, 'retry');
  failing = false; await notifier.flush(); assert.equal(sent.length, 0);
  time += 30000; const restarted = createOrderNotifier(config); await restarted.flush();
  assert.equal(sent.length, 1); assert.equal(restarted.latest(order.id).attempts, 2);
  await createOrderNotifier(config).flush(); assert.equal(sent.length, 1); db.close();
});
test('missing SMTP queues notifications, preserving recipient and pending work', async () => {
  const { db, notifier, config } = fixture(null);
  notifier.enqueue(order.id); await notifier.flush();
  assert.deepEqual(notifier.configuration(), { configured: false, recipient: DEFAULT_OWNER_EMAIL, pending: 1 });
  assert.equal(notifier.latest(order.id).attempts, 0);
  let delivered = false;
  await createOrderNotifier({ ...config, transporter: { async sendMail() { delivered = true; return { accepted: [DEFAULT_OWNER_EMAIL] }; } } }).flush();
  assert.equal(delivered, true); db.close();
});
test('queue write rolls back with a failed order transaction', () => {
  const { db, notifier } = fixture(null);
  assert.throws(db.transaction(() => { notifier.enqueue(order.id); throw new Error('item insert failed'); }));
  assert.equal(notifier.configuration().pending, 0); db.close();
});

test('a cancelled or refunded order is never sent for fulfillment from an old pending job',async()=>{
 const sent=[];const {db,notifier}=fixture({async sendMail(m){sent.push(m);return {accepted:[m.to]};}});
 notifier.enqueue(order.id);
 const before=order.status;
 for(const status of ['Cancelled','Refunded','Pending Payment']){order.status=status;await notifier.flush();assert.equal(sent.length,0);}
 order.status=before;db.close();
});
