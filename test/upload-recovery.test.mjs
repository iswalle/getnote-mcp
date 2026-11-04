import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {GetNoteClient,GetNoteAPIError} from '../dist/client.js';

const routes={image:'/resource/image',file:'/resource/knowledge/file'};
function runtime(kind){return {governance_enabled:true,operation_replay:true,idempotency_header:'Idempotency-Key',operation_status_endpoint:'/open/api/v1'+routes[kind]+'/upload_operation'};}
function ok(res,data){res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));}
function fail(res,reason,code=40901,status=409){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({success:false,error:{code,reason,message:reason,retryable:false},request_id:'req-operation'}));}
async function fixture(t,handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))});return `http://127.0.0.1:${server.address().port}`;}
function issue(client,kind,id){return kind==='image'?client.getUploadToken({mime_type:'png',operation_id:id}):client.getKnowledgeFileUploadToken('pdf',id);}
function token(){return {resume_until:'2099-01-01T00:00:00Z',signature:'SENSITIVE_SIGNATURE',access_url:'https://oss.test/original'};}

test('lost credential response recovers exactly the original operation without minting again',async t=>{
 for(const kind of ['image','file'])await t.test(kind,async t=>{
  let minted=0;let key;const queries=[];
  const base=await fixture(t,(req,res)=>{const url=new URL(req.url,'http://local');if(url.pathname.endsWith('/config')||url.pathname.endsWith('/capabilities'))return ok(res,{runtime:runtime(kind)});if(url.pathname.endsWith('/upload_token')){minted++;key=req.headers['idempotency-key'];req.socket.destroy();return}queries.push(url.searchParams.get('operation_id'));ok(res,{operation_id:key,state:'issued',resume_until:'2099-01-01T00:00:00Z',credential:token()})});
  const result=await issue(new GetNoteClient('key','client',base),kind,undefined);assert.equal(result.access_url,'https://oss.test/original');assert.match(key,/^[A-Za-z0-9._:-]{1,128}$/);assert.equal(result.operation_id,key);assert.equal(minted,1);assert.deepEqual(queries,[key]);
 });
});
test('negotiated credential QPS retry reuses the exact header and query',async t=>{
 const calls=[];const base=await fixture(t,(req,res)=>{if(req.url.includes('/config'))return ok(res,{runtime:runtime('image')});calls.push({url:req.url,key:req.headers['idempotency-key']});if(calls.length===1){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({success:false,error:{code:10202,reason:'qps_exceeded',message:'wait',retryable:true,rate_limit_detail:{dimension:'qps',request_execution:'not_started',retry_action:'retry_same_operation',retryable:true,retry_after_ms:1}}}));return}ok(res,token())});
 await issue(new GetNoteClient('key','client',base),'image','original:key');assert.deepEqual(calls,[{url:'/open/api/v1/resource/image/upload_token?mime_type=png',key:'original:key'},{url:'/open/api/v1/resource/image/upload_token?mime_type=png',key:'original:key'}]);
});
test('legacy and disabled runtime omit idempotency header; explicit recovery fails before mint',async t=>{
 for(const rt of [undefined,{...runtime('image'),governance_enabled:false},{...runtime('image'),operation_replay:false},{...runtime('image'),idempotency_header:'Other-Key'}]){
  const minted=[];const base=await fixture(t,(req,res)=>{if(req.url.includes('/config'))return ok(res,{runtime:rt});minted.push(req.headers['idempotency-key']);ok(res,token())});const c=new GetNoteClient('key','client',base);await issue(c,'image');assert.deepEqual(minted,[undefined]);await assert.rejects(()=>issue(c,'image','explicit-key'),e=>e.reason==='upload_operation_unsupported'&&e.retryable===false);assert.equal(minted.length,1);
 }
});
test('invalid operation identifiers never reach configuration or issuance',async t=>{
 let requests=0;const base=await fixture(t,(req,res)=>{requests++;ok(res,{})});for(const id of ['', 'bad key','a'.repeat(129)])await assert.rejects(()=>issue(new GetNoteClient('key','client',base),'image',id),/operation_id/);assert.equal(requests,0);
});
test('unconfirmed, unavailable, expiry and unknown lookup keep original key and do not remint',async t=>{
 for(const [issueReason,statusState]of [['credential_operation_unconfirmed','processing'],['credential_operation_unavailable','needs_reconciliation'],['credential_operation_unconfirmed','expired'],['credential_operation_unavailable','not_found']]){
  let minted=0,lookups=0;const base=await fixture(t,(req,res)=>{if(req.url.includes('/capabilities'))return ok(res,{runtime:runtime('file')});if(req.url.includes('/upload_token')){minted++;return fail(res,issueReason)}lookups++;if(statusState==='not_found')return fail(res,'credential_operation_not_found',40401,404);ok(res,{operation_id:'keep-me',state:statusState,resume_until:'2099-01-01T00:00:00Z',credential:token()})});
  await assert.rejects(()=>issue(new GetNoteClient('key','client',base),'file','keep-me'),e=>{assert(e instanceof GetNoteAPIError);assert.equal(e.operationId,'keep-me');assert.equal(e.uploadKind,'file');assert.equal(e.retryable,false);assert.match(e.recoveryAdvice,/original|原/);assert.equal(JSON.stringify(e).includes('SENSITIVE_SIGNATURE'),false);return true});assert.equal(minted,1);assert.equal(lookups,1);
 }
});
test('credential conflict is preserved and never looked up under a different request',async t=>{
 const paths=[];const base=await fixture(t,(req,res)=>{paths.push(req.url);if(req.url.includes('/config'))return ok(res,{runtime:runtime('image')});fail(res,'credential_operation_conflict',40902)});await assert.rejects(()=>issue(new GetNoteClient('key','client',base),'image','original'),e=>e.reason==='credential_operation_conflict'&&e.requestId==='req-operation'&&e.operationId==='original');assert.equal(paths.length,2);
});
test('issued operation with expired original deadline never returns credential',async t=>{
 const base=await fixture(t,(req,res)=>{if(req.url.includes('/config'))return ok(res,{runtime:runtime('image')});ok(res,{operation_id:'original',state:'issued',resume_until:'2000-01-01T00:00:00Z',credential:token()})});await assert.rejects(()=>new GetNoteClient('key','client',base).getUploadOperation('original'),e=>e.reason==='credential_operation_expired'&&!JSON.stringify(e).includes('SENSITIVE_SIGNATURE'));
});
test('unconfirmed lookup preserves the issuance request ID and public error advice',async t=>{
 const base=await fixture(t,(req,res)=>{if(req.url.includes('/config'))return ok(res,{runtime:runtime('image')});if(req.url.includes('/upload_token'))return fail(res,'credential_operation_unconfirmed');ok(res,{operation_id:'original',state:'processing',resume_until:'2099-01-01T00:00:00Z'})});await assert.rejects(()=>issue(new GetNoteClient('key','client',base),'image','original'),e=>e.requestId==='req-operation'&&e.retryable===false);
});
test('upload_image keeps original operation metadata on successful upload and OSS failure',async t=>{
 let mode='success';let posts=0;let base;
 base=await fixture(t,(req,res)=>{if(req.url==='/oss'){posts++;if(mode==='failure'){res.writeHead(503);return res.end('not available')}return okOSS(res)}if(req.url.includes('/config'))return ok(res,{runtime:runtime('image')});ok(res,{...token(),host:base+'/oss',accessid:'a',policy:'p',callback:'c',oss_content_type:'image/png',object_key:'same-object',operation_id:'original',resume_until:'2099-01-01T00:00:00Z'})});
 function okOSS(res){res.setHeader('content-type','application/json');res.end(JSON.stringify({h:{c:0},c:{image:{id:'image-1'}}}))}
 const c=new GetNoteClient('key','client',base);const success=await c.uploadImage(Buffer.from('image'),'png','original');assert.equal(success.operation_id,'original');assert.equal(success.access_url,'https://oss.test/original');mode='failure';await assert.rejects(()=>c.uploadImage(Buffer.from('image'),'png','original'),e=>e.operationId==='original'&&e.retryable===false&&!JSON.stringify(e).includes('SENSITIVE_SIGNATURE'));assert.equal(posts,2);
});
