import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {GetNoteClient} from '../dist/client.js';

function ok(res,data){res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));}
async function fixture(t,handler){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});return `http://127.0.0.1:${server.address().port}`;}

test('legacy missing configuration preserves one-shot issuance for plain and non-envelope HTTP errors',async t=>{
 for(const kind of ['image','file'])for(const format of ['plain','json','empty'])for(const status of (kind==='file'?[404,403]:[404]))await t.test(`${kind} ${status} ${format}`,async t=>{
  let issued=0;
  const base=await fixture(t,(req,res)=>{
   if(req.url.includes('/config')||req.url.includes('/capabilities')){res.writeHead(status,{'content-type':format==='json'?'application/json':'text/plain'});res.end(format==='json'?'{}':format==='plain'?'404 page not found':'');return}
   issued++;assert.equal(req.headers['idempotency-key'],undefined);ok(res,{object_key:'legacy-original'});
  });
  const client=new GetNoteClient('key','client',base);
  const result=kind==='image'?await client.getUploadToken({mime_type:'png'}):await client.getKnowledgeFileUploadToken('pdf');assert.equal(result.object_key,'legacy-original');
  await assert.rejects(()=>kind==='image'?client.getUploadToken({mime_type:'png',operation_id:'original'}):client.getKnowledgeFileUploadToken('pdf','original'),error=>error.reason==='upload_operation_unsupported');assert.equal(issued,1);
 });
});

test('plain unavailable configuration cannot authorize blind issuance',async t=>{
 let issued=0;const base=await fixture(t,(req,res)=>{if(req.url.includes('/capabilities')){res.writeHead(503);res.end('unavailable');return}issued++;ok(res,{})});
 await assert.rejects(()=>new GetNoteClient('key','client',base).getKnowledgeFileUploadToken('pdf'));assert.equal(issued,0);
});

test('cancelling an in-flight OSS upload stops the transfer and retains its original operation',async t=>{
 let announce;const received=new Promise(resolve=>announce=resolve);let issues=0,uploads=0;
 const base=await fixture(t,(req,res)=>{
  if(req.url.includes('/config'))return ok(res,{runtime:{governance_enabled:true,operation_replay:true,idempotency_header:'Idempotency-Key',operation_status_endpoint:'/open/api/v1/resource/image/upload_operation'}});
  if(req.url.includes('/upload_token')){issues++;return ok(res,{operation_id:'original',resume_until:'2099-01-01T00:00:00Z',host:base+'/oss',object_key:'original-object',accessid:'fixture',policy:'fixture',signature:'fixture',callback:'fixture',oss_content_type:'image/png',access_url:'https://example.test/original'})}
  if(req.url==='/oss'){uploads++;req.on('data',()=>{});announce();return}
  throw new Error('Unexpected test route');
 });
 const abort=new AbortController();let settled=false;
 const pending=new GetNoteClient('key','client',base).withSignal(abort.signal).uploadImage(Buffer.from('fixture'),'png','original').then(()=>{settled=true;throw new Error('cancelled upload succeeded')},error=>{settled=true;assert.equal(error.operationId,'original');assert.equal(error.reason,'upload_result_unconfirmed')});
 await received;abort.abort(new Error('cancel upload'));
 await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('cancelled OSS request remained active')),250))]);
 assert.equal(settled,true);assert.equal(issues,1);assert.equal(uploads,1);
});

test('OSS redirects never repost the same uploaded object',async t=>{
 let redirected=0;
 const base=await fixture(t,(req,res)=>{if(req.url==='/oss'){res.writeHead(307,{location:base+'/again'});res.end();return}redirected++;res.setHeader('content-type','application/json');res.end('{"h":{"c":0},"c":{"image":{"id":"unexpected"}}}')});
 await assert.rejects(()=>new GetNoteClient('key','client',base).uploadImageToOSS({host:base+'/oss',object_key:'original',accessid:'fixture',policy:'fixture',signature:'fixture',callback:'fixture',oss_content_type:'image/png'},Buffer.from('fixture')));
 assert.equal(redirected,0);
});
