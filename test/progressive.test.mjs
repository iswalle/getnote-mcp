import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {canonicalNames} from '../dist/progressive.js';

test('actual stdio discovery, aliases, bounded sections and old readers',async()=>{
 let mode='ok',kind='meeting';let calls=[];
 const api=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');let chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;
  calls.push({path:u.pathname,query:Object.fromEntries(u.searchParams),body});
  let data={};const caps=['note.progressive_read.v1'];
  if(u.pathname.endsWith('/outline')||u.pathname.endsWith('/section'))data={id:'9007199254740993',text:'原话😀\r\n',version:mode==='wrongversion'?'other':'v-12345',total:12345,offset_unit:mode==='wrongunit'?'codepoint':'utf16'};
  if(u.pathname.endsWith('/detail'))data={note:{id:'9007199254740993',note_type:kind,content:'summary',audio:{original:'actual transcript'},chapter_timeline:{source:'summary_markdown_rules',items:[{start_ms:1000,title:'A'},{start_ms:2000,title:'B'}]}}};
  if(u.pathname.endsWith('/recall'))data={results:[{content:'same search'}]};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(mode==='stale'?{success:false,error:{code:10002,reason:'note_version_changed',message:'refresh outline',retryable:false}}:{success:true,meta:{capabilities:mode==='old'?[]:caps},data}));
 });await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const client=new Client({name:'progressive-contract',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,GETNOTE_API_KEY:'synthetic',GETNOTE_CLIENT_ID:'synthetic',GETNOTE_API_URL:`http://127.0.0.1:${api.address().port}`},stderr:'pipe'});
 const call=(name,args={})=>client.callTool({name,arguments:args});
 try{
  await client.connect(transport);assert.match(client.getInstructions(),/UTF-16/);
  const {tools}=await client.listTools();const names=tools.map(t=>t.name);
  for(const name of Object.values(canonicalNames))assert.ok(names.includes(name),name);
  assert.equal(new Set(names).size,names.length);
  for(const name of ['get_note_outline','read_note_section']){const t=tools.find(t=>t.name===name);assert.equal(t.annotations.readOnlyHint,true);assert.equal(t.inputSchema.additionalProperties,false)}
  for(const [name,args]of [['get_note_outline',{id:'9007199254740993'}],['read_note_section',{id:'9007199254740993',offset:8000,version:'v-12345'}],['read_note_section',{id:'9007199254740993',keyword:'结论'}]]){const out=await call(name,args);assert.ok(!out.isError,out.content[0].text);assert.equal(JSON.parse(out.content[0].text).text,'原话😀\r\n')}
  assert.ok(!('limit' in calls.at(-1).query));
  for(const bad of [{id:9007199254740992},{id:'1',limit:0},{id:'1',owner_uid:2},{id:'1',url:'https://untrusted'}]){const before=calls.length;assert.equal((await call('read_note_section',bad)).isError,true);assert.equal(calls.length,before)}
  for(const m of ['old','wrongunit','wrongversion','stale']){mode=m;const before=calls.length;const out=await call('read_note_section',{id:'9007199254740993',version:'v-12345'});assert.equal(out.isError,true);assert.equal(calls.length,before+1);if(m==='stale')assert.equal(JSON.parse(out.content[0].text).reason,'note_version_changed')}
  mode='ok';for(const k of ['audio','local_audio','meeting','recorder_audio','recorder_flash_audio','class_audio','internal_record']){kind=k;const out=await call('get_note_original',{id:'9007199254740993'});assert.ok(!out.isError);assert.equal(JSON.parse(out.content[0].text).original,'actual transcript')}
  const old=await call('recall',{query:'职场沟通'});const oldCall=calls.at(-1);const modern=await call('search_account_content',{query:'职场沟通'});assert.deepEqual(calls.at(-1),oldCall);assert.deepEqual(modern,old);
 }finally{await client.close();api.closeAllConnections();await new Promise(r=>api.close(r))}
});
