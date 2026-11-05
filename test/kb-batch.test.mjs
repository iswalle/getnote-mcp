import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('add/remove report partial rejection through actual stdio',async()=>{
 let count=2,failed=[];
 const api=http.createServer(async(req,res)=>{for await(const c of req){};const key=req.url.endsWith('/remove')?'removed_count':'success_count';res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:{[key]:count,...(failed===null?{}:{failed_note_ids:failed})}}))});
 await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const client=new Client({name:'test',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,GETNOTE_API_KEY:'test',GETNOTE_CLIENT_ID:'test',GETNOTE_API_URL:`http://127.0.0.1:${api.address().port}`},stderr:'pipe'});
 try{await client.connect(transport);for(const name of ['batch_add_notes_to_topic','remove_note_from_topic'])for(const f of [[],['2'],['1','2'],null]){failed=f;count=2-(f?.length??0);const r=await client.callTool({name,arguments:{topic_id:'kb',note_ids:['1','2']}});assert.equal(Boolean(r.isError),Boolean(f?.length));const d=JSON.parse(r.content[0].text);assert.equal(d.success_count??d.removed_count,count);if(f)assert.deepEqual(d.failed_note_ids,f)}}finally{await client.close();api.closeAllConnections();await new Promise(r=>api.close(r))}
});
