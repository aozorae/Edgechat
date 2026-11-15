import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureKvNamespace,
  ensureR2Bucket,
  ensureCloudflareResources,
} from "../.github/scripts/ensure-cloudflare-resources.mjs";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("KV only reuses the explicitly selected namespace title", async () => {
  const requests = [];
  const result = await ensureKvNamespace(
    {
      accountId: "account",
      apiToken: "token",
      async fetchImpl(url, init) {
        requests.push({ url: String(url), method: init.method });
        return jsonResponse({
          success: true,
          result: [
            { id: "generic-id", title: "SESSIONS" },
            { id: "target-id", title: "edgechat-production-sessions" },
          ],
        });
      },
    },
    "edgechat-production-sessions",
  );

  assert.deepEqual(result, {
    id: "target-id",
    title: "edgechat-production-sessions",
    created: false,
  });
  assert.deepEqual(requests.map((request) => request.method), ["GET"]);
});

test("Custom S3 skips all R2 calls while the default and r2 selection preserve provisioning", async () => {
  for (const selection of ['', 'r2', JSON.stringify({ endpoint: 'https://s3.example.test', bucket: 'files', accessKeyId: 'test-key', secretAccessKey: 'test-secret' })]) {
    const requests = [];
    const result = await ensureCloudflareResources({
      accountId: 'account', apiToken: 'token', env: { EDGECHAT_S3: selection },
      async fetchImpl(url) {
        requests.push(String(url));
        if (String(url).includes('/d1/database')) return jsonResponse({ success: true, result: [{ name: 'cfchat-db', uuid: 'db-id' }] });
        if (String(url).includes('/storage/kv/')) return jsonResponse({ success: true, result: [{ title: 'cfchat-sessions', id: 'kv-id' }] });
        return jsonResponse({ success: true, result: { buckets: [{ name: 'cfchat-files' }] } });
      },
    });
    const custom = selection.startsWith('{');
    assert.equal(result.r2.available, !custom);
    assert.equal(requests.filter((url) => url.includes('/r2/')).length, custom ? 0 : 2);
  }
});

test("Invalid S3 configuration stops before cloud requests and never exposes credentials", async () => {
  let calls = 0;
  await assert.rejects(ensureCloudflareResources({
    env: { EDGECHAT_S3: '{secret-sensitive-invalid-json' },
    fetchImpl() { calls++; },
  }), (error) => !error.message.includes('secret-sensitive'));
  assert.equal(calls, 0);
});

test("KV defaults to the isolated legacy title instead of generic SESSIONS", async () => {
  const requests = [];
  const responses = [
    jsonResponse({
      success: true,
      result: [{ id: "generic-id", title: "SESSIONS" }],
    }),
    jsonResponse({ success: true, result: { id: "created-id" } }),
  ];
  const result = await ensureKvNamespace({
    accountId: "account",
    apiToken: "token",
    async fetchImpl(url, init) {
      requests.push({
        url: String(url),
        method: init.method,
        body: init.body,
      });
      return responses.shift();
    },
  });

  assert.deepEqual(result, {
    id: "created-id",
    title: "cfchat-sessions",
    created: true,
  });
  assert.deepEqual(requests.map((request) => request.method), ["GET", "POST"]);
  assert.deepEqual(JSON.parse(requests[1].body), {
    title: "cfchat-sessions",
  });
});

test("R2 error 10042 disables attachment storage without failing deployment", async () => {
  const requests = [];
  const result = await ensureR2Bucket({
    accountId: "account",
    apiToken: "token",
    async fetchImpl(url, init) {
      requests.push({ url: String(url), method: init.method });
      return jsonResponse(
        {
          success: false,
          errors: [{ code: 10042, message: "Please enable R2 in the Cloudflare dashboard." }],
        },
        400,
      );
    },
  });

  assert.deepEqual(result, { available: false, created: false });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.match(requests[0].url, /\/r2\/buckets\?per_page=1$/);
});

test("R2 access keeps the existing bucket flow", async () => {
  const requests = [];
  const responses = [
    jsonResponse({ success: true, result: { buckets: [] } }),
    jsonResponse({ success: true, result: { buckets: [{ name: "cfchat-files" }] } }),
  ];
  const result = await ensureR2Bucket({
    accountId: "account",
    apiToken: "token",
    async fetchImpl(url, init) {
      requests.push({ url: String(url), method: init.method });
      return responses.shift();
    },
  });

  assert.deepEqual(result, { available: true, created: false });
  assert.deepEqual(
    requests.map((request) => request.method),
    ["GET", "GET"],
  );
});

test("R2 permission and credential errors still stop deployment", async () => {
  await assert.rejects(
    ensureR2Bucket({
      accountId: "account",
      apiToken: "token",
      async fetchImpl() {
        return jsonResponse(
          {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          },
          403,
        );
      },
    }),
    /10000: Authentication error/,
  );
});

test("R2 error 10042 does not hide additional Cloudflare errors", async () => {
  await assert.rejects(
    ensureR2Bucket({
      accountId: "account",
      apiToken: "token",
      async fetchImpl() {
        return jsonResponse(
          {
            success: false,
            errors: [
              { code: 10042, message: "Please enable R2 in the Cloudflare dashboard." },
              { code: 10000, message: "Authentication error" },
            ],
          },
          403,
        );
      },
    }),
    /10042: .*; 10000: Authentication error/,
  );
});
