// Owner-only configuration and append-only snapshots. Never put source data in
// the public catalog, publicOrder(), customer receipts, or payment metadata.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadSourceConfig(raw, products) {
  if (!raw) return null;
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('Invalid internal sourcing configuration'); }
  if (!config.version || !config.variants || typeof config.variants !== 'object') throw new Error('Invalid internal sourcing configuration');
  const money = n => Number.isFinite(n) && n >= 0;
  const validSource = s => s && typeof s.source === 'string' && typeof s.code === 'string' &&
    money(s.supplierCost) && money(s.shipping) && money(s.landedCost) &&
    Math.abs(s.supplierCost + s.shipping - s.landedCost) < .001;
  for (const p of products.filter(p => p.active)) for (const o of p.options.filter(o => o.active)) {
    const v = config.variants[o.code];
    if (!v || v.productName !== p.name || v.spec !== o.spec || v.vialsPerKit !== 10 || !validSource(v.preferred) ||
        (v.fallback && (!validSource(v.fallback) || v.fallback.landedCost < v.preferred.landedCost))) {
      throw new Error('Internal sourcing coverage or cost mismatch');
    }
  }
  // Keep only the fields the owner needs, regardless of extra private inputs.
  const project = s => s ? { source: s.source, code: s.code, supplierCost: s.supplierCost, shipping: s.shipping, landedCost: s.landedCost } : null;
  return { version: String(config.version), digest: crypto.createHash('sha256').update(raw).digest('hex'),
    variants: Object.fromEntries(Object.entries(config.variants).map(([code,v]) => [code, {
      productName: v.productName, spec: v.spec, vialsPerKit: v.vialsPerKit,
      preferred: project(v.preferred), fallback: project(v.fallback)
    }])) };
}

function createSourceStore({ directory, config, logger = console }) {
  const root = path.resolve(directory);
  if (config) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const filename = id => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid order identifier');
    return path.join(root, id + '.json');
  };
  function capture(orderId, createdAt, items) {
    if (!config) return;
    const snapshot = { version: 1, orderId, capturedAt: createdAt, sourceVersion: config.version, sourceDigest: config.digest,
      estimateBasis: 'Independent one-kit procurement. Single-vial cost is allocated from kit inventory. Confirm stock, quality, import requirements and actual freight before ordering. No supplier order has been placed.',
      items: items.map(item => {
        const source = config.variants[item.optionCode];
        if (!source || source.productName !== item.productName) throw new Error('Source snapshot unavailable');
        const vialCount = item.quantity * (item.purchaseType === 'single' ? item.vialQuantity : source.vialsPerKit);
        return { productName: item.productName, optionCode: item.optionCode, orderedSpec: item.spec,
          quantity: item.quantity, purchaseType: item.purchaseType, vialCount, ...source,
          allocatedLandedCost: Math.round(source.preferred.landedCost * vialCount / source.vialsPerKit * 100) / 100 };
      }) };
    const target = filename(orderId), temp = path.join(root, '.' + crypto.randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(snapshot)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.chmodSync(temp, 0o400);
      // Hard-link publishes the complete file atomically and refuses overwrite.
      fs.linkSync(temp, target);
      const dirFd = fs.openSync(root, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') logger.error('Internal snapshot temporary-file cleanup failed'); }
    }
  }
  function read(orderId) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(filename(orderId), 'utf8'));
      if (snapshot.orderId !== orderId || snapshot.version !== 1 || !Array.isArray(snapshot.items)) throw new Error('Snapshot invalid');
      return snapshot;
    } catch (e) {
      if (e.code !== 'ENOENT') logger.error('Internal sourcing snapshot unavailable for order', orderId);
      // Never reconstruct historical sourcing using today's supplier prices.
      return null;
    }
  }
  return { capture, read, configured: Boolean(config) };
}

function sourcingText(snapshot) {
  if (!snapshot) return 'Internal sourcing: no snapshot recorded for this order. Do not assume current quotes applied to this historical order.';
  const money = n => '$' + Number(n).toFixed(2) + ' USD';
  return [`Internal sourcing — captured ${snapshot.capturedAt}; reference ${snapshot.sourceVersion}`, snapshot.estimateBasis,
    ...snapshot.items.map(item => `${item.productName} | ${item.orderedSpec} | ${item.optionCode} | ${item.vialCount} vials total\n` +
      `Preferred: ${item.preferred.source} (supplier code ${item.preferred.code})\n` +
      `Supplier cost / kit: ${money(item.preferred.supplierCost)} | Inbound assumption / kit: ${money(item.preferred.shipping)} | Estimated landed / kit: ${money(item.preferred.landedCost)}\n` +
      `Allocated landed cost for this order line: ${money(item.allocatedLandedCost)}\n` +
      (item.fallback ? `Fallback: ${item.fallback.source} (supplier code ${item.fallback.code}) | Landed / kit: ${money(item.fallback.landedCost)}` : 'Fallback: no second exact catalog source available.'))].join('\n\n');
}

module.exports = { loadSourceConfig, createSourceStore, sourcingText };
