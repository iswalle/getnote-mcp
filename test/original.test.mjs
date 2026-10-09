import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('get_note_original uses only the source selected by note_type', async () => {
  const cases = [
    { note_type: 'ref', content: 'personal comment', ref_content: 'quoted passage', want: 'quoted passage', source: 'ref_content' },
    { note_type: 'ref', content: '', ref_content: 'quoted passage', want: 'quoted passage', source: 'ref_content' },
    { note_type: 'ref', content: 'personal comment', ref_content: '', error: true },
    { note_type: 'plain_text', content: 'typed text', ref_content: 'other', want: 'typed text', source: 'content' },
    { note_type: 'link', content: 'AI summary', web_page: {url:'https://example.test',content:'web article'}, want: 'web article', source: 'web_page.content' },
    { note_type: 'audio', content: 'AI summary', audio: {original:'raw transcript'}, want: 'raw transcript', source: 'audio.original' },
    { note_type: 'unknown', content: 'AI summary', error: true },
  ];
  let current = cases[0];
  const api = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({success:true,data:{note:{id:'123',title:'Synthetic',source:'manual',tags:[],created_at:'',updated_at:'',...current}}}));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const client = new Client({name:'original-regression',version:'1'});
  const transport = new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,GETNOTE_API_KEY:'test-key',GETNOTE_CLIENT_ID:'test-client',GETNOTE_API_URL:`http://127.0.0.1:${api.address().port}`},stderr:'pipe'});
  try {
    await client.connect(transport);
    for (const fixture of cases) {
      current = fixture;
      const response = await client.callTool({name:'get_note_original',arguments:{id:'123'}});
      if (fixture.error) {
        assert.equal(response.isError, true, fixture.note_type);
        assert.match(response.content[0].text, /not available|unsupported/i);
      } else {
        assert.ok(!response.isError, fixture.note_type);
        const data = JSON.parse(response.content[0].text);
        assert.deepEqual(data, {id:'123',note_type:fixture.note_type,title:'Synthetic',original:fixture.want,original_source:fixture.source});
      }
    }
  } finally {
    await client.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});
