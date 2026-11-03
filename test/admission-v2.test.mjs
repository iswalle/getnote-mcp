import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {GetNoteClient,GetNoteAPIError} from '../dist/client.js';

const refusal={dimension:'qps',bucket:'global',request_execution:'not_started',retry_action:'retry_same_operation',retryable:true,retry_after_ms:1,future:{version:3}};
async function fixture(t,handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))});return `http://127.0.0.1:${server.address().port}`;}
function fail(res,detail=refusal){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({success:false,error:{code:10202,reason:'qps_exceeded',message:'wait',retryable:true,rate_limit_detail:detail},request_id:'v2-request'}));}
function ok(res,data={id:'1'}){res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));}

test('v2 refusal retries identical note body including uploaded URLs and note key',async t=>{
 const bodies=[];const base=await fixture(t,(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{bodies.push(body);if(bodies.length===1)fail(res);else ok(res)})});
 const client=new GetNoteClient('key','client',base);await client.saveNote({content:'photo',note_type:'img_text',image_urls:['https://oss.test/original'],client_request_id:'note-original'});
 assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[1]).client_request_id,'note-original');
});
test('v2 full detail survives refusal without replay for unsafe execution and malformed detail',async t=>{
 for(const detail of [{...refusal,request_execution:'admitted'},{...refusal,request_execution:'unknown'},{...refusal,dimension:'day'},null,{...refusal,retryable:'true'}]){
  let calls=0;const base=await fixture(t,(req,res)=>{calls++;fail(res,detail)});await assert.rejects(()=>new GetNoteClient('key','client',base).getNote('1'),e=>{assert(e instanceof GetNoteAPIError);assert.deepEqual(e.rateLimitDetail,detail);assert.equal(e.requestId,'v2-request');return true});assert.equal(calls,1);
 }
});
test('same process identity serializes across retries; a separate authorization is independent',async t=>{
 const order=[];let first=true;const base=await fixture(t,(req,res)=>{const id=new URL(req.url,'http://local').searchParams.get('id');order.push(id);if(id==='1'&&first){first=false;fail(res,{...refusal,retry_after_ms:120})}else ok(res)});
 const one=new GetNoteClient('key','client',base);const two=new GetNoteClient('key','client',base+'/open');const other=new GetNoteClient('other','client',base);
 const firstCall=one.getNote('1');await new Promise(r=>setTimeout(r,25));await Promise.all([firstCall,two.withSignal(new AbortController().signal).getNote('2'),other.getNote('3')]);assert.deepEqual(order,['1','3','1','2']);
});
test('queue cancellation stops a queued identity call before HTTP dispatch',async t=>{
 const ids=[];let release;const held=new Promise(r=>release=r);const base=await fixture(t,async(req,res)=>{ids.push(new URL(req.url,'http://local').searchParams.get('id'));if(ids.length===1)await held;ok(res)});
 const c=new GetNoteClient('key','client',base);const first=c.getNote('1');await new Promise(r=>setTimeout(r,25));const abort=new AbortController();const queued=c.withSignal(abort.signal).getNote('2');abort.abort(new Error('stop queued'));await assert.rejects(queued,/stop queued/);release();await first;assert.deepEqual(ids,['1']);
});
test('learned quota policy paces subsequent requests using effective global rate',async t=>{
 const times=[];const base=await fixture(t,(req,res)=>{times.push(Date.now());ok(res,req.url.includes('/quota')?{rate_limit_policy:{version:'custom',rates:{global:{sustained_rate_per_second:20}}}}:{id:'1'})});
 const c=new GetNoteClient('key','client',base);await c.getQuota();await Promise.all([c.getNote('1'),new GetNoteClient('key','client',base).getNote('2')]);assert.ok(times[2]-times[1]>=40,`${times}`);
});

test('retry pacing cannot extend the bounded wait budget and keeps original advice',async t=>{
 let calls=0;const base=await fixture(t,(req,res)=>{calls++;fail(res,{...refusal,sustained_rate_per_second:0.01})});
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(new Error('test deadline')),300);const start=Date.now();
 try{await assert.rejects(()=>new GetNoteClient('key','client',base).withSignal(abort.signal).saveNote({content:'once'}),e=>e instanceof GetNoteAPIError&&e.requestId==='v2-request');assert.ok(Date.now()-start<200);assert.equal(calls,1)}finally{clearTimeout(timer);abort.abort()}
});
test('safe retry snapshots the original body before caller data can mutate',async t=>{
 const bodies=[];const body={content:'original',image_urls:['https://oss.test/original'],client_request_id:'same-key'};
 const base=await fixture(t,(req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{bodies.push(raw);if(bodies.length===1){body.content='mutated';body.image_urls.push('https://oss.test/unrelated');fail(res)}else ok(res)})});
 await new GetNoteClient('key','client',base).saveNote(body);assert.deepEqual(bodies.map(JSON.parse),[{content:'original',image_urls:['https://oss.test/original'],client_request_id:'same-key'},{content:'original',image_urls:['https://oss.test/original'],client_request_id:'same-key'}]);
});
test('QPS error advice paces the next queued request even if the refused operation cannot retry',async t=>{
 const times=[];const base=await fixture(t,(req,res)=>{times.push(Date.now());if(times.length===1)fail(res,{...refusal,request_execution:'admitted',sustained_rate_per_second:20});else ok(res)});
 const c=new GetNoteClient('key','client',base);await assert.rejects(()=>c.saveNote({content:'refused'}));await c.getNote('1');assert.ok(times[1]-times[0]>=40);
});

test('idle identity entries expire with advisory pacing instead of retaining authorization state forever',async t=>{
 const {inAuthorizationQueue,learnPolicy,pace}=await import('../dist/admission.js');
 t.mock.timers.enable({apis:['setTimeout']});
 await inAuthorizationQueue('idle-test-only',undefined,async queue=>{learnPolicy(queue,{rate_limit_policy:{rates:{global:{sustained_rate_per_second:0.01}}}});assert.equal(await pace(queue,'read'),true)});
 t.mock.timers.tick(300001);
 const admitted=await inAuthorizationQueue('idle-test-only',undefined,queue=>pace(queue,'read',undefined,0));
 assert.equal(admitted,true,'the expired identity must not retain its old pacing state');
});

test('v2 refuses malformed outer retryability, malformed wait and unknown operations',async t=>{
 const {readRetryDelay}=await import('../dist/read-retry.js');
 const error={httpStatus:429,code:10202,reason:'qps_exceeded',retryable:true,rateLimitDetail:refusal};
 assert.equal(readRetryDelay('POST','/resource/note/save',{...error,retryable:'true'},0,0),undefined);
 assert.equal(readRetryDelay('POST','/resource/note/save',{...error,rateLimitDetail:{...refusal,retry_after_ms:'1'}},0,0),undefined);
 assert.equal(readRetryDelay('GET','/resource/new-upload',error,0,0),undefined);
 assert.equal(readRetryDelay('POST','/resource/unknown-write',error,0,0),undefined);
 assert.equal(readRetryDelay('GET','/resource/image/upload_token',error,0,0),undefined);
});
