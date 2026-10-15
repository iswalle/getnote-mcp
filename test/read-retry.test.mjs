import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {GetNoteClient,GetNoteAPIError} from '../dist/client.js';
import {readRetryDelay} from '../dist/read-retry.js';

test('outer read retry is bounded and never replays writes or quota',async t=>{
 for(const [name,kind,wait,code,reason,retryable,want]of [
  ['read','read','0',10202,'qps_exceeded',true,3],['batch','batch','0',10202,'qps_exceeded',true,3],
  ['write','write','0',10202,'qps_exceeded',true,1],['token','token','0',10202,'qps_exceeded',true,1],
  ['quota','read','0',10203,'quota_exhausted',true,1],['long','read','60',10202,'qps_exceeded',true,1],
  ['nonretryable','read','0',10202,'qps_exceeded',false,1],['unknown','read','0',10202,'future_limit',true,1],
 ])await t.test(name,async()=>{
  let calls=0;const api=http.createServer((req,res)=>{calls++;res.writeHead(429,{'content-type':'application/json','retry-after':wait});res.end(JSON.stringify({success:false,error:{code,reason,retryable,message:'wait'},request_id:'req-last'}))});await new Promise(r=>api.listen(0,'127.0.0.1',r));
  try{const c=new GetNoteClient('k','c',`http://127.0.0.1:${api.address().port}`);let invoke=()=>c.getNote('1');if(kind==='batch')invoke=()=>c.getNotes({ids:['1']});if(kind==='write')invoke=()=>c.saveNote({content:'one write'});if(kind==='token')invoke=()=>c.getKnowledgeFileUploadToken('pdf');await assert.rejects(invoke,e=>e instanceof GetNoteAPIError&&e.requestId==='req-last');assert.equal(calls,want)}finally{api.closeAllConnections();await new Promise(r=>api.close(r))}
 });
});

test('read cancellation stops waiting and retains last API advice',async()=>{
 let calls=0;const controller=new AbortController();const api=http.createServer((req,res)=>{calls++;res.writeHead(429,{'content-type':'application/json','retry-after':'1'});res.end(JSON.stringify({success:false,error:{code:10202,reason:'qps_exceeded',retryable:true,message:'wait'},request_id:'req-cancel'}));setTimeout(()=>controller.abort(),30)});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 try{const c=new GetNoteClient('k','c',`http://127.0.0.1:${api.address().port}`).withSignal(controller.signal);const start=Date.now();await assert.rejects(()=>c.getNote('1'),e=>e instanceof GetNoteAPIError&&e.requestId==='req-cancel'&&e.retryAfterSeconds===1);assert.equal(calls,1);assert.ok(Date.now()-start<500)}finally{api.closeAllConnections();await new Promise(r=>api.close(r))}
});

test('retry budget never undercuts a server wait or retries unknown reads',()=>{
 const hint={httpStatus:429,code:10202,reason:'qps_exceeded',retryable:true,retryAfterSeconds:2,waitProvided:true};
 assert.equal(readRetryDelay('GET','/resource/note/detail',hint,1,3100),undefined);
 assert.equal(readRetryDelay('GET','/resource/future-action',hint,0,0),undefined);
 assert.equal(readRetryDelay('POST','/resource/note/save',hint,0,0),undefined);
 assert.equal(readRetryDelay('GET','/resource/note/detail',hint,2,0),undefined);
 const delay=readRetryDelay('GET','/resource/note/detail',hint,0,0);assert.ok(delay>2000&&delay<=2050);
});

test('cancellation during a retrying HTTP request also retains last advice',async()=>{
 let calls=0;const controller=new AbortController();const api=http.createServer((req,res)=>{calls++;if(calls===1){res.writeHead(429,{'content-type':'application/json','retry-after':'0'});res.end(JSON.stringify({success:false,error:{code:10202,reason:'qps_exceeded',retryable:true,message:'wait'},request_id:'req-before-cancel'}));return}controller.abort();res.end('{}')});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 try{const c=new GetNoteClient('k','c',`http://127.0.0.1:${api.address().port}`).withSignal(controller.signal);await assert.rejects(()=>c.getNote('1'),e=>e instanceof GetNoteAPIError&&e.requestId==='req-before-cancel'&&e.retryAfterSeconds===0);assert.equal(calls,2)}finally{api.closeAllConnections();await new Promise(r=>api.close(r))}
});
