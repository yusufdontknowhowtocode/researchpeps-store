const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createFulfillmentPlan,shipmentCharge,validateShippingRules,fulfillmentText}=require('../lib/fulfillment-sourcing');
const rules={A:{type:'shipment',fee:20},B:{type:'shipment',fee:0}};
function item(code,prices,vials=10){
 const options=Object.entries(prices).map(([source,supplierCost])=>({source,code:source+'-'+code,supplierCost,shipping:4,landedCost:supplierCost+4}));
 return {optionCode:code,productName:'Fixture '+code,spec:'10mg*10 vials',orderedSpec:vials===1?'1 vial • 10mg each':'10mg*10 vials',purchaseType:vials===1?'single':'kit',quantity:1,vialCount:vials,preferred:options[0],fallback:options[1],options};
}
test('combining different items changes the cheapest catalog; shipping allocated exactly once',()=>{
 const a=item('X',{A:100,B:112},1),b=item('Y',{A:100,B:112});
 assert.equal(createFulfillmentPlan([a],rules).items[0].allocations[0].source,'B');
 const p=createFulfillmentPlan([a,b],rules);
 assert.equal(p.optimal,true);assert.equal(p.totalLandedCost,220);assert.equal(p.totalShipping,20);
 assert.deepEqual(p.items.map(i=>i.allocations[0].source),['A','A']);
 assert.deepEqual(p.items.map(i=>i.allocations[0].shippingAllocation),[10,10]);
 assert.equal(p.items[0].kitsToPurchase,1);assert.equal(p.items[0].remainingVials,9);
 assert.equal(p.items[0].backup.source,'B');assert.equal(p.items[0].backup.orderLandedCost,224);
});
test('freight thresholds use actual supplier subtotal and actual kit count, including boundaries',()=>{
 const shipment={type:'shipment',fee:20,freeAbove:200};
 assert.equal(shipmentCharge(shipment,2,20000).cents,2000);
 assert.equal(shipmentCharge(shipment,2,20001).cents,0);
 const box={type:'per-kit',tiers:[{minKits:1,feePerKit:12},{minKits:5,feePerKit:8},{minKits:10,feePerKit:4}]};
 for(const [kits,expected]of [[4,4800],[5,4000],[9,7200],[10,4000]])assert.equal(shipmentCharge(box,kits,1).cents,expected);
 assert.equal(shipmentCharge(box,0,0).cents,0);
 assert.throws(()=>validateShippingRules({A:{type:'per-kit',tiers:[]}}));
});
test('same-strength single lines share a kit; a kit plus one vial needs two full kits',()=>{
 const a=item('X',{A:30,B:100},1),b=item('X',{A:30,B:100},1);
 assert.equal(createFulfillmentPlan([a,b],rules).items[0].kitsToPurchase,1);
 const p=createFulfillmentPlan([a,item('X',{A:30,B:100})],rules);
 assert.equal(p.items[0].kitsToPurchase,2);assert.equal(p.totalSupplierCost,60);
 assert.equal(p.totalLandedCost,80);
});
test('one SKU may split between suppliers to activate a basket free-shipping threshold',()=>{
 // Another item must use A; adding one kit of X reaches free shipping. Buying
 // every X from A costs more, so an exact plan must consider splitting X.
 const p=createFulfillmentPlan([item('Y',{A:90}),item('X',{A:12,B:10},100)],{A:{type:'shipment',fee:50,freeAbove:100},B:{type:'shipment',fee:0}});
 assert.equal(p.optimal,true);assert.equal(p.totalLandedCost,192);
 assert.deepEqual(p.items[1].allocations.map(a=>[a.source,a.kits]).sort(),[['A',1],['B',9]]);
});
test('solver agrees with independent exhaustive enumeration of small multi-source baskets',()=>{
 const freight={A:{type:'shipment',fee:17},B:{type:'shipment',fee:13,freeAbove:120},C:{type:'per-kit',tiers:[{minKits:1,feePerKit:9},{minKits:3,feePerKit:4}]}};
 for(let seed=1;seed<=12;seed++){
  const items=Array.from({length:4},(_,i)=>item('Q'+i,{A:20+(seed*(i+1)*7)%45,B:25+(seed*(i+2)*3)%40,C:18+(seed*(i+3)*5)%50}));
  let expected=Infinity;
  for(let code=0;code<81;code++){
   let n=code;const sums={A:0,B:0,C:0},counts={A:0,B:0,C:0};
   for(const x of items){const s=['A','B','C'][n%3];n=Math.floor(n/3);sums[s]+=x.options.find(o=>o.source===s).supplierCost;counts[s]++;}
   const total=sums.A+sums.B+sums.C+(counts.A?17:0)+(counts.B&&sums.B<=120?13:0)+counts.C*(counts.C>=3?4:9);
   expected=Math.min(expected,total);
  }
  const p=createFulfillmentPlan(items,freight);assert.equal(p.optimal,true);assert.equal(p.totalLandedCost,expected);
  assert.equal(Math.round(p.items.flatMap(i=>i.allocations).reduce((n,a)=>n+a.landedCost,0)*100),Math.round(expected*100));
 }
});
test('unknown sourcing and legacy snapshots clearly require review or disclose a standard estimate',()=>{
 assert.match(fulfillmentText(null),/MANUAL SOURCING REVIEW REQUIRED/);
 const missing={optionCode:'MISSING',productName:'Fixture',vialCount:1,quantity:1,options:[]};
 const p=createFulfillmentPlan([missing],null);assert.equal(p.items[0].manualReview,true);
 const text=fulfillmentText({sourceVersion:'old',capturedAt:'saved',items:[item('X',{A:30})]});
 assert.match(text,/Legacy immutable snapshot/);assert.match(text,/Catalog-based recommendation — verify current stock before purchasing/);
 assert.doesNotMatch(text,/Best order-level plan/);
});
