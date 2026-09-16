const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSourceConfig, createSourceStore, sourcingText } = require('../lib/order-sourcing');
const { ownerMessage } = require('../lib/order-notifications');
const products = [{ name: 'Fixture reagent', active: true, options: [{code:'FIX10', spec:'10mg*10 vials', active:true}] }];
const raw = cost => JSON.stringify({version:'fixture-v1',variants:{FIX10:{productName:'Fixture reagent',spec:'10mg*10 vials',vialsPerKit:10,preferred:{source:'PRIVATE_FIXTURE_A',code:'A1',supplierCost:cost,shipping:30,landedCost:cost+30},fallback:{source:'PRIVATE_FIXTURE_B',code:'B1',supplierCost:cost+10,shipping:50,landedCost:cost+60}}}});
const line={productName:'Fixture reagent',optionCode:'FIX10',spec:'2 vials • 10mg each',quantity:3,purchaseType:'single',vialQuantity:2};

test('immutable persisted sourcing survives changed configuration and restarts; singles allocate inventory cost',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rp-sourcing-'));
 try {
  const first=createSourceStore({directory,config:loadSourceConfig(raw(100),products)});
  first.capture('RP_FIX','2026-09-16T00:00:00Z',[line]);
  const before=fs.readFileSync(path.join(directory,'RP_FIX.json'),'utf8');
  const second=createSourceStore({directory,config:loadSourceConfig(raw(500),products)});
  assert.equal(second.read('RP_FIX').items[0].preferred.landedCost,130);
  assert.equal(second.read('RP_FIX').items[0].allocatedLandedCost,78);
  assert.equal(second.read('RP_FIX').items[0].vialCount,6);
  assert.throws(()=>second.capture('RP_FIX','2027-01-01',[line]),{code:'EEXIST'});
  assert.equal(fs.readFileSync(path.join(directory,'RP_FIX.json'),'utf8'),before);
  assert.equal(second.read('RP_OLD'),null);
  assert.match(sourcingText(null),/no snapshot recorded/);
  assert.throws(()=>second.capture('../escape','now',[line]),/Invalid order identifier/);
  assert.deepEqual(fs.readdirSync(directory),['RP_FIX.json']);
  assert.equal(fs.statSync(path.join(directory,'RP_FIX.json')).mode & 0o777,0o400);
  second.capture('RP_KIT','now',[{...line,purchaseType:'kit',quantity:2}]);
  assert.equal(second.read('RP_KIT').items[0].vialCount,20);
  assert.equal(second.read('RP_KIT').items[0].allocatedLandedCost,1060);
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('configuration rejects missing coverage, spec mismatch and bad arithmetic without leaking source data',()=>{
 assert.equal(loadSourceConfig('',products),null);
 for(const edit of [c=>delete c.variants.FIX10,c=>c.variants.FIX10.spec='5mg*10 vials',c=>c.variants.FIX10.preferred.landedCost=1,c=>c.variants.FIX10.fallback.landedCost=1]){
  const c=JSON.parse(raw(100));edit(c);
  assert.throws(()=>loadSourceConfig(JSON.stringify(c),products),e=>!e.message.includes('PRIVATE_FIXTURE')&&/mismatch/.test(e.message));
 }
});

test('owner message displays estimates and escapes source labels',()=>{
 const text=ownerMessage({id:'RP1',items:[],internalSourcing:{capturedAt:'now',sourceVersion:'fixture',estimateBasis:'No automatic procurement',items:[{productName:'Fixture',orderedSpec:'10mg',optionCode:'FIX10',vialCount:10,allocatedLandedCost:130,preferred:{source:'<script>bad</script>',code:'CODE',supplierCost:100,shipping:30,landedCost:130},fallback:null}]}},{from:'test@example.com',to:'owner@example.com',publicUrl:'https://example.com'});
 assert.match(text.text,/Supplier cost \/ kit: \$100.00/);
 assert.match(text.text,/Inbound assumption \/ kit: \$30.00/);
 assert.match(text.text,/no second exact catalog source/);
 assert.ok(!text.html.includes('<script>'));
 assert.ok(text.html.includes('&lt;script&gt;'));
});

test('retail ladders and advertised kit value are consistent for all active variants',()=>{
 const catalog=require('../data/products.json');
 const groups=new Map();
 for(const p of catalog.filter(p=>p.active))for(const o of p.options.filter(o=>o.active)){
  assert.ok(!/weight loss|appetite|bodybuilding|blood sugar|recovery|treatment/i.test(p.description));
  const saving=1-o.kitPrice/(10*o.singlePrice);
  assert.ok(saving>=.32&&saving<=.38,`${o.code}: ${saving}`);
  assert.equal(Math.round(o.kitPrice*100)%100,99);
  assert.equal(Math.round(o.singlePrice*100)%100,99);
  const key=/^BPC-157 (5|10)mg \+ TB-500 (5|10)mg$/.test(p.name)?'BPC-TB blend':p.name;
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...o,strength:parseFloat(o.spec)});
 }
 for(const options of groups.values()){
  options.sort((a,b)=>a.strength-b.strength);
  for(let i=1;i<options.length;i++){
   const a=options[i-1],b=options[i];
   assert.ok(b.kitPrice>a.kitPrice);assert.ok(b.singlePrice>a.singlePrice);
   assert.ok(b.kitPrice/b.strength<=a.kitPrice/a.strength);
   assert.ok(b.singlePrice/b.strength<=a.singlePrice/a.strength);
  }
 }
});
