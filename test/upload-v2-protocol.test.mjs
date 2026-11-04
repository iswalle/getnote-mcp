import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

async function protocol(t,handler){
 const api=http.createServer(handler);await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const client=new Client({name:'upload-v2-protocol',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,GETNOTE_API_KEY:'key',GETNOTE_CLIENT_ID:'client',GETNOTE_API_URL:`http://127.0.0.1:${api.address().port}`},stderr:'pipe'});
 await client.connect(transport);t.after(async()=>{await client.close();api.closeAllConnections();await new Promise(r=>api.close(r))});return client;
}
function ok(res,data){res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));}
function runtime(kind){const prefix=kind==='image'?'/resource/image':'/resource/knowledge/file';return {governance_enabled:true,operation_replay:true,idempotency_header:'Idempotency-Key',operation_status_endpoint:'/open/api/v1'+prefix+'/upload_operation'};}
test('actual stdio tools expose image/file recovery and forward original operation identifiers',async t=>{
 const received=[];const client=await protocol(t,(req,res)=>{received.push({url:req.url,key:req.headers['idempotency-key']});if(req.url.includes('/config'))return ok(res,{runtime:runtime('image')});if(req.url.includes('/capabilities'))return ok(res,{runtime:runtime('file')});if(req.url.includes('/upload_operation')){const id=new URL(req.url,'http://local').searchParams.get('operation_id');return ok(res,{operation_id:id,state:'issued',resume_until:'2099-01-01T00:00:00Z',credential:{object_key:'same-object'}})}ok(res,{object_key:'same-object',operation_id:req.headers['idempotency-key'],resume_until:'2099-01-01T00:00:00Z'})});
 const {tools}=await client.listTools();for(const name of ['get_upload_operation','get_knowledge_file_upload_operation'])assert.ok(tools.some(tool=>tool.name===name),name);
 for(const name of ['get_upload_token','get_knowledge_file_upload_token','upload_image'])assert.equal(tools.find(tool=>tool.name===name).inputSchema.properties.operation_id.pattern,'^[A-Za-z0-9._:-]{1,128}$');
 for(const [name,args]of [['get_upload_token',{mime_type:'png',operation_id:'image:key'}],['get_knowledge_file_upload_token',{mime_type:'pdf',operation_id:'file:key'}],['get_upload_operation',{operation_id:'image:key'}],['get_knowledge_file_upload_operation',{operation_id:'file:key'}]]){
  const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));const data=JSON.parse(result.content[0].text);assert.equal(data.operation_id,args.operation_id);
 }
 assert.deepEqual(received.filter(r=>r.url.includes('/upload_token')).map(r=>r.key),['image:key','file:key']);
 const before=received.length;const invalid=await client.callTool({name:'get_upload_token',arguments:{mime_type:'png',operation_id:'bad key'}});assert.equal(invalid.isError,true);assert.equal(received.length,before);
});
test('actual stdio error preserves complete future rate detail and original upload recovery advice',async t=>{
 const detail={dimension:'day',bucket:'upload_credential',request_execution:'not_started',retry_action:'pause_until_reset',retryable:false,retry_after_seconds:3600,future:{nested:['v3',42]}};
 const client=await protocol(t,(req,res)=>{if(req.url.includes('/config'))return ok(res,{runtime:runtime('image')});if(req.url.includes('/upload_operation'))return ok(res,{operation_id:'original',state:'processing',resume_until:'2099-01-01T00:00:00Z',credential:{signature:'SHOULD_NOT_LEAK'}});res.writeHead(429,{'content-type':'application/json','retry-after':'3600'});res.end(JSON.stringify({success:false,error:{code:10203,reason:'quota_exhausted',message:'pause',retryable:false,rate_limit_detail:detail},request_id:'req-v2-stdio'}))});
 const refused=await client.callTool({name:'get_upload_token',arguments:{mime_type:'png',operation_id:'original'}});assert.equal(refused.isError,true);const error=JSON.parse(refused.content[0].text);assert.deepEqual(error.rate_limit_detail,detail);assert.equal(error.request_id,'req-v2-stdio');assert.equal(error.operation_id,'original');assert.equal(error.upload_kind,'image');assert.equal(error.retry_after_seconds,3600);
 const pending=await client.callTool({name:'get_upload_operation',arguments:{operation_id:'original'}});assert.equal(pending.isError,true);const pendingError=JSON.parse(pending.content[0].text);assert.equal(pendingError.operation_id,'original');assert.equal(pendingError.retryable,false);assert.equal(pendingError.query_tool,'get_upload_operation');assert.match(pendingError.recovery_advice,/original/);assert.equal(JSON.stringify(pending).includes('SHOULD_NOT_LEAK'),false);
});
