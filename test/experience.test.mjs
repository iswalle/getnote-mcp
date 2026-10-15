import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {GetNoteClient} from '../dist/client.js';

test('course, batch and snippet contracts survive the actual stdio tools', async()=>{
 let mode='supported';let requests=[];
 const api=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const chunks=[];for await(const c of req)chunks.push(c);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;
  requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),body});
  const filters=Object.fromEntries([...url.searchParams].filter(([k])=>!['page_size','cursor'].includes(k)));
  const caps=mode==='old'?[]:['pagination.v1','note.filters.v1','note.reference.v1','reference.resources.v1','note.course_filter.v1','note.batch_detail.v1','search.snippet.v1','future.v2'];
  if(mode==='ignored')delete filters.reference_course_id;
  let data={notes:[],applied_filters:filters,pagination:{mode:'cursor',page:null,page_size:20,returned_count:0,total_count:null,has_more:false,next_cursor:null,next_page:null}};
  if(url.pathname.endsWith('/reference/list')) data={...data,resources:[],pagination:{...data.pagination,has_more:true,next_cursor:'next'}};
  if(url.pathname.endsWith('/note/batch-detail'))data={items:[{note_id:'9007199254740993',status:'ok',note:{note_id:'9007199254740993',original:{source:'ref_content',content:'中😀'},future_note:true}},{note_id:'2',status:'deferred_budget'}],pending_ids:['2'],partial:true,max_total_chars:32000,max_total_bytes:1048576};
  if(url.pathname.endsWith('/recall'))data=body?.response_mode?{response_mode:'snippet',max_snippet_chars:100,max_total_bytes:1048576,results:[{resource_type:'future_type',snippet:'中😀',snippet_source:'unknown',truncated:false,content_state:{content:'omitted',snippet:'full'},future_hit:true}]}:{results:[{note_id:'1',content:'legacy body'}]};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,meta:{capabilities:caps},data}));
 });await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const client=new Client({name:'experience',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,GETNOTE_API_KEY:'synthetic',GETNOTE_CLIENT_ID:'synthetic',GETNOTE_API_URL:`http://127.0.0.1:${api.address().port}`},stderr:'pipe'});
 try{
  await client.connect(transport);const {tools}=await client.listTools();const schemas=Object.fromEntries(tools.map(t=>[t.name,t.inputSchema]));
  for(const name of ['list_reference_resources','get_notes'])assert.ok(schemas[name],`missing ${name}`);
  for(const key of ['reference_course_type','reference_course_id'])assert.ok(schemas.list_notes.properties[key]);
  assert.ok(schemas.recall.properties.response_mode);assert.ok(schemas.recall_knowledge.properties.max_snippet_chars);
  const cases=[['list_reference_resources',{source:'dedao',resource_type:'course',query:'课程'}],['list_notes',{source:'dedao',reference_course_type:'66',reference_course_id:'9007199254740993'}],['get_notes',{ids:['9007199254740993','0002','2'],fields:['original']}],['recall',{query:'AI',response_mode:'snippet',max_snippet_chars:100}]];
  for(const [name,args]of cases){const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,result.content[0].text);const data=JSON.parse(result.content[0].text);if(name==='list_reference_resources'){assert.equal(data.pagination.has_more,true);assert.equal(data.resources.length,0)}if(name==='get_notes'){assert.deepEqual(requests.at(-1).body.ids,['9007199254740993','2']);assert.deepEqual(data.pending_ids,['2']);assert.equal(data.items[0].note.future_note,true)}if(name==='recall'){assert.equal(data.results[0].future_hit,true);assert.ok(!('content'in data.results[0]))}}
  for(const bad of ['old','ignored']){mode=bad;const r=await client.callTool({name:'list_notes',arguments:cases[1][1]});assert.equal(r.isError,true,`${bad} silently accepted course filter`)}
  mode='old';const legacy=await client.callTool({name:'recall',arguments:{query:'AI'}});assert.ok(!legacy.isError);assert.equal(requests.at(-1).body.response_mode,undefined);assert.equal(JSON.parse(legacy.content[0].text).results[0].content,'legacy body');
  const count=requests.length;const invalid=await client.callTool({name:'list_notes',arguments:{...cases[1][1],topic_id:'kb'}});assert.equal(invalid.isError,true);assert.equal(requests.length,count);
 }finally{await client.close();api.closeAllConnections();await new Promise(r=>api.close(r))}
});

test('new-only request validation preserves large IDs and budgets',async()=>{
 const client=new GetNoteClient('k','c','http://127.0.0.1:1');
 for(const ids of [[],['9223372036854775808'],[9007199254740992],Array.from({length:21},(_,i)=>String(i+1))])await assert.rejects(()=>client.getNotes({ids}));
 await assert.rejects(()=>client.getNotes({ids:['1'],max_total_chars:0}));
 await assert.rejects(()=>client.recall({query:'AI',max_snippet_chars:400}));
});
