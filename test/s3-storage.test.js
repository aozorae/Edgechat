import assert from 'node:assert/strict';
import test from 'node:test';
import { getFileStorage, hasFileStorage } from '../worker/src/storage/index.ts';
import { parseS3Config } from '../worker/src/storage/s3-config.ts';

const config = {
  endpoint: 'https://storage.example.test',
  bucket: 'edgechat',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};
const env = (overrides = {}) => ({ EDGECHAT_S3: JSON.stringify({ ...config, ...overrides }) });

test('R2 remains a direct binding with no S3 configuration or explicit r2', () => {
  const FILES = {};
  assert.equal(getFileStorage({ FILES }), FILES);
  assert.equal(getFileStorage({ FILES, EDGECHAT_S3: 'r2' }), FILES);
  assert.equal(getFileStorage({ FILES, EDGECHAT_S3: '  ' }), FILES);
  assert.equal(hasFileStorage({}), false);
  assert.equal(getFileStorage({}), undefined);
});

test('S3 needs only four fields and never falls back to R2 on invalid configuration', () => {
  const parsed = parseS3Config(JSON.stringify(config));
  assert.equal(parsed.region, 'us-east-1');
  assert.equal(parsed.forcePathStyle, true);
  const environment = env();
  assert.equal(getFileStorage(environment), getFileStorage(environment));
  assert.equal(hasFileStorage(environment), true);
  for (const value of ['bad-json-test-secret-key', '{}', 'null', '[]',
    JSON.stringify({ ...config, endpoint: 'http://storage.example.test' }),
    JSON.stringify({ ...config, endpoint: 'https://user:password@storage.example.test' })]) {
    assert.throws(() => getFileStorage({ FILES: {}, EDGECHAT_S3: value }), (error) => {
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /test-secret-key|password/);
      return true;
    });
  }
});

test('S3 signs PUT/GET/DELETE, preserves bytes and Unicode metadata, and never redirects', async (t) => {
  const key = "42/报告 +%?#&!'().bin";
  const bytes = new Uint8Array([0, 1, 255, 42]);
  let stored;
  let savedHeaders;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    requests.push(request);
    assert.equal(request.redirect, 'error');
    assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d+\/us-east-1\/s3\/aws4_request/);
    assert.equal(new URL(request.url).pathname, `/edgechat/42/${encodeURIComponent(key.slice(3)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    if (request.method === 'PUT') {
      stored = await request.arrayBuffer();
      savedHeaders = new Headers(request.headers);
      return new Response(null, { status: 200 });
    }
    if (request.method === 'GET') {
      if (!stored) return new Response(null, { status: 404 });
      savedHeaders.set('last-modified', 'Sun, 15 Nov 2026 00:00:00 GMT');
      return new Response(stored, { headers: savedHeaders });
    }
    stored = null;
    return new Response(null, { status: 204 });
  });
  const storage = getFileStorage(env());
  await storage.put(key, bytes, {
    httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' },
    customMetadata: { filename: '报告文件.bin', edgechatEncryption: 'v1' },
  });
  const object = await storage.get(key);
  assert.equal(object.customMetadata.filename, '报告文件.bin');
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
  assert.equal(object.uploaded.toISOString(), '2026-11-15T00:00:00.000Z');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  assert.equal(headers.get('cache-control'), 'private, no-store');
  assert.equal(headers.has('authorization'), false);
  await storage.delete(key);
  assert.equal(await storage.get(key), null);
  assert.equal(requests.length, 4);
});

test('S3 supports virtual-host addressing, endpoint path prefixes and custom regions', async (t) => {
  t.mock.method(globalThis, 'fetch', async (request) => {
    assert.equal(request.url, 'https://edgechat.storage.example.test/s3/42/file.bin');
    assert.match(request.headers.get('authorization'), /\/eu-west-2\/s3\//);
    assert.equal(request.headers.get('x-amz-security-token'), 'temporary-session');
    return new Response(null, { status: 204 });
  });
  await getFileStorage(env({
    endpoint: 'https://storage.example.test/s3/',
    region: 'eu-west-2',
    forcePathStyle: false,
    sessionToken: 'temporary-session',
  })).delete('42/file.bin');
});

test('S3 ListObjectsV2 handles encoded keys, opaque XML cursors, single and empty pages', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(request.url);
    assert.equal(url.searchParams.get('encoding-type'), 'url');
    assert.equal(url.searchParams.get('max-keys'), '1000');
    calls++;
    if (calls === 1) {
      return new Response(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <EncodingType>url</EncodingType><IsTruncated>true</IsTruncated>
        <Contents><Key>42%2F%E6%96%87%E4%BB%B6%20%2B%25.bin</Key><Size>123</Size><LastModified>2026-11-15T00:00:00Z</LastModified></Contents>
        <NextContinuationToken>opaque+/%2F%25&amp;next=</NextContinuationToken>
      </ListBucketResult>`);
    }
    assert.equal(url.searchParams.get('continuation-token'), 'opaque+/%2F%25&next=');
    return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
  });
  const storage = getFileStorage(env());
  const page = await storage.list();
  assert.equal(page.objects[0].key, '42/文件 +%.bin');
  assert.equal(page.objects[0].size, 123);
  assert.equal(page.truncated, true);
  assert.equal(page.cursor, 'opaque+/%2F%25&next=');
  assert.deepEqual(await storage.list({ cursor: page.cursor }), { objects: [], truncated: false, cursor: undefined });
});

test('S3 errors are sanitized, deletion failures remain retryable, malformed lists never publish partial snapshots', async (t) => {
  let response = () => new Response('provider-secret details', { status: 403 });
  const mockedFetch = t.mock.method(globalThis, 'fetch', async () => response());
  const storage = getFileStorage(env());
  const safe = (error) => error.status === 502 && !error.message.includes('provider-secret') && !error.cause;
  await assert.rejects(storage.get('42/file'), safe);
  await assert.rejects(storage.put('42/file', new Uint8Array()), safe);
  await assert.rejects(storage.delete('42/file'), safe);
  assert.equal(mockedFetch.mock.callCount(), 3);
  response = () => new Response(null, { status: 404 });
  await assert.rejects(storage.delete('42/file'), safe);
  for (const body of [
    '<html>not a list</html>',
    '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
    '<!DOCTYPE x [<!ENTITY x "expanded">]><ListBucketResult>&x;</ListBucketResult>',
  ]) {
    response = () => new Response(body);
    await assert.rejects(storage.list(), safe);
  }
  response = () => { throw new Error('provider-secret network detail'); };
  await assert.rejects(storage.get('42/file'), safe);
});

test('S3 refuses dot-segment keys before a network request can target another object', async (t) => {
  const mockedFetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  await assert.rejects(getFileStorage(env()).delete('42/../other'));
  assert.equal(mockedFetch.mock.callCount(), 0);
});
