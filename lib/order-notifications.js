const crypto = require('node:crypto');

const DEFAULT_OWNER_EMAIL = 'ykaymakusa@gmail.com';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (value) => `$${Number(value || 0).toFixed(2)} USD`;

function ownerMessage(order, { from, to, publicUrl, event = 'created' }) {
  const title = event === 'paid' ? 'Payment confirmed' : event === 'created' ? 'New order received' : 'Order details';
  const customer = order.customer || {};
  const shipping = order.shipping || {};
  const fields = [
    ['Order number', order.id], ['Placed', order.createdAt], ['Order status', order.status],
    ['Payment method', order.paymentMethodLabel || order.paymentMethod],
    ['Subtotal', money(order.subtotal)], ['Shipping charge', money(order.shippingCharge)],
    ['Tax', money(order.tax)], ['Discount', money(order.discount)],
    ['Discount code', order.discountCode || 'None'], ['Total', money(order.total)],
    ['Full name', customer.name], ['Email', customer.email], ['Phone', customer.phone],
    ['Street address', shipping.address], ['City', shipping.city], ['State / region', shipping.state],
    ['ZIP / postal code', shipping.zip], ['Country', shipping.country],
    ['Checkout notes / order notes', order.notes || 'None'],
    ['Research-use confirmation', order.researchUseAccepted ? 'Accepted' : 'Not recorded'],
    ['Tracking carrier', order.trackingCarrier || 'Not assigned'],
    ['Tracking number', order.trackingNumber || 'Not assigned'],
  ];
  const items = order.items || [];
  const adminUrl = `${String(publicUrl || '').replace(/\/$/, '')}/admin`;
  return {
    from, to, replyTo: customer.email || undefined,
    subject: `${title}: ${order.id} — ${money(order.total)} — ${order.paymentMethodLabel || order.paymentMethod}`,
    text: `${title}\n\n${fields.map(([label, value]) => `${label}: ${value || '—'}`).join('\n')}\n\nItems ordered:\n${items.map((item) => `${item.name} | ${item.spec} | Code: ${item.code} | Quantity: ${item.quantity} | Unit price: ${money(item.unitPrice)} | Line total: ${money(item.lineTotal)}`).join('\n')}\n\nAn order notification alone does not confirm payment. Check the order status before shipping.\n\nOpen admin: ${adminUrl}`,
    html: `<div style="font:15px/1.6 Arial,sans-serif;color:#172033;max-width:760px;margin:auto"><h1>${escapeHtml(title)}</h1><p><strong>${escapeHtml(order.id)}</strong> · ${escapeHtml(order.status)}</p><h2>Items ordered</h2><table cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;text-align:left" border="1"><thead><tr><th>Product / size / pack</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>${items.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><br>${escapeHtml(item.spec)}<br>Code: ${escapeHtml(item.code)}</td><td>${escapeHtml(item.quantity)}</td><td>${money(item.unitPrice)}</td><td>${money(item.lineTotal)}</td></tr>`).join('')}</tbody></table><h2>Payment, customer &amp; shipping details</h2><table cellpadding="8" style="text-align:left;width:100%">${fields.map(([label, value]) => `<tr><th style="vertical-align:top">${escapeHtml(label)}</th><td style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(value || '—')}</td></tr>`).join('')}</table><p>An order notification alone does not confirm payment. Check the order status before shipping.</p><p><a href="${escapeHtml(adminUrl)}">Open order dashboard</a></p></div>`,
  };
}

// Durable owner-only outbox. Customer receipts keep their existing delivery flow.
function createOrderNotifier({ db, transporter, from, to, publicUrl, getOrder, logger = console, clock = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_order_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, event TEXT NOT NULL,
    recipient TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, sent_at TEXT, last_error TEXT,
    UNIQUE(order_id, event), FOREIGN KEY(order_id) REFERENCES orders(id)
  )`);
  // A server restart must not strand an interrupted attempt.
  db.prepare("UPDATE owner_order_emails SET status = 'pending' WHERE status = 'sending'").run();
  let running = false;

  function enqueue(orderId, event = 'created') {
    db.prepare('INSERT OR IGNORE INTO owner_order_emails (order_id, event, recipient) VALUES (?, ?, ?)').run(orderId, event, to);
  }

  async function flush() {
    if (running || !transporter) return;
    running = true;
    try {
      const jobs = db.prepare("SELECT * FROM owner_order_emails WHERE status IN ('pending', 'retry') AND next_attempt_at <= ? ORDER BY id LIMIT 20").all(clock());
      for (const job of jobs) {
        const claimed = db.prepare("UPDATE owner_order_emails SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status IN ('pending', 'retry')").run(job.id);
        if (!claimed.changes) continue;
        try {
          const order = getOrder(job.order_id);
          if (!order) throw new Error('Order no longer exists');
          const message = ownerMessage(order, { from, to: job.recipient, publicUrl, event: job.event });
          // Stable Message-ID helps diagnose duplicate delivery after a crash.
          message.messageId = `<order-${job.id}-${crypto.createHash('sha256').update(job.order_id).digest('hex').slice(0, 16)}@researchpeps.local>`;
          const result = await transporter.sendMail(message);
          if (result.accepted && result.accepted.length === 0) throw new Error('SMTP did not accept the recipient');
          db.prepare("UPDATE owner_order_emails SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").run(new Date(clock()).toISOString(), job.id);
        } catch (error) {
          const delay = Math.min(60 * 60 * 1000, 30000 * 2 ** Math.min(job.attempts, 7));
          db.prepare("UPDATE owner_order_emails SET status = 'retry', next_attempt_at = ?, last_error = ? WHERE id = ?").run(clock() + delay, String(error.message).slice(0, 500), job.id);
          logger.error('Owner order email will retry:', job.order_id, error.message);
        }
      }
    } finally { running = false; }
  }

  function latest(orderId) {
    return db.prepare('SELECT status, attempts, sent_at AS sentAt FROM owner_order_emails WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId) || null;
  }

  function configuration() {
    return { configured: Boolean(transporter), recipient: to, pending: db.prepare("SELECT count(*) AS count FROM owner_order_emails WHERE status != 'sent'").get().count };
  }

  return { enqueue, flush, latest, configuration };
}

module.exports = { DEFAULT_OWNER_EMAIL, ownerMessage, createOrderNotifier };
