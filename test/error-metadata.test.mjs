import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {GetNoteClient, GetNoteAPIError} from '../dist/client.js';

test('experience error metadata survives business and HTTP failures', async t => {
  for (const [name, status, header, bodyWait, want] of [
    ['body',200,undefined,12,12],['header',429,'9',undefined,9],
    ['later body',429,'9',12,12],['later header',429,'15',12,15],
    ['invalid',429,'garbage',undefined,undefined],['negative',429,'-1',undefined,undefined],
    ['overflow',429,'999999999999999999999999',undefined,undefined],
  ]) await t.test(name, async () => {
    const server = http.createServer((req,res) => {
      if(header !== undefined)res.setHeader('Retry-After',header);
      res.writeHead(status,{'content-type':'application/json'});
      res.end(JSON.stringify({success:false,error:{code:10202,reason:'qps_exceeded',message:'wait',retryable:true,supported_values:['dedao'],retry_after_seconds:bodyWait,future_field:true},request_id:'req-advice'}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const client = new GetNoteClient('key','client',`http://127.0.0.1:${server.address().port}`);
      await assert.rejects(()=>client.getNote('123'),err=>{
        assert(err instanceof GetNoteAPIError);assert.equal(err.requestId,'req-advice');
        assert.equal(err.retryAfterSeconds,want);assert.deepEqual(err.supportedValues,['dedao']);return true;
      });
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
});

test('experience stdio tool retains public error advice fields', async () => {
  const server=http.createServer((req,res)=>{
    res.writeHead(200,{'content-type':'application/json','retry-after':'9'});
    res.end(JSON.stringify({success:false,error:{code:10000,reason:'invalid_request',message:'bad source',retryable:false,field:'source',supported_values:['dedao'],retry_after_seconds:12},request_id:'req-tool'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'experience-errors',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,GETNOTE_API_KEY:'key',GETNOTE_CLIENT_ID:'client',GETNOTE_API_URL:`http://127.0.0.1:${server.address().port}`},stderr:'pipe'});
  try {
    await client.connect(transport);
    const result=await client.callTool({name:'get_note',arguments:{id:'123'}});
    assert.equal(result.isError,true);const data=JSON.parse(result.content[0].text);
    assert.equal(data.request_id,'req-tool');assert.equal(data.field,'source');
    assert.deepEqual(data.supported_values,['dedao']);assert.equal(data.retry_after_seconds,12);
  } finally {await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
