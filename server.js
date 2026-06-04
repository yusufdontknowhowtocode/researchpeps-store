require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-before-production';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || '';
const ORDER_NOTIFY_EMAIL = process.env.ORDER_NOTIFY_EMAIL || process.env.OWNER_EMAIL || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const PASSWORD_RESET_EXPIRES_MINUTES = Number(process.env.PASSWORD_RESET_EXPIRES_MINUTES || 60);
const DEFAULT_BTC_PAYMENT_ADDRESS = '3QaBoxDHEWnuGy5emvYawoFCM5E5yMEvap';
const DEFAULT_SOL_PAYMENT_ADDRESS = '7NVysM4pSWVq4ZYKnnCwz3fnaA1BgkCex6tARvv7vqBT';
const DEFAULT_USDC_PAYMENT_ADDRESS = '3q2QjuTXc5S8MYo5YdD5ELuBz1ASv5YDcEvmQgw4V6n9';
const DEFAULT_USDC_PAYMENT_NETWORK = 'Solana';
const CRYPTO_QUOTE_CACHE_MS = 60 * 1000;
const CRYPTO_QUOTE_EXPIRES_MINUTES = Number(process.env.CRYPTO_QUOTE_EXPIRES_MINUTES || 15);
const CRYPTO_QUOTE_BUFFER = Number(process.env.CRYPTO_QUOTE_BUFFER || 0);
let cryptoRateCache = { fetchedAt: 0, rates: null };
const CRYPTO_WALLETS = {
  btc: {
    label: 'Bitcoin (BTC)',
    network: 'Bitcoin',
    address: process.env.BTC_PAYMENT_ADDRESS || DEFAULT_BTC_PAYMENT_ADDRESS
  },
  sol: {
    label: 'Solana (SOL)',
    network: 'Solana',
    address: process.env.SOL_PAYMENT_ADDRESS || DEFAULT_SOL_PAYMENT_ADDRESS
  },
  usdc: {
    label: `USDC (${process.env.USDC_PAYMENT_NETWORK || DEFAULT_USDC_PAYMENT_NETWORK})`,
    network: process.env.USDC_PAYMENT_NETWORK || DEFAULT_USDC_PAYMENT_NETWORK,
    address: process.env.USDC_PAYMENT_ADDRESS || DEFAULT_USDC_PAYMENT_ADDRESS
  }
};
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

if (NODE_ENV === 'production' && SESSION_SECRET === 'change-me-before-production') {
  throw new Error('Set SESSION_SECRET before running in production.');
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const mailTransporter = SMTP_HOST && MAIL_FROM
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE || SMTP_PORT === 465,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
    })
  : null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


function createRandomPasswordHashPlaceholder() {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function buildPasswordResetUrl(token) {
  const base = String(PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/?reset=${encodeURIComponent(token)}`;
}

async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) {
    const error = new Error('Google sign-in is not configured. Add GOOGLE_CLIENT_ID in Render environment variables.');
    error.status = 503;
    throw error;
  }

  if (!credential) {
    const error = new Error('Missing Google credential.');
    error.status = 400;
    throw error;
  }

  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.error_description || payload.aud !== GOOGLE_CLIENT_ID) {
    const error = new Error('Google sign-in could not be verified. Check your Google client ID and authorized domain.');
    error.status = 401;
    throw error;
  }

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!payload.email || !emailVerified) {
    const error = new Error('Google email is not verified. Use another sign-in method.');
    error.status = 401;
    throw error;
  }

  return {
    sub: String(payload.sub || ''),
    email: normalizeEmail(payload.email),
    name: String(payload.name || payload.given_name || payload.email).trim()
  };
}

function orderItemsText(order) {
  return (order.items || [])
    .map((item) => `- ${item.name} (${item.spec}) x ${item.quantity}: $${Number(item.lineTotal || 0).toFixed(2)}`)
    .join('\n');
}

function orderItemsHtml(order) {
  return (order.items || [])
    .map((item) => `<li><strong>${escapeHtml(item.name)}</strong> — ${escapeHtml(item.spec)} × ${escapeHtml(item.quantity)} — $${Number(item.lineTotal || 0).toFixed(2)}</li>`)
    .join('');
}

async function sendOrderEmails(order, cryptoPayment, cryptoQuote) {
  if (!mailTransporter) {
    console.log('Email not configured. Skipping order emails.');
    return;
  }

  const customerEmail = order.customer && order.customer.email;
  const notifyEmail = ORDER_NOTIFY_EMAIL || ADMIN_EMAILS[0] || '';
  const paymentLines = cryptoPayment
    ? `\n\nCrypto payment:\n${cryptoPayment.label}\nNetwork: ${cryptoPayment.network}\nAddress: ${cryptoPayment.address}\nPut order number ${order.id} in the payment note/reference if possible. If not, send the transaction hash with the order number.`
    : '';

  const customerText = `Thank you for your order.\n\nOrder number: ${order.id}\nStatus: ${order.status}\nPayment: ${order.paymentMethodLabel}\nSubtotal: $${Number(order.subtotal || 0).toFixed(2)}\nShipping: $${Number(order.shippingCharge || 0).toFixed(2)}\nTotal: $${Number(order.total || 0).toFixed(2)}\n\nItems:\n${orderItemsText(order)}${paymentLines}\n\nResearch-use confirmation was accepted at checkout.`;

  const customerHtml = `
    <h2>Thank you for your order</h2>
    <p><strong>Order number:</strong> ${escapeHtml(order.id)}</p>
    <p><strong>Status:</strong> ${escapeHtml(order.status)}</p>
    <p><strong>Payment:</strong> ${escapeHtml(order.paymentMethodLabel)}</p>
    <p><strong>Subtotal:</strong> $${Number(order.subtotal || 0).toFixed(2)}<br><strong>Shipping:</strong> $${Number(order.shippingCharge || 0).toFixed(2)}<br><strong>Total:</strong> $${Number(order.total || 0).toFixed(2)}</p>
    <h3>Items</h3>
    <ul>${orderItemsHtml(order)}</ul>
    ${cryptoPayment ? `<h3>Crypto payment</h3><p>Send ${escapeHtml(cryptoPayment.label)} on the ${escapeHtml(cryptoPayment.network)} network.</p>${cryptoQuote ? `<p><strong>Amount to send:</strong> ${escapeHtml(cryptoQuote.amount)} ${escapeHtml(cryptoQuote.symbol)}</p><p><strong>Quote expires:</strong> ${escapeHtml(cryptoQuote.expiresAt)}</p>` : ''}<p><strong>Address:</strong></p><p style="word-break:break-all;"><code>${escapeHtml(cryptoPayment.address)}</code></p><p>Type order number <strong>${escapeHtml(order.id)}</strong> in the payment note/reference if your wallet allows it. If not, send the transaction hash with your order number.</p>` : ''}
    <p>Research-use confirmation was accepted at checkout.</p>
  `;

  const ownerText = `New order received.\n\nOrder number: ${order.id}\nStatus: ${order.status}\nPayment: ${order.paymentMethodLabel}\nTotal: $${Number(order.total || 0).toFixed(2)}\n\nCustomer:\n${order.customer.name}\n${order.customer.email}\n${order.customer.phone}\n\nShip to:\n${order.shipping.address}\n${order.shipping.city}, ${order.shipping.state} ${order.shipping.zip}\n${order.shipping.country}\n\nItems:\n${orderItemsText(order)}${paymentLines}\n\nNotes: ${order.notes || 'None'}`;

  const ownerHtml = `
    <h2>New order received</h2>
    <p><strong>Order number:</strong> ${escapeHtml(order.id)}</p>
    <p><strong>Status:</strong> ${escapeHtml(order.status)}</p>
    <p><strong>Payment:</strong> ${escapeHtml(order.paymentMethodLabel)}</p>
    <p><strong>Subtotal:</strong> $${Number(order.subtotal || 0).toFixed(2)}<br><strong>Shipping:</strong> $${Number(order.shippingCharge || 0).toFixed(2)}<br><strong>Total:</strong> $${Number(order.total || 0).toFixed(2)}</p>
    <h3>Customer</h3>
    <p>${escapeHtml(order.customer.name)}<br>${escapeHtml(order.customer.email)}<br>${escapeHtml(order.customer.phone)}</p>
    <h3>Shipping</h3>
    <p>${escapeHtml(order.shipping.address)}<br>${escapeHtml(order.shipping.city)}, ${escapeHtml(order.shipping.state)} ${escapeHtml(order.shipping.zip)}<br>${escapeHtml(order.shipping.country)}</p>
    <h3>Items</h3>
    <ul>${orderItemsHtml(order)}</ul>
    ${cryptoPayment ? `<h3>Crypto payment</h3><p>${escapeHtml(cryptoPayment.label)} on ${escapeHtml(cryptoPayment.network)}</p>${cryptoQuote ? `<p><strong>Amount due:</strong> ${escapeHtml(cryptoQuote.amount)} ${escapeHtml(cryptoQuote.symbol)}</p>` : ''}<p style="word-break:break-all;"><code>${escapeHtml(cryptoPayment.address)}</code></p>` : ''}
    <h3>Notes</h3>
    <p>${escapeHtml(order.notes || 'None')}</p>
  `;

  const messages = [];
  if (customerEmail) {
    messages.push(mailTransporter.sendMail({
      from: MAIL_FROM,
      to: customerEmail,
      subject: `ResearchPeps order ${order.id}`,
      text: customerText,
      html: customerHtml
    }));
  }

  if (notifyEmail) {
    messages.push(mailTransporter.sendMail({
      from: MAIL_FROM,
      to: notifyEmail,
      subject: `New ResearchPeps order ${order.id}`,
      text: ownerText,
      html: ownerHtml
    }));
  }

  await Promise.all(messages);
}

function sendOrderEmailsSafely(order, cryptoPayment, cryptoQuote) {
  sendOrderEmails(order, cryptoPayment, cryptoQuote).catch((error) => {
    console.error('Order email failed:', error.message);
  });
}

async function sendPasswordResetEmail(user, resetUrl) {
  if (!mailTransporter) {
    console.log(`Password reset link for ${user.email}: ${resetUrl}`);
    return;
  }

  const text = `Password reset requested.\n\nUse this link to reset your ResearchPeps password:\n${resetUrl}\n\nThis link expires in ${PASSWORD_RESET_EXPIRES_MINUTES} minutes. If you did not request this, ignore this email.`;
  const html = `
    <h2>Password reset requested</h2>
    <p>Use the button below to reset your ResearchPeps password.</p>
    <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#1e5eff;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;">Reset password</a></p>
    <p>This link expires in ${escapeHtml(PASSWORD_RESET_EXPIRES_MINUTES)} minutes.</p>
    <p>If you did not request this, you can ignore this email.</p>
  `;

  await mailTransporter.sendMail({
    from: MAIL_FROM,
    to: user.email,
    subject: 'Reset your ResearchPeps password',
    text,
    html
  });
}

function sendPasswordResetEmailSafely(user, resetUrl) {
  sendPasswordResetEmail(user, resetUrl).catch((error) => {
    console.error('Password reset email failed:', error.message);
  });
}


const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'researchpeps.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  payment_method_label TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  customer_json TEXT NOT NULL,
  shipping_json TEXT NOT NULL,
  notes TEXT,
  research_use_accepted INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  option_code TEXT NOT NULL,
  spec TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS web_sessions (
  sid TEXT PRIMARY KEY,
  sess_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

function ensureOrderColumn(name, definition) {
  const columns = db.prepare('PRAGMA table_info(orders)').all().map((column) => column.name);
  if (!columns.includes(name)) {
    db.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`).run();
  }
}

ensureOrderColumn('subtotal_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureOrderColumn('tax_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureOrderColumn('shipping_cents', 'INTEGER NOT NULL DEFAULT 0');

function ensureUserColumn(name, definition) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  if (!columns.includes(name)) {
    db.prepare(`ALTER TABLE users ADD COLUMN ${name} ${definition}`).run();
  }
}

ensureUserColumn('google_sub', 'TEXT');
ensureUserColumn('email_verified', 'INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('last_login_at', 'TEXT');

class BetterSqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess_json, expires_at FROM web_sessions WHERE sid = ?').get(sid);
      if (!row || row.expires_at <= Date.now()) {
        if (row) this.destroy(sid, () => {});
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess_json));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback) {
    try {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge ? Number(sess.cookie.maxAge) : 1000 * 60 * 60 * 24 * 14;
      const expiresAt = Date.now() + maxAge;
      this.db.prepare(`
        INSERT INTO web_sessions (sid, sess_json, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess_json = excluded.sess_json, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(sess), expiresAt);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }
}

const products = JSON.parse(fs.readFileSync(path.join(dataDir, 'products.json'), 'utf8'));
const shippingRatesPath = path.join(dataDir, 'shipping-rates.json');
const shippingRateConfig = fs.existsSync(shippingRatesPath)
  ? JSON.parse(fs.readFileSync(shippingRatesPath, 'utf8'))
  : { defaultRate: 80, rates: [{ country: 'United States', code: 'US', rate: 15 }] };

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function dollarsToCents(priceText) {
  const number = Number(String(priceText).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function makeNicePrice(value) {
  const number = Number(value) || 0;
  if (number <= 0) return 0;


  const baseTen = Math.floor(number / 10) * 10;
  return baseTen + 9.99;
}

function formatMoney(value) {
  const number = Number(value) || 0;
  return "$" + number.toFixed(2);
}
function formatMoneyFromCents(cents) {
  return "$" + (Number(cents || 0) / 100).toFixed(2);
}



function normalizeCountryName(country) {
  const value = String(country || '').trim();
  if (!value) return 'United States';
  const lower = value.toLowerCase();
  const aliases = {
    usa: 'United States',
    us: 'United States',
    'u.s.': 'United States',
    'u.s.a.': 'United States',
    america: 'United States',
    'united states of america': 'United States',
    uk: 'United Kingdom',
    'u.k.': 'United Kingdom',
    britain: 'United Kingdom',
    england: 'United Kingdom',
    row: 'Rest of World',
    other: 'Rest of World'
  };
  if (aliases[lower]) return aliases[lower];
  const match = (shippingRateConfig.rates || []).find((entry) =>
    String(entry.country || '').toLowerCase() === lower || String(entry.code || '').toLowerCase() === lower
  );
  return match ? match.country : value;
}

function getShippingRateEntry(country) {
  const normalized = normalizeCountryName(country);
  const match = (shippingRateConfig.rates || []).find((entry) =>
    String(entry.country || '').toLowerCase() === normalized.toLowerCase() ||
    String(entry.code || '').toLowerCase() === normalized.toLowerCase()
  );
  if (match) return match;
  const fallback = (shippingRateConfig.rates || []).find((entry) => String(entry.code || '').toUpperCase() === 'ROW');
  return fallback || { country: 'Rest of World', code: 'ROW', rate: Number(shippingRateConfig.defaultRate || 80) };
}

function getShippingCentsForCountry(country) {
  const entry = getShippingRateEntry(country);
  return dollarsToCentsNumber(entry.rate || 0);
}

function publicShippingRates() {
  return {
    defaultRate: Number(shippingRateConfig.defaultRate || 80),
    rates: (shippingRateConfig.rates || []).map((entry) => ({
      country: entry.country,
      code: entry.code,
      rate: Number(entry.rate || 0),
      note: entry.note || ''
    }))
  };
}

const KIT_PRICE_MULTIPLIER = 1.5;
const SINGLE_VIAL_PRICE_MULTIPLIER = 2.8;

function parsePrice(priceText) {
  const number = Number(String(priceText).replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function getVialCount(spec) {
  const match = String(spec).match(/\*(\d+)\s*vials?/i);
  return match ? Number(match[1]) : 1;
}

function getRaisedKitPrice(option) {
  return makeNicePrice(parsePrice(option.price) * KIT_PRICE_MULTIPLIER);
}

function getBasePerVialPrice(option) {
  const vialCount = getVialCount(option.spec);
  const basePrice = parsePrice(option.price);
  return vialCount ? basePrice / vialCount : basePrice;
}

function getSingleVialPrice(option) {
  return makeNicePrice(getBasePerVialPrice(option) * SINGLE_VIAL_PRICE_MULTIPLIER);
}

function dollarsToCentsNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function createOrderId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const random = crypto.randomInt(1000, 9999);
  return `RP-${year}${month}${day}-${random}`;
}

function isCryptoPaymentMethod(method) {
  return ['btc', 'sol', 'usdc'].includes(String(method || '').toLowerCase());
}

function normalizePaymentMethod(method) {
  const value = String(method || 'stripe').toLowerCase();
  if (value === 'stripe') return 'stripe';
  if (isCryptoPaymentMethod(value)) return value;
  return 'stripe';
}

function getCryptoPayment(method, orderId) {
  const value = String(method || '').toLowerCase();
  const wallet = CRYPTO_WALLETS[value];
  if (!wallet) return null;

  return {
    method: value,
    label: wallet.label,
    network: wallet.network,
    address: wallet.address || 'ADD_THIS_WALLET_ADDRESS_IN_.ENV',
    instructions:
      `Send ${wallet.label} payment on the ${wallet.network} network to the address shown. ` +
      `IMPORTANT: type order number ${orderId} in the payment note, memo, or reference field if your wallet/exchange allows it. ` +
      `If your wallet does not allow payment notes, send support the transaction hash with order number ${orderId}.`
  };
}

function getCryptoSymbol(method) {
  const value = String(method || '').toLowerCase();
  if (value === 'btc') return 'BTC';
  if (value === 'sol') return 'SOL';
  if (value === 'usdc') return 'USDC';
  return '';
}

function formatCryptoAmount(method, amount) {
  const value = String(method || '').toLowerCase();
  if (value === 'btc') return Number(amount).toFixed(8);
  if (value === 'sol') return Number(amount).toFixed(6);
  if (value === 'usdc') return Number(amount).toFixed(2);
  return Number(amount).toFixed(6);
}

async function getCoinbaseUsdRates() {
  const now = Date.now();
  if (cryptoRateCache.rates && now - cryptoRateCache.fetchedAt < CRYPTO_QUOTE_CACHE_MS) {
    return cryptoRateCache.rates;
  }

  const response = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD');
  if (!response.ok) {
    throw new Error('Unable to fetch crypto exchange rates.');
  }

  const data = await response.json();
  const rates = data && data.data && data.data.rates ? data.data.rates : {};
  cryptoRateCache = { fetchedAt: now, rates };
  return rates;
}

async function getCryptoQuote(method, usdTotal) {
  const normalizedMethod = normalizePaymentMethod(method);
  const symbol = getCryptoSymbol(normalizedMethod);
  if (!symbol) return null;

  const usdAmount = Number(usdTotal || 0);
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
    throw new Error('Missing order total for crypto quote.');
  }

  let rate;
  if (symbol === 'USDC') {
    rate = 1;
  } else {
    const rates = await getCoinbaseUsdRates();
    rate = Number(rates[symbol]);
  }

  if (!rate || Number.isNaN(rate)) {
    throw new Error(`No exchange rate found for ${symbol}.`);
  }

  const bufferedUsdAmount = usdAmount * (1 + CRYPTO_QUOTE_BUFFER);
  const cryptoAmount = bufferedUsdAmount * rate;
  const expiresAt = new Date(Date.now() + CRYPTO_QUOTE_EXPIRES_MINUTES * 60 * 1000).toISOString();

  return {
    method: normalizedMethod,
    symbol,
    usdAmount,
    rate,
    amount: formatCryptoAmount(normalizedMethod, cryptoAmount),
    expiresAt,
    bufferPercent: CRYPTO_QUOTE_BUFFER * 100
  };
}

async function attachCryptoQuoteToOrder(order, cryptoPayment) {
  if (!cryptoPayment || !isCryptoPaymentMethod(order.paymentMethod)) return null;
  const cryptoQuote = await getCryptoQuote(order.paymentMethod, order.total);
  const quoteNote =
    `Crypto amount due: ${cryptoQuote.amount} ${cryptoQuote.symbol}. ` +
    `USD total: $${Number(order.total || 0).toFixed(2)}. ` +
    `Quote expires: ${cryptoQuote.expiresAt}.`;
  const updatedNotes = [order.notes || '', quoteNote].filter(Boolean).join('\n');

  db.prepare(`
    UPDATE orders
    SET notes = ?, updated_at = ?
    WHERE id = ?
  `).run(updatedNotes, nowIso(), order.id);

  order.notes = updatedNotes;
  return cryptoQuote;
}

function publicUser(row) {
  if (!row) return null;
  const orders = db.prepare(`
    SELECT *
    FROM orders
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(row.id).map(publicOrder);

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orders
  };
}

function publicOrder(row) {
  const items = db.prepare(`
    SELECT *
    FROM order_items
    WHERE order_id = ?
    ORDER BY rowid ASC
  `).all(row.id).map((item) => ({
    name: item.product_name,
    code: item.option_code,
    spec: item.spec,
    unitPrice: item.unit_price_cents / 100,
    quantity: item.quantity,
    lineTotal: item.line_total_cents / 100
  }));

  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    paymentMethod: row.payment_method,
    paymentMethodLabel: row.payment_method_label,
    subtotal: (row.subtotal_cents || items.reduce((sum, item) => sum + Math.round(item.lineTotal * 100), 0)) / 100,
    tax: (row.tax_cents || 0) / 100,
    shippingCharge: (row.shipping_cents || 0) / 100,
    total: row.total_cents / 100,
    currency: row.currency,
    customer: JSON.parse(row.customer_json),
    shipping: JSON.parse(row.shipping_json),
    notes: row.notes || '',
    researchUseAccepted: !!row.research_use_accepted,
    stripeSessionId: row.stripe_session_id || null,
    items
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please sign in first.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in first.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

function getPaymentMethodLabel(method) {
  const value = String(method || '').toLowerCase();
  if (value === 'stripe') return 'Credit card';
  if (value === 'btc') return 'Bitcoin (BTC)';
  if (value === 'sol') return 'Solana (SOL)';
  if (value === 'usdc') return `USDC (${process.env.USDC_PAYMENT_NETWORK || 'Solana'})`;
  return 'Credit card';
}

function getOrderItemUnitPrice(line, option) {
  if (line.purchaseType === 'single') {
    const vialQty = Math.max(1, Math.min(99, Number.parseInt(line.vialQuantity || 1, 10)));
    return getSingleVialPrice(option) * vialQty;
  }
  return getRaisedKitPrice(option);
}

function getOrderItemSpec(line, option) {
  if (line.purchaseType === 'single') {
    const vialQty = Math.max(1, Math.min(99, Number.parseInt(line.vialQuantity || 1, 10)));
    const dose = String(option.spec).split('*')[0].trim();
    return `${vialQty} vial${vialQty === 1 ? '' : 's'} • ${dose} each`;
  }
  return option.spec;
}

function validateCartItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('Your cart is empty.');
    error.status = 400;
    throw error;
  }

  return items.map((line) => {
    const product = products.find((p) => p.name === line.productName);
    if (!product) {
      const error = new Error(`Product not found: ${line.productName || 'unknown'}`);
      error.status = 400;
      throw error;
    }

    const option = product.options.find((opt) => opt.code === line.optionCode);
    if (!option) {
      const error = new Error(`Option not found for ${product.name}.`);
      error.status = 400;
      throw error;
    }

    const purchaseType = line.purchaseType === 'single' ? 'single' : 'kit';
    const vialQuantity = Math.max(1, Math.min(99, Number.parseInt(line.vialQuantity || 1, 10)));
    const quantity = Math.max(1, Math.min(99, Number.parseInt(line.quantity || 1, 10)));
    const unitPriceCents = dollarsToCentsNumber(getOrderItemUnitPrice({ ...line, purchaseType, vialQuantity }, option));
    const spec = getOrderItemSpec({ ...line, purchaseType, vialQuantity }, option);

    return {
      productName: product.name,
      optionCode: option.code,
      spec,
      purchaseType,
      vialQuantity,
      unitPriceCents,
      quantity,
      lineTotalCents: unitPriceCents * quantity
    };
  });
}

function calculateOrderTotals(items, shippingCountry) {
  const validatedItems = validateCartItems(items);
  const subtotalCents = validatedItems.reduce((sum, item) => sum + item.lineTotalCents, 0);

  const taxCents = 0;
  const shippingCents = subtotalCents > 0 ? getShippingCentsForCountry(shippingCountry || 'United States') : 0;
  const totalCents = subtotalCents + taxCents + shippingCents;

  return { items: validatedItems, subtotalCents, taxCents, shippingCents, totalCents };
}

function validateCheckoutPayload(body) {
  const customer = body.customer || {};
  const shipping = body.shipping || {};

  const required = [
    [customer.name, 'name'],
    [customer.email, 'email'],
    [customer.phone, 'phone'],
    [shipping.address, 'shipping address'],
    [shipping.city, 'city'],
    [shipping.state, 'state'],
    [shipping.zip, 'ZIP code'],
    [shipping.country, 'country']
  ];

  for (const [value, label] of required) {
    if (!String(value || '').trim()) {
      const error = new Error(`Please enter your ${label}.`);
      error.status = 400;
      throw error;
    }
  }

  if (!body.researchUseAccepted) {
    const error = new Error('Please confirm the research-use-only statement before placing the order.');
    error.status = 400;
    throw error;
  }

  return {
    customer: {
      name: String(customer.name).trim(),
      email: normalizeEmail(customer.email),
      phone: String(customer.phone).trim()
    },
    shipping: {
      address: String(shipping.address).trim(),
      city: String(shipping.city).trim(),
      state: String(shipping.state).trim(),
      zip: String(shipping.zip).trim(),
      country: String(shipping.country).trim()
    },
    notes: String(body.notes || '').trim(),
    paymentMethod: String(body.paymentMethod || 'stripe'),
    researchUseAccepted: true
  };
}

function createOrderForUser(userId, body, statusOverride) {
  const validated = validateCheckoutPayload(body);
  const totals = calculateOrderTotals(body.items, validated.shipping.country);
  const orderId = createOrderId();
  const timestamp = nowIso();
  const paymentMethod = normalizePaymentMethod(validated.paymentMethod);
  const status = statusOverride || (isCryptoPaymentMethod(paymentMethod) ? `Awaiting ${getPaymentMethodLabel(paymentMethod)} Payment` : 'Order Submitted');

  const insertOrder = db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (
        id, user_id, status, payment_method, payment_method_label,
        subtotal_cents, tax_cents, shipping_cents, total_cents,
        currency, customer_json, shipping_json, notes, research_use_accepted,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      userId,
      status,
      paymentMethod,
      getPaymentMethodLabel(paymentMethod),
      totals.subtotalCents,
      totals.taxCents,
      totals.shippingCents,
      totals.totalCents,
      JSON.stringify(validated.customer),
      JSON.stringify(validated.shipping),
      validated.notes,
      1,
      timestamp,
      timestamp
    );

    for (const item of totals.items) {
      db.prepare(`
        INSERT INTO order_items (
          id, order_id, product_name, option_code, spec, unit_price_cents, quantity, line_total_cents
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        orderId,
        item.productName,
        item.optionCode,
        item.spec,
        item.unitPriceCents,
        item.quantity,
        item.lineTotalCents
      );
    }
  });

  insertOrder();

  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  return publicOrder(row);
}

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(morgan('tiny'));

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe webhook is not configured.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata && session.metadata.orderId;
    if (orderId) {
      db.prepare(`
        UPDATE orders
        SET status = ?, stripe_session_id = ?, updated_at = ?
        WHERE id = ?
      `).run('Paid - Processing', session.id, nowIso(), orderId);
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new BetterSqliteSessionStore(db),
  name: 'rp_session',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait and try again.' }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: NODE_ENV });
});

app.get('/api/products', (req, res) => {
  res.json({ products });
});

app.get('/api/shipping-rates', (req, res) => {
  res.json(publicShippingRates());
});

app.get('/api/session', (req, res) => {
  if (!req.session.userId) return res.json({ account: null });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!row) {
    req.session.destroy(() => {});
    return res.json({ account: null });
  }
  res.json({ account: publicUser(row) });
});

app.get('/api/payment-options', (req, res) => {
  res.json({
    cryptoWallets: {
      btc: getCryptoPayment('btc', 'YOUR_ORDER_NUMBER'),
      sol: getCryptoPayment('sol', 'YOUR_ORDER_NUMBER'),
      usdc: getCryptoPayment('usdc', 'YOUR_ORDER_NUMBER')
    }
  });
});

app.get('/api/crypto-quote', requireAuth, async (req, res, next) => {
  try {
    const method = normalizePaymentMethod(req.query.method);
    const amountUsd = Number(req.query.amountUsd || 0);

    if (!isCryptoPaymentMethod(method)) {
      return res.status(400).json({ error: 'Choose BTC, SOL, or USDC.' });
    }

    const quote = await getCryptoQuote(method, amountUsd);
    res.json({ quote });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/google/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || '' });
});

app.post('/api/auth/google', authLimiter, async (req, res, next) => {
  try {
    const googleUser = await verifyGoogleCredential(req.body.credential);
    let row = db.prepare('SELECT * FROM users WHERE email = ?').get(googleUser.email);
    const timestamp = nowIso();

    if (!row) {
      const id = crypto.randomUUID();
      const passwordHash = await createRandomPasswordHashPlaceholder();
      db.prepare(`
        INSERT INTO users (id, name, email, password_hash, google_sub, email_verified, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(id, googleUser.name, googleUser.email, passwordHash, googleUser.sub, timestamp, timestamp, timestamp);
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else {
      db.prepare(`
        UPDATE users
        SET name = COALESCE(NULLIF(name, ''), ?), google_sub = COALESCE(google_sub, ?), email_verified = 1, updated_at = ?, last_login_at = ?
        WHERE id = ?
      `).run(googleUser.name, googleUser.sub, timestamp, timestamp, row.id);
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    }

    req.session.userId = row.id;
    res.json({ account: publicUser(row) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/password-reset-request', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const genericMessage = 'If an account exists for that email, a reset link was sent.';

    if (!email) return res.status(400).json({ error: 'Enter your email address.' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      const now = Date.now();
      const expiresAt = now + PASSWORD_RESET_EXPIRES_MINUTES * 60 * 1000;
      const createdAt = nowIso();

      db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);
      db.prepare(`
        INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), user.id, tokenHash, expiresAt, createdAt);

      sendPasswordResetEmailSafely(user, buildPasswordResetUrl(rawToken));
    }

    res.json({ ok: true, message: genericMessage });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/password-reset', authLimiter, async (req, res, next) => {
  try {
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');

    if (!token || password.length < 8) {
      return res.status(400).json({ error: 'Reset token and a password with at least 8 characters are required.' });
    }

    const tokenHash = hashResetToken(token);
    const reset = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL').get(tokenHash);

    if (!reset || Number(reset.expires_at) <= Date.now()) {
      return res.status(400).json({ error: 'Reset link is invalid or expired. Request a new reset email.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(reset.user_id);
    if (!user) return res.status(400).json({ error: 'Account no longer exists.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const timestamp = nowIso();

    const updatePassword = db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ?, last_login_at = ? WHERE id = ?')
        .run(passwordHash, timestamp, timestamp, user.id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?')
        .run(timestamp, reset.id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);
    });
    updatePassword();

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    req.session.userId = updatedUser.id;
    res.json({ account: publicUser(updatedUser) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!name || !email || password.length < 8) {
      return res.status(400).json({ error: 'Enter a name, valid email, and password with at least 8 characters.' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'An account already exists for that email.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();
    const timestamp = nowIso();

    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, email, passwordHash, timestamp, timestamp);

    req.session.userId = id;
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.status(201).json({ account: publicUser(row) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: 'Email or password did not match.' });
    }

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
    const updatedRow = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    req.session.userId = updatedRow.id;
    res.json({ account: publicUser(updatedRow) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('rp_session');
    res.json({ ok: true });
  });
});

app.post('/api/cart/quote', (req, res, next) => {
  try {
    const shippingCountry = req.body.shippingCountry || (req.body.shipping && req.body.shipping.country) || 'United States';
    const totals = calculateOrderTotals(req.body.items, shippingCountry);
    res.json({
      items: totals.items.map((item) => ({
        productName: item.productName,
        optionCode: item.optionCode,
        spec: item.spec,
        unitPrice: item.unitPriceCents / 100,
        quantity: item.quantity,
        lineTotal: item.lineTotalCents / 100
      })),
      subtotal: totals.subtotalCents / 100,
      tax: totals.taxCents / 100,
      shipping: totals.shippingCents / 100,
      total: totals.totalCents / 100,
      totalLabel: formatMoneyFromCents(totals.totalCents)
      
    });
  } catch (error) {
    next(error);
  }
});


app.get('/api/orders', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.json({ orders: rows.map(publicOrder) });
});

app.post('/api/orders', requireAuth, async (req, res, next) => {
  try {
    req.body.paymentMethod = normalizePaymentMethod(req.body.paymentMethod);

    if (req.body.paymentMethod === 'stripe') {
      return res.status(400).json({
        error: 'Use credit card checkout for card payments, or choose BTC, SOL, or USDC for crypto.'
      });
    }

    const order = createOrderForUser(req.session.userId, req.body);
    const cryptoPayment = getCryptoPayment(order.paymentMethod, order.id);
    const cryptoQuote = await attachCryptoQuoteToOrder(order, cryptoPayment);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    sendOrderEmailsSafely(order, cryptoPayment, cryptoQuote);

    res.status(201).json({
      order,
      account: publicUser(user),
      cryptoPayment,
      cryptoQuote,
      cryptoInstructions: cryptoPayment ? cryptoPayment.instructions : null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/checkout/stripe', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured. Add STRIPE_SECRET_KEY after your payment processor setup is complete.' });
    }

    req.body.paymentMethod = 'stripe';
    const order = createOrderForUser(req.session.userId, req.body, 'Pending Payment');
    const lineItems = order.items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${item.name} — ${item.spec}`,
          description: 'Research-use-only catalog item'
        },
        unit_amount: Math.round(item.unitPrice * 100)
      }
    }));

    if (order.shippingCharge && order.shippingCharge > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Shipping — ${order.shipping.country}`,
            description: 'Shipping charge'
          },
          unit_amount: Math.round(order.shippingCharge * 100)
        }
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: `${PUBLIC_URL}/?checkout=success&order=${encodeURIComponent(order.id)}`,
      cancel_url: `${PUBLIC_URL}/?checkout=cancel&order=${encodeURIComponent(order.id)}`,
      metadata: {
        orderId: order.id,
        userId: req.session.userId
      }
    });

    db.prepare('UPDATE orders SET stripe_session_id = ?, updated_at = ? WHERE id = ?')
      .run(session.id, nowIso(), order.id);
    sendOrderEmailsSafely(order, null);

    res.status(201).json({ order, checkoutUrl: session.url });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
  res.json({ orders: rows.map(publicOrder) });
});

app.patch('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const status = String(req.body.status || '').trim();
  if (!status) return res.status(400).json({ error: 'Status is required.' });

  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found.' });

  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), req.params.id);
  res.json({ order: publicOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Server error. Please try again.' : error.message });
});

app.listen(PORT, () => {
  console.log(`ResearchPeps backend running at http://localhost:${PORT}`);
});