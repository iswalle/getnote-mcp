import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const ID='9007199254740993';
// Through the real stdio server: every note reader keeps generation_status when sent and never invents it.
test('note readers forward generation_status and omit it for old servers',async()=>{
 let status='generating';
 const api=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');for await(const _ of req);
  const s=status===undefined?{}:{generation_status:status};
  const filters=Object.fromEntries([...u.searchParams].filter(([k])=>!['page','page_size','cursor','id','image_quality'].includes(k)));
  const pagination={mode:u.searchParams.has('page')?'page':'cursor',page:u.searchParams.has('page')?Number(u.searchParams.get('page')):null,page_size:Number(u.searchParams.get('page_size')||20),returned_count:1,total_count:1,has_more:false,next_page:null,next_cursor:null};
  let data;
  if(u.pathname.endsWith('/note/list'))data={notes:[{id:ID,title:'t',content:'',note_type:'link',...s}],has_more:false,total:1,pagination,applied_filters:filters};
  else if(u.pathname.endsWith('/knowledge/notes'))data={notes:[{note_id:ID,title:'t',note_type:'link',...s}],has_more:false,total:1,pagination,applied_filters:filters};
  else if(u.pathname.endsWith('/note/detail'))data={note:{id:ID,title:'t',note_type:'audio',content:'半',audio:{original:'原话'},...s}};
  else if(u.pathname.endsWith('/note/batch-detail'))data={items:[{note_id:ID,status:'ok',note:{note_id:ID,content:'',...s}}],pending_ids:[],partial:false,total_chars:0,max_total_chars:32000,max_total_bytes:1048576};
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({success:true,meta:{capabilities:['pagination.v1','note.filters.v1','note.reference.v1','note.batch_detail.v1']},data}));
 });
 await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const client=new Client({name:'generation-status',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,GETNOTE_API_KEY:'synthetic',GETNOTE_CLIENT_ID:'synthetic',GETNOTE_API_URL:`http://127.0.0.1:${api.address().port}`},stderr:'pipe'});
 const pick={
  list_notes:o=>o.notes[0],list_notes_filtered:o=>o.notes[0],list_knowledge_base_notes:o=>o.notes[0],
  get_note:o=>o.note,batch_get_notes:o=>o.items[0].note,get_note_original:o=>o,get_note_transcript:o=>o,get_note_todos:o=>o,
 };
 const args={list_notes:{},list_notes_filtered:{page_size:5},list_knowledge_base_notes:{topic_id:'topic-x',page_size:5},get_note:{id:ID},batch_get_notes:{ids:[ID]},get_note_original:{id:ID},get_note_transcript:{id:ID},get_note_todos:{id:ID}};
 try{
  await client.connect(transport);
  const {tools}=await client.listTools();
  for(const name of ['list_notes','get_note','list_knowledge_base_notes'])assert.match(tools.find(t=>t.name===name).description,/generation_status.*completed/,name);
  for(const s of ['generating','failed','completed',undefined]){
   status=s;
   for(const [key,read]of Object.entries(pick)){
    const out=await client.callTool({name:key==='list_notes_filtered'?'list_notes':key,arguments:args[key]});
    assert.ok(!out.isError,out.content[0].text);
    const item=read(JSON.parse(out.content[0].text));
    if(s===undefined)assert.ok(!('generation_status' in item),`${key} must not invent a status`);
    else assert.equal(item.generation_status,s,key);
   }
  }
 }finally{await client.close();api.closeAllConnections();await new Promise(r=>api.close(r))}
});
