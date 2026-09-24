import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  GetNoteAPIError,
  GetNoteClient,
  parseJsonPreservingLargeIntegerStrings,
} from "../dist/client.js";
import { OPENAPI_MEMBERSHIP_PURCHASE_URL } from "../dist/membership.js";

test("file and distinct mark/sprout methods preserve routes and string IDs", async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      received.push({url:req.url, method:req.method, body:body ? JSON.parse(body):null});
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({success:true,data:{status:'UPLOADING'}}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const client = new GetNoteClient('key','client',`http://127.0.0.1:${server.address().port}`);
    await client.getNoteMarks('1922071641760757698');
    await client.listSprouts('2026-09', '1922071641760757698', 2);
    await client.getSprout('sprout-alias');
    await client.getKnowledgeFileCapabilities();
    await client.getKnowledgeFileUploadToken('HTM');
    const result = await client.uploadKnowledgeFile({topic_id:'alias',directory_id:'9000000000020341',file_name:'x.htm',file_type:'HTM',md5:'a'.repeat(32),url:'https://example.com/x.htm'});
    assert.deepEqual(received.map(r=>r.url),[
      '/open/api/v1/resource/note/marks?note_id=1922071641760757698',
      '/open/api/v1/resource/note/sprouts?month=2026-09&since_id=1922071641760757698&limit=2',
      '/open/api/v1/resource/note/sprout?id=sprout-alias',
      '/open/api/v1/resource/knowledge/file/capabilities',
      '/open/api/v1/resource/knowledge/file/upload_token?mime_type=HTM',
      '/open/api/v1/resource/knowledge/file/upload',
    ]);
    assert.equal(received[5].body.directory_id,'9000000000020341');
    assert.equal(received[5].method,'POST');
    assert.equal(result.status,'UPLOADING');
    assert.equal('file_base64' in received[5].body,false);
  } finally { server.close(); }
});

test("membership errors use the MCP-specific OpenAPI purchase channel", () => {
  assert.equal(
    OPENAPI_MEMBERSHIP_PURCHASE_URL,
    "https://www.biji.com/checkout?product_alias=9Ab36BB3ZD&spm=openapi_mcp"
  );
});

test("large snowflake IDs are parsed and re-encoded as strings", () => {
  const parsed = parseJsonPreservingLargeIntegerStrings(`{
    "id": 1916020531058082912,
    "follow_id": 1916020531058082913,
    "children_ids": [1916020531058082914]
  }`);
  assert.equal(parsed.id, "1916020531058082912");
  assert.equal(parsed.follow_id, "1916020531058082913");
  assert.deepEqual(parsed.children_ids, ["1916020531058082914"]);
  assert.match(JSON.stringify(parsed), /"1916020531058082912"/);
});

test("HTTP 200 success=false exposes the complete structured error", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      success: false,
      data: null,
      error: {
        code: 10000,
        message: "参数错误",
        reason: "invalid_request",
        retryable: false,
        field: "parent_id",
        constraint: "non_negative_decimal_integer",
        expected_type: "decimal string or JSON integer",
      },
      request_id: "req_test",
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;

  try {
    await assert.rejects(
      () => new GetNoteClient("key", "client", baseURL).getNote("1e3"),
      (err) => {
        assert.ok(err instanceof GetNoteAPIError);
        assert.equal(err.field, "parent_id");
        assert.equal(err.constraint, "non_negative_decimal_integer");
        assert.equal(err.expectedType, "decimal string or JSON integer");
        assert.equal(err.requestId, "req_test");
        assert.equal(err.retryable, false);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("knowledge list methods default to DEFAULT and forward explicit scope", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, data: { topics: [], has_more: false, total: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;

  try {
    const client = new GetNoteClient("key", "client", baseURL);
    await client.listTopics({ page: 1 });
    await client.listSubscribeTopics({ page: 2, scope: "BOOKSPACE" });
    assert.equal(requests[0], "/open/api/v1/resource/knowledge/list?page=1&scope=DEFAULT");
    assert.equal(requests[1], "/open/api/v1/resource/knowledge/subscribe/list?page=2&scope=BOOKSPACE");
  } finally {
    server.close();
  }
});

test("OSS multipart fields use the signed names and order", async () => {
  let body = "";
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ h: { c: 0 }, c: { image: { id: "img_1" } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const host = `http://127.0.0.1:${address.port}`;

  try {
    const client = new GetNoteClient("key", "client", host);
    const result = await client.uploadImageToOSS({
      accessid: "access",
      host,
      policy: "policy",
      signature: "signature",
      expire: 0,
      callback: "callback",
      object_key: "object",
      access_url: "https://example.test/object",
      oss_content_type: "image/png",
    }, Buffer.from("image"));
    assert.equal(result.image_id, "img_1");

    const names = [
      'name="key"',
      'name="OSSAccessKeyId"',
      'name="policy"',
      'name="signature"',
      'name="callback"',
      'name="Content-Type"',
      'name="file"',
    ];
    let previous = -1;
    for (const name of names) {
      const current = body.indexOf(name);
      assert.ok(current > previous, `${name} must follow the previous signed field`);
      previous = current;
    }
    assert.equal(body.includes('name="Signature"'), false);
    assert.equal(body.includes('name="success_action_status"'), false);
  } finally {
    server.close();
  }
});
