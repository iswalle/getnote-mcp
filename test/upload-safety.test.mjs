import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {GetNoteClient} from '../dist/client.js';

const canonical='/open/api/v1/resource/image/upload_operation';
const future='2099-01-01T00:00:00Z';
const past='2000-01-01T00:00:00Z';
const runtime={governance_enabled:true,operation_replay:true,idempotency_header:'Idempotency-Key',operation_status_endpoint:canonical};
function ok(res,data){res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));}
async function fixture(t,handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))});return `http://127.0.0.1:${server.address().port}`;}

// Successful HTTP status cannot turn an expired or mismatched credential into a usable one.
test('successful issuance rejects expired credentials and does not relabel a different operation',async t=>{
 for(const [name,credential,reason]of [
  ['expired',{operation_id:'original',resume_until:past},'credential_operation_expired'],
  ['mismatched',{operation_id:'other-operation',resume_until:future},'credential_operation_conflict'],
 ])await t.test(name,async t=>{
  let issues=0,lookups=0;
  const base=await fixture(t,(req,res)=>{
   if(req.url.includes('/config'))return ok(res,{runtime});
   if(req.url.includes('/upload_operation')){lookups++;return ok(res,{operation_id:'original',state:'processing',resume_until:future})}
   issues++;ok(res,{...credential,signature:'DO_NOT_USE'});
  });
  await assert.rejects(()=>new GetNoteClient('key','client',base).getUploadToken({operation_id:'original',mime_type:'png'}),e=>e.reason===reason&&e.operationId==='original'&&!JSON.stringify(e).includes('DO_NOT_USE'));
  assert.equal(issues,1);assert.equal(lookups,0);
 });
});

// The original credential deadline is the lower bound, even if the lookup view
// advertises a later deadline; its identity may never be silently overwritten.
test('operation lookup rejects expired nested credentials and mismatched nested IDs',async t=>{
 for(const [name,credential,reason]of [
  ['expired nested',{operation_id:'original',resume_until:past},'credential_operation_expired'],
  ['wrong nested ID',{operation_id:'different',resume_until:future},'credential_operation_conflict'],
 ])await t.test(name,async t=>{
  let issues=0;
  const base=await fixture(t,(req,res)=>{
   if(req.url.includes('/config'))return ok(res,{runtime});
   if(req.url.includes('/upload_token')){issues++;req.socket.destroy();return}
   ok(res,{operation_id:'original',state:'issued',resume_until:future,credential:{...credential,signature:'DO_NOT_USE'}});
  });
  const c=new GetNoteClient('key','client',base);
  await assert.rejects(()=>c.getUploadOperation('original'),e=>e.reason===reason&&!JSON.stringify(e).includes('DO_NOT_USE'));
  await assert.rejects(()=>c.getUploadToken({operation_id:'original',mime_type:'png'}),e=>e.reason===reason&&e.operationId==='original');
  assert.equal(issues,1);
 });
});

test('recovered credential keeps its earlier original deadline',async t=>{
 const earlier='2090-01-01T00:00:00Z';let issues=0;
 const base=await fixture(t,(req,res)=>{
  if(req.url.includes('/config'))return ok(res,{runtime});
  if(req.url.includes('/upload_token')){issues++;req.socket.destroy();return}
  ok(res,{operation_id:'original',state:'issued',resume_until:future,credential:{operation_id:'original',resume_until:earlier,object_key:'original'}});
 });
 const c=new GetNoteClient('key','client',base);
 const recovered=await c.getUploadToken({operation_id:'original',mime_type:'png'});
 assert.equal(recovered.resume_until,earlier);assert.equal(issues,1);
 const view=await c.getUploadOperation('original');assert.equal(view.resume_until,earlier);assert.equal(view.credential.resume_until,earlier);
});

// Following a credential GET redirect would issue outside the single negotiated
// request and evade the lost-response lookup path.
test('credential redirect is not followed and only the original operation is queried',async t=>{
 let issues=0,redirected=0,lookups=0;
 const base=await fixture(t,(req,res)=>{
  if(req.url.includes('/config'))return ok(res,{runtime});
  if(req.url.includes('/upload_token')){issues++;res.writeHead(302,{Location:'/second-mint'});res.end();return}
  if(req.url==='/second-mint'){redirected++;return ok(res,{operation_id:'original',resume_until:future,object_key:'wrong-redirect-result'})}
  lookups++;ok(res,{operation_id:'original',state:'issued',resume_until:future,credential:{operation_id:'original',resume_until:future,object_key:'original-object'}});
 });
 const result=await new GetNoteClient('key','client',base).getUploadToken({operation_id:'original',mime_type:'png'});
 assert.equal(result.object_key,'original-object');assert.equal(issues,1);assert.equal(redirected,0);assert.equal(lookups,1);
});

test('only the verified full canonical operation endpoint enables recoverable issuance',async t=>{
 for(const endpoint of ['/resource/image/upload_operation','/api/v1/resource/image/upload_operation','/open/api/v1/resource/image/upload_operation?other=1'])await t.test(endpoint,async t=>{
  let issues=0;
  const base=await fixture(t,(req,res)=>{if(req.url.includes('/config'))return ok(res,{runtime:{...runtime,operation_status_endpoint:endpoint}});issues++;ok(res,{operation_id:'original',resume_until:future});});
  await assert.rejects(()=>new GetNoteClient('key','client',base).getUploadToken({operation_id:'original',mime_type:'png'}),e=>e.reason==='upload_operation_unsupported');assert.equal(issues,0);
 });
});

test('failed recovery lookup retains the original issuance request ID',async t=>{
 const base=await fixture(t,(req,res)=>{
  if(req.url.includes('/config'))return ok(res,{runtime});
  const issuing=req.url.includes('/upload_token');
  res.writeHead(issuing?409:503,{'content-type':'application/json'});
  res.end(JSON.stringify({success:false,error:{code:issuing?40901:50300,reason:issuing?'credential_operation_unconfirmed':'credential_operation_unavailable',retryable:false},request_id:issuing?'original-issuance-request':'lookup-request'}));
 });
 await assert.rejects(()=>new GetNoteClient('key','client',base).getUploadToken({operation_id:'original',mime_type:'png'}),e=>e.operationId==='original'&&e.requestId==='original-issuance-request');
});

test('server cooldown survives a non-retryable call and blocks the next same-identity tool',async t=>{
 let calls=0;
 const base=await fixture(t,(req,res)=>{
  calls++;
  if(calls===1){res.writeHead(429,{'content-type':'application/json','retry-after':'1'});res.end(JSON.stringify({success:false,error:{code:10202,reason:'qps_global_exceeded',retryable:false,rate_limit_detail:{dimension:'qps',bucket:'global',request_execution:'admitted',retry_action:'inspect',retryable:false,retry_after_ms:200}}}));return}
  ok(res,{id:'1'});
 });
 const c=new GetNoteClient('key','client',base);
 await assert.rejects(()=>c.saveNote({content:'refused'}));
 await assert.rejects(()=>c.withSignal(AbortSignal.timeout(30)).getNote('1'));
 assert.equal(calls,1);
 await new GetNoteClient('other-key','client',base).getNote('2');assert.equal(calls,2);
});

// File capabilities require topic.read while issuance requires topic.write.
// A write-only grant may keep legacy one-shot issuance without asserting replay.
test('file capability 403 keeps default write-only issuance but explicit recovery remains unsupported',async t=>{
 let issues=0,configs=0;
 const base=await fixture(t,(req,res)=>{
  if(req.url.includes('/capabilities')){configs++;res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({success:false,error:{code:40300,reason:'insufficient_scope',message:'topic.read required',retryable:false}}));return}
  issues++;assert.equal(req.headers['idempotency-key'],undefined);ok(res,{object_key:'legacy-write-only'});
 });
 const c=new GetNoteClient('key','client',base);
 assert.equal((await c.getKnowledgeFileUploadToken('pdf')).object_key,'legacy-write-only');
 await assert.rejects(()=>c.getKnowledgeFileUploadToken('pdf','original'),e=>e.reason==='upload_operation_unsupported');
 assert.equal(issues,1);assert.equal(configs,1);
});

test('image configuration 403 and file configuration 503 do not permit blind issuance',async t=>{
 for(const [kind,status]of [['image',403],['file',503]])await t.test(`${kind} ${status}`,async t=>{
  let issues=0;
  const base=await fixture(t,(req,res)=>{
   if(req.url.includes('/config')||req.url.includes('/capabilities')){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({success:false,error:{code:status*100,reason:'configuration_unavailable',retryable:false}}));return}
   issues++;ok(res,{});
  });
  const c=new GetNoteClient('key','client',base);
  await assert.rejects(()=>kind==='file'?c.getKnowledgeFileUploadToken('pdf'):c.getUploadToken({mime_type:'png'}));assert.equal(issues,0);
 });
});
