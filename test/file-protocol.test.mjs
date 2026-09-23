import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio tools enforce metadata-only uploads and preserve business errors', async () => {
  const received = [];
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      received.push({ path: req.url, body: body && JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      const token = req.url.includes('/upload_token');
      res.end(JSON.stringify(token ? {
        success: false, error: { code: 10000, message: 'daily file limit exceeded', reason: 'invalid_request', retryable: false }, request_id: 'quota-request',
      } : { success: true, data: { status: 'UPLOADING', id: '9000000000020341' } }));
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'protocol-regression', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, GETNOTE_API_KEY: 'test-key', GETNOTE_CLIENT_ID: 'test-client', GETNOTE_API_URL: `http://127.0.0.1:${api.address().port}` },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['get_note_marks', 'list_sprouts', 'get_sprout', 'get_knowledge_file_capabilities', 'get_knowledge_file_upload_token', 'upload_knowledge_file']) {
      assert.ok(tools.some(tool => tool.name === name), name);
    }
    assert.equal(tools.find(tool => tool.name === 'upload_knowledge_file').inputSchema.additionalProperties, false);
    const args = { topic_id: 'alias', directory_id: '9000000000020341', file_name: 'x.txt', file_type: 'TXT', md5: 'a'.repeat(32), url: 'https://example.test/x.txt' };
    for (const extra of [{ file_base64: 'secret-file-bytes' }, { file_path: '/private/file' }]) {
      const rejected = await client.callTool({ name: 'upload_knowledge_file', arguments: { ...args, ...extra } });
      assert.equal(rejected.isError, true);
      assert.equal(received.length, 0, 'invalid upload must not reach upstream');
      assert.equal(JSON.stringify(rejected).includes('secret-file-bytes'), false);
    }
    const accepted = await client.callTool({ name: 'upload_knowledge_file', arguments: args });
    assert.ok(!accepted.isError);
    assert.deepEqual(received[0].body, args);
    assert.match(accepted.content[0].text, /UPLOADING/);
    assert.doesNotMatch(accepted.content[0].text, /SUCCESS/);
    const quota = await client.callTool({ name: 'get_knowledge_file_upload_token', arguments: { mime_type: 'TXT' } });
    assert.equal(quota.isError, true);
    assert.match(quota.content[0].text, /quota-request/);
    assert.match(quota.content[0].text, /invalid_request/);
    assert.match(quota.content[0].text, /"retryable":\s*false/);
  } finally {
    await client.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});
