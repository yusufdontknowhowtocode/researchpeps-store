const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const Database=require('better-sqlite3');
const {createOrderNotifier}=require('../lib/order-notifications');

test('manual crypto confirmation queues the same paid event and sends once via the worker',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rp-manual-confirm-')),file=path.join(dir,'fixture.sqlite');
 const db=new Database(file),sent=[];
 try{
  db.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, notes TEXT, updated_at TEXT)');
  db.prepare('INSERT INTO orders VALUES (?,?,?,?)').run('RP_CRYPTO_FIXTURE','Awaiting Bitcoin (BTC) Payment','Saved note','original-time');
  const notifier=createOrderNotifier({db,from:'test@example.invalid',to:'owner@example.invalid',publicUrl:'https://example.invalid',transporter:{async sendMail(m){sent.push(m);return {accepted:[m.to]};}},getOrder:id=>db.prepare('SELECT * FROM orders WHERE id=?').get(id)});
  const run=()=>execFileSync(process.execPath,[path.join(__dirname,'../scripts/mark-crypto-paid.js'),'RP_CRYPTO_FIXTURE','fixture-tx'],{env:{...process.env,DATABASE_PATH:file,ADMIN_ORDER_NOTIFY_EMAIL:'owner@example.invalid'},stdio:'pipe'});
  run();await notifier.flush();
  assert.equal(sent.length,1);assert.match(sent[0].subject,/Payment confirmed/);
  run();await notifier.flush();
  assert.equal(sent.length,1);
  assert.equal(db.prepare("SELECT count(*) n FROM owner_order_emails WHERE event='paid'").get().n,1);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
