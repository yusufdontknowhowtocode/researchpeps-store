// Availability is independent of historical order snapshots and stock flags.
function isPurchasableVariant(product, option) {
  return Boolean(product && option && product.active === true && option.active === true);
}

function activeProducts(products) {
  return products.filter(p => p.active === true).map(p => ({
    ...p, options: p.options.filter(o => isPurchasableVariant(p, o))
  })).filter(p => p.options.length);
}

function publicCatalog(products, stock = new Map()) {
  // Explicit projection: internal costs, sourcing and retirement reasons never leave here.
  return activeProducts(products).map(p => ({
    name: p.name, category: p.category, page: p.page, icon: p.icon,
    description: p.description, aliases: p.aliases || [], deliveryFormat: p.deliveryFormat,
    options: p.options.map(o => ({
      code: o.code, spec: o.spec, kitPrice: o.kitPrice, singlePrice: o.singlePrice,
      outOfStock: Boolean(stock.get(o.code))
    }))
  }));
}

const productSlug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
module.exports = { activeProducts, isPurchasableVariant, publicCatalog, productSlug };
