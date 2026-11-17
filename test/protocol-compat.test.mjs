import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

for(const version of ['2024-11-05','2025-03-26'])test(`legacy MCP ${version} can initialize and call an old tool name`,async()=>{
 const api=http.createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data:{results:[]}}))});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const p=spawn(process.execPath,[fileURLToPath(new URL('../dist/index.js',import.meta.url))],{env:{...process.env,GETNOTE_API_KEY:'synthetic',GETNOTE_CLIENT_ID:'synthetic',GETNOTE_API_URL:`http://127.0.0.1:${api.address().port}`},stdio:['pipe','pipe','pipe']});
 const pending=new Map();const lines=createInterface({input:p.stdout});
 lines.on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value)});
 let id=0;
 const call=(method,params)=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error('protocol response timeout'))},5000);pending.set(n,value=>{clearTimeout(timer);pending.delete(n);resolve(value)});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')});
 try{
  const init=await call('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'old-client',version:'1'}});assert.equal(init.result.protocolVersion,version);
  p.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await call('tools/list',{});assert.ok(list.result.tools.some(x=>x.name==='search_account_content'));
  const old=await call('tools/call',{name:'recall',arguments:{query:'compatibility'}});assert.ok(!old.error&&!old.result.isError);assert.deepEqual(JSON.parse(old.result.content[0].text).results,[]);
 }finally{p.kill();lines.close();api.closeAllConnections();await new Promise(r=>api.close(r))}
});
