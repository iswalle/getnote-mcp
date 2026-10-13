import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the registered schema and real stdio tool handler through HTTP.
test('discovery tools forward selectors and reject false capability success', async () => {
 let mode='supported';let received;
 const api=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');received=Object.fromEntries(url.searchParams);
  const filters=Object.fromEntries([...url.searchParams].filter(([key])=>!['page','page_size','cursor','id','image_quality'].includes(key)));
  if(mode==='ignored')delete filters.note_type;
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({success:true,meta:{capabilities:mode==='old'?[]:['note.filters.v1','pagination.v1','note.reference.v1','knowledge.lookup.v1']},data:{notes:[],topics:[],note:{note_id:'9007199254740993',title:'',content_state:{content:'omitted',ref_content:'omitted'}},pagination:{mode:url.searchParams.has('page')?'page':'cursor',page:Number(url.searchParams.get('page')||1),page_size:Number(url.searchParams.get('page_size')||20),returned_count:0,total_count:null,has_more:false,next_cursor:null,next_page:null},applied_filters:filters}}));
 });
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const client=new Client({name:'discovery-contract',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,GETNOTE_API_KEY:'synthetic',GETNOTE_CLIENT_ID:'synthetic',GETNOTE_API_URL:`http://127.0.0.1:${api.address().port}`},stderr:'pipe'});
 try {
  await client.connect(transport);
  const {tools}=await client.listTools();
  const schemas=Object.fromEntries(tools.map(t=>[t.name,t.inputSchema.properties]));
  for(const key of ['source','note_type','reference_resource_type','reference_resource_id','reference_article_url','topic_id','created_from','created_to','edited_from','edited_to','record_updated_from','record_updated_to','page_size'])assert.ok(schemas.list_notes[key],`missing list_notes schema: ${key}`);
  for(const key of ['query','author','book_id','page_size'])assert.ok(schemas.list_topics[key],`missing lookup schema: ${key}`);
  const selectors={source:'dedao',note_type:'ref',reference_resource_type:'course_article',reference_resource_id:'9007199254740993',reference_article_url:'https://example.invalid/a?x=1#p',created_from:'2026-10-09T03:00:00Z',page_size:7};
  for(const [name,args] of [['list_notes',selectors],['list_topic_notes',{...selectors,topic_id:'topic-x',page:2}],['list_topics',{scope:'BOOKSPACE',query:'书名',author:'作者',book_id:'book-x',page_size:7}],['list_subscribe_topics',{scope:'BOOKSPACE',query:'书名',page_size:7}],['get_note',{id:'9007199254740993'}]]) {
   const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,result.content[0].text);
   for(const [key,value]of Object.entries(args))assert.equal(received[key],String(value),`${name}.${key}`);
   assert.ok(JSON.parse(result.content[0].text).meta.capabilities.includes('note.reference.v1'));
  }
  for(const bad of ['old','ignored']) {
   mode=bad;const result=await client.callTool({name:'list_notes',arguments:selectors});assert.equal(result.isError,true,`${bad} must not return filtered success`);
  }
  mode='old';const legacy=await client.callTool({name:'list_notes',arguments:{cursor:'legacy-opaque'}});assert.ok(!legacy.isError,'legacy call must still work');
  mode='supported';const bad=await client.callTool({name:'list_notes',arguments:{page_size:0}});assert.equal(bad.isError,true,'zero page_size invalid');
 }finally{await client.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
});

// Knowledge lookup does not return note references and must not require that capability.
test('knowledge lookup accepts the deployed knowledge capability contract', async () => {
 const { discoveryContract, verifyDiscovery } = await import('../dist/discovery.js');
 const contract = discoveryContract('topics', { scope: 'BOOKSPACE', page_size: 2 });
 assert.deepEqual(contract.capabilities, ['pagination.v1', 'knowledge.lookup.v1']);
 assert.doesNotThrow(() => verifyDiscovery({
  meta: { capabilities: ['knowledge.lookup.v1', 'pagination.v1'] },
  data: { topics: [], applied_filters: { scope: 'BOOKSPACE' }, pagination: {
   mode: 'page', page: 1, page_size: 2, returned_count: 0, total_count: 0,
   has_more: false, next_page: null, next_cursor: null
  } }
 }, contract));
});
