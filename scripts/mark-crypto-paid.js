require('dotenv').config();

const path = require('path');
const Database = require('better-sqlite3');

const orderId = process.argv[2];
const txHash = process.argv[3] || '';

if (!orderId) {
  console.error('Usage: node scripts/mark-crypto-paid.js ORDER_ID OPTIONAL_TX_HASH');
  console.error('Example: node scripts/mark-crypto-paid.js RP-20260531-4821 abc123txhash');
  process.exit(1);
}

const databasePath =
  process.env.DATABASE_PATH ||
  path.join(__dirname, '..', 'data', 'researchpeps.sqlite');

const db = new Database(databasePath);
const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

if (!order) {
  console.error(`Order not found: ${orderId}`);
  process.exit(1);
}

const verificationNote = txHash
  ? `Crypto payment verified. TX hash: ${txHash}`
  : 'Crypto payment verified manually.';

const newNotes = [order.notes, verificationNote]
  .filter(Boolean)
  .join('\n');

db.prepare(`
  UPDATE orders
  SET status = ?, notes = ?, updated_at = ?
  WHERE id = ?
`).run(
  'Paid - Crypto Verified',
  newNotes,
  new Date().toISOString(),
  orderId
);

console.log(`Order ${orderId} marked as Paid - Crypto Verified.`);
if (txHash) console.log(`TX hash saved: ${txHash}`);
