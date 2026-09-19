// Generic private procurement planner. Quotes and freight rules come only from
// owner configuration/snapshots, never from the public retail catalog.
const cents = n => Math.round(n * 100);
const dollars = n => n / 100;
const money = n => '$' + Number(n).toFixed(2) + ' USD';
const STOCK_NOTICE = 'Catalog-based recommendation — verify current stock before purchasing';

function validateShippingRules(rules) {
  if (rules == null) return null;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('Invalid private freight rules');
  const valid = n => Number.isFinite(n) && n >= 0;
  for (const rule of Object.values(rules)) {
    if (rule.type === 'shipment') {
      if (!valid(rule.fee) || (rule.freeAbove !== undefined && !valid(rule.freeAbove))) throw new Error('Invalid private shipment rule');
    } else if (rule.type === 'per-kit') {
      if (!Array.isArray(rule.tiers) || !rule.tiers.length || rule.tiers[0].minKits !== 1 || rule.tiers.some((t,i) => !Number.isInteger(t.minKits) || t.minKits < 1 || !valid(t.feePerKit) || (i && t.minKits <= rule.tiers[i-1].minKits))) throw new Error('Invalid private box rule');
    } else throw new Error('Unknown private freight rule');
  }
  return rules;
}

function shipmentCharge(rule, kits, subtotalCents) {
  if (!kits) return { cents: 0, calculation: 'No shipment' };
  if (rule.type === 'shipment') {
    const free = rule.freeAbove !== undefined && subtotalCents > cents(rule.freeAbove);
    return { cents: free ? 0 : cents(rule.fee), calculation: free ? `Supplier subtotal ${money(dollars(subtotalCents))} > ${money(rule.freeAbove)}: free inbound shipping` : `${money(rule.fee)} per shipment across ${kits} kit(s)` };
  }
  const tier = rule.tiers.filter(t => kits >= t.minKits).at(-1);
  return { cents: kits * cents(tier.feePerKit), calculation: `${kits} box(es) × ${money(tier.feePerKit)} per box` };
}

function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.optionCode;
    if (!groups.has(key)) groups.set(key, { optionCode: key, productName: item.productName, spec: item.spec || item.orderedSpec, vialCount: 0, preferred: item.preferred, fallback: item.fallback, options: item.options || [], lines: [] });
    const group = groups.get(key);
    group.vialCount += item.vialCount;
    group.lines.push({ spec: item.orderedSpec, quantity: item.quantity, purchaseType: item.purchaseType });
  }
  return [...groups.values()].map(g => {
    const cheapest = new Map();
    for (const o of g.options) if (!cheapest.has(o.source) || o.supplierCost < cheapest.get(o.source).supplierCost) cheapest.set(o.source, o);
    return { ...g, kits: Math.ceil(g.vialCount / 10), options: [...cheapest.values()].sort((a,b) => a.supplierCost-b.supplierCost || a.source.localeCompare(b.source)) };
  });
}

function materialize(groups, selections, rules) {
  const suppliers = new Map();
  const items = groups.map((g,i) => ({ optionCode: g.optionCode, productName: g.productName, spec: g.spec, vialCount: g.vialCount, kitsToPurchase: g.kits, remainingVials: g.kits*10-g.vialCount,
    allocations: selections[i].filter(x => x.kits).map(x => {
      const a = { source: x.quote.source, supplierCode: x.quote.code, kits: x.kits, supplierKitPrice: x.quote.supplierCost, supplierCost: dollars(cents(x.quote.supplierCost)*x.kits), shippingAllocation: 0, landedCost: 0 };
      if (!suppliers.has(a.source)) suppliers.set(a.source, { source:a.source, kits:0, subtotalCents:0, allocations:[] });
      const supplier = suppliers.get(a.source);supplier.kits += a.kits;supplier.subtotalCents += cents(a.supplierCost);supplier.allocations.push(a);
      return a;
    }) }));
  const shipments = [...suppliers.values()].map(s => {
    const charge = shipmentCharge(rules[s.source],s.kits,s.subtotalCents);
    const shares = s.allocations.map(a => Math.floor(charge.cents*a.kits/s.kits));
    let remaining = charge.cents-shares.reduce((a,b)=>a+b,0);
    s.allocations.forEach((a,i) => {
      const share=shares[i]+(remaining-- > 0 ? 1 : 0);
      a.shippingAllocation=dollars(share);a.landedCost=dollars(cents(a.supplierCost)+share);
      a.shippingCalculation=`${charge.calculation}; ${a.kits}/${s.kits} kit share = ${money(a.shippingAllocation)}`;
    });
    return {source:s.source,kits:s.kits,supplierCost:dollars(s.subtotalCents),shipping:dollars(charge.cents),landedCost:dollars(s.subtotalCents+charge.cents),calculation:charge.calculation};
  });
  return { items, shipments, totalSupplierCost:dollars(shipments.reduce((s,x)=>s+cents(x.supplierCost),0)), totalShipping:dollars(shipments.reduce((s,x)=>s+cents(x.shipping),0)), totalLandedCost:dollars(shipments.reduce((s,x)=>s+cents(x.landedCost),0)) };
}

// Exact branch-and-bound over whole-kit allocations, including splitting a SKU
// between catalogs. Repeated equivalent supplier baskets are memoized. A bounded
// search must explicitly fall back to an estimate, never claim an unproven optimum.
function solve(groups, rules, maxNodes=100000) {
  const sources=[...new Set(groups.flatMap(g=>g.options.map(o=>o.source)))].sort();
  const baskets=Object.fromEntries(sources.map(s=>[s,{kits:0,cost:0}]));
  const suffix=Array(groups.length+1).fill(0);
  for(let i=groups.length-1;i>=0;i--) suffix[i]=suffix[i+1]+Math.min(...groups[i].options.map(o=>cents(o.supplierCost)))*groups[i].kits;
  let best=materialize(groups,groups.map(g=>[{quote:g.options[0],kits:g.kits}]),rules),bestCents=cents(best.totalLandedCost),nodes=0,complete=true;
  const memo=new Set(),selected=[];
  function visit(i,baseCost) {
    if(++nodes>maxNodes){complete=false;return;}
    if(baseCost+suffix[i]>bestCents)return;
    if(i===groups.length){
      const total=baseCost+sources.reduce((sum,s)=>sum+shipmentCharge(rules[s],baskets[s].kits,baskets[s].cost).cents,0);
      if(total<bestCents){best=materialize(groups,selected,rules);bestCents=total;}
      return;
    }
    const key=i+'|'+sources.map(s=>baskets[s].kits+':'+baskets[s].cost).join('|');
    if(memo.has(key))return;memo.add(key);
    const g=groups[i],allocation=[];
    function distribute(j,left,added) {
      if(!complete)return;
      if(j===g.options.length){if(left)return;selected[i]=allocation.map(x=>({...x}));visit(i+1,baseCost+added);return;}
      const quote=g.options[j],b=baskets[quote.source];
      for(let q=left;q>=0;q--){
        if(j===g.options.length-1 && q!==left)break;
        const cost=q*cents(quote.supplierCost);allocation.push({quote,kits:q});b.kits+=q;b.cost+=cost;
        distribute(j+1,left-q,added+cost);
        b.kits-=q;b.cost-=cost;allocation.pop();if(!complete)return;
      }
    }
    distribute(0,g.kits,0);
  }
  visit(0,0);return { ...best, optimal:complete, searchNodes:nodes };
}

function standardEstimate(groups, reason) {
  return { mode:'standard-estimate', optimal:false, reason, stockNotice:STOCK_NOTICE,
    items:groups.map(g=>({optionCode:g.optionCode,productName:g.productName,spec:g.spec,vialCount:g.vialCount,kitsToPurchase:g.kits,manualReview:!g.preferred,
      allocations:g.preferred?[{source:g.preferred.source,supplierCode:g.preferred.code,kits:g.kits,supplierKitPrice:g.preferred.supplierCost,supplierCost:dollars(cents(g.preferred.supplierCost)*g.kits),shippingAllocation:dollars(cents(g.preferred.shipping)*g.kits),landedCost:dollars(cents(g.preferred.landedCost)*g.kits),shippingCalculation:`Saved standard allocation ${money(g.preferred.shipping)} × ${g.kits} kit(s); actual shipment unknown`}]:[],
      backup:g.fallback?{source:g.fallback.source,supplierCode:g.fallback.code,landedCost:dollars(cents(g.fallback.landedCost)*g.kits),basis:'Saved standard allocation; actual basket not calculated'}:null})) };
}

function createFulfillmentPlan(items, rules) {
  const groups=groupItems(items);
  if(!groups.length)return {mode:'manual',items:[],reason:'MANUAL SOURCING REVIEW REQUIRED'};
  if(groups.some(g=>!Number.isSafeInteger(g.kits)||g.kits<1))return {mode:'manual',items:[],reason:'MANUAL SOURCING REVIEW REQUIRED: ordered pack quantity is unknown'};
  if(!rules || groups.some(g=>!g.options.length || g.options.some(o=>!rules[o.source])))return standardEstimate(groups,'Full basket quotes or freight rules were not captured; recommendations use saved standard procurement assumptions.');
  if(groups.length>30 || groups.reduce((s,g)=>s+g.kits,0)>100)return standardEstimate(groups,'Large procurement basket requires manual optimization; saved standard procurement assumptions shown.');
  const result=solve(groups,rules);
  if(!result.optimal)return standardEstimate(groups,'Exact basket optimization exceeded its safe calculation limit; saved standard procurement assumptions shown.');
  for(let i=0;i<groups.length;i++){
    const chosen=result.items[i],used=new Set(chosen.allocations.map(a=>a.source));
    const alternatives=[];
    const candidates=groups[i].options.filter(o=>chosen.allocations.length>1 || !used.has(o.source));
    for(const quote of candidates){
      const alternative=solve(groups.map((g,j)=>j===i?{...g,options:[quote]}:g),rules,30000);
      if(alternative.optimal){const row=alternative.items[i];alternatives.push({source:quote.source,supplierCode:quote.code,landedCost:dollars(row.allocations.reduce((n,a)=>n+cents(a.landedCost),0)),orderLandedCost:alternative.totalLandedCost,basis:'Order re-optimized with this item assigned to the backup supplier; other assignments may change'});}
    }
    chosen.backup=alternatives.sort((a,b)=>a.orderLandedCost-b.orderLandedCost||a.source.localeCompare(b.source))[0]||null;
    if(!chosen.backup && candidates.length)chosen.backupReview='MANUAL SOURCING REVIEW REQUIRED: fallback optimization incomplete';
  }
  return {...result,mode:'order-basket',stockNotice:STOCK_NOTICE,assumptions:'Order-only procurement estimate: assumes no usable stock on hand and no other customer orders combined. Buy whole 10-vial kits; repeated single-vial lines of the same strength share a kit. Freight uses this inferred basket, not the retail-pricing allocation. Confirm actual inventory, shipment eligibility and current stock before purchasing. No automatic supplier purchase.'};
}

function fulfillmentText(snapshot) {
  if(!snapshot)return 'INTERNAL SOURCING RECOMMENDATION\nMANUAL SOURCING REVIEW REQUIRED\nNo sourcing snapshot exists for this order. Historical quotes are not reconstructed.';
  const plan=snapshot.fulfillmentPlan || standardEstimate(groupItems(snapshot.items),'Legacy immutable snapshot: complete basket options were not recorded; saved standard estimates only.');
  const lines=['INTERNAL SOURCING RECOMMENDATION',STOCK_NOTICE,`Quote snapshot: ${snapshot.sourceVersion} — ${snapshot.capturedAt}`,plan.assumptions||plan.reason||''];
  if(plan.mode==='order-basket'){
    lines.push(`Best order-level plan for the stated basket: supplier kits ${money(plan.totalSupplierCost)} + inbound ${money(plan.totalShipping)} = ${money(plan.totalLandedCost)}`);
    lines.push('Plans are ranked by whole-order cost. A backup item can have a lower allocated cost while making the whole order more expensive.');
    for(const s of plan.shipments)lines.push(`${s.source}: ${s.kits} kit(s); ${s.calculation}; shipment landed ${money(s.landedCost)}`);
  }
  for(const item of plan.items){
    lines.push(`\nPURCHASE RECOMMENDATION\n${item.productName} | ${item.spec} | ${item.optionCode}\nOrdered: ${item.vialCount} vial(s); procure ${item.kitsToPurchase} full 10-vial kit(s) if no usable inventory is on hand. Check inventory before purchasing.`);
    if(item.manualReview||!item.allocations.length){lines.push('MANUAL SOURCING REVIEW REQUIRED');continue;}
    for(const a of item.allocations)lines.push(`Recommended supplier/catalog: ${a.source}\nSupplier product code: ${a.supplierCode}\nBuy: ${a.kits} × 10-vial kit\nSupplier kit price: ${money(a.supplierKitPrice)}\nInbound shipping calculation: ${a.shippingCalculation}\nEstimated landed cost: ${money(a.landedCost)} for ${a.kits} kit(s)`);
    if(item.backup)lines.push(`Backup supplier: ${item.backup.source} (${item.backup.supplierCode})\nBackup landed cost: ${money(item.backup.landedCost)}${item.backup.orderLandedCost!==undefined?`; revised whole-order landed ${money(item.backup.orderLandedCost)}`:''}\n${item.backup.basis}`);
    else lines.push(`Backup supplier: ${item.backupReview||'No additional exact catalog source recorded.'}\nBackup landed cost: Not available`);
  }
  return lines.join('\n\n');
}

module.exports={validateShippingRules,shipmentCharge,createFulfillmentPlan,fulfillmentText};
