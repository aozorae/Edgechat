import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { Hono } from 'hono';
import { registerDirectUploads } from '../worker/src/api/direct-uploads.ts';
import { canAccessFile } from '../worker/src/data/uploaded-files.js';
import { serveDirectFile } from '../worker/src/storage/direct-read.ts';
import { createD1Adapter } from './support/d1.js';
import { CHUNK_BYTES, chunkAlgorithm, decryptedResponse, decode64, encode64 } from '../frontend/public/attachment-crypto.js';

test('direct multipart reservations, owner-bound tickets and immutable publication', async t => {
  const sql = new (await initSqlJs()).Database();
  t.after(() => sql.close());
  sql.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users (id, username, display_name, password_hash, password_salt) VALUES(1,'u','U','x','x')");
  const DB = createD1Adapter(sql);
  let metadata, ciphertext, object;
  let completions = 0;
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']);
  const env = { DB, EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({ activeKeyId: 'test', keys: { test: encode64(new Uint8Array(32).fill(9)) } }),
    EDGECHAT_R2_DIRECT: JSON.stringify({ accountId: 'a'.repeat(32), bucket: 'files', accessKeyId: 'test', secretAccessKey: 'test' }),
    EDGECHAT_FILE_WRAPPING: JSON.stringify({ publicKey: encode64(await crypto.subtle.exportKey('spki', pair.publicKey)), privateKey: encode64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)) }),
    FILES: {
      async createMultipartUpload(_key, options) { metadata = options.customMetadata; return { uploadId: 'multipart-id' }; },
      async head() { return object; },
      resumeMultipartUpload() { return { complete: async () => {
        completions++;
        object = { size: ciphertext.byteLength, customMetadata: metadata };
        return object;
      } }; },
      async get(_key, { range }) { return { body: new Blob([ciphertext.slice(range.offset, range.offset + range.length)]).stream() }; },
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('session', { userId: Number(c.req.header('user')) }); await next(); });
  app.onError((err, c) => c.json({ error: err.message }, err.status || 500));
  registerDirectUploads(app);
  const call = (path, body, user = 1) => app.request('/api/uploads/' + path, {
    method: body ? 'POST' : 'GET', headers: { user: String(user), 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  }, env);
  const opts = await (await call('options')).json();
  assert.equal(opts.maxBytes, 20 * 1048576);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const pub = await crypto.subtle.importKey('spki', decode64(opts.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const wrapped = encode64(await crypto.subtle.encrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode(opts.keyLabel) }, pub, raw));
  const input = { size: 5, type: 'text/plain', name: '报告.txt', wrapped };
  assert.equal((await call('direct/start', { ...input, size: opts.maxBytes + 1 })).status, 413);
  assert.equal((await call('direct/start', { ...input, type: 'text/html' })).status, 400);
  assert.equal((await call('direct/start', input, 2)).status, 400);
  const { key, ticket } = await (await call('direct/start', input)).json();
  assert.ok(ticket);
  assert.equal(await canAccessFile(DB, key, 1), false);
  assert.equal((await call('direct/parts', { ticket, first: 0 }, 2)).status, 403);
  const { urls } = await (await call('direct/parts', { ticket, first: 0 })).json();
  const url = new URL(urls[0]);
  assert.equal(url.searchParams.get('partNumber'), '1');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  ciphertext = await crypto.subtle.encrypt(chunkAlgorithm(key, 5, 0), aes, new TextEncoder().encode('hello'));
  const finish = { ticket, etags: ['a'.repeat(32)] };
  assert.equal((await call('direct/finish', finish, 2)).status, 403);
  assert.equal((await call('direct/finish', { ...finish, etags: [] })).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await (await call('direct/finish', finish)).json()).file.key, key);
  assert.equal(completions, 1);
  assert.equal(await canAccessFile(DB, key, 1), true);
  assert.equal(await canAccessFile(DB, key, 2), false);
  const request = new Request('https://example.com');
  const meta = { size: 5, contentType: 'text/plain' };
  const response = await serveDirectFile(env, key, meta, request, 'attachment');
  assert.equal(await response.text(), 'hello');
  new Uint8Array(ciphertext)[0] ^= 1;
  const corrupt = await serveDirectFile(env, key, meta, request, 'attachment');
  await assert.rejects(corrupt.arrayBuffer());
  sql.run('DELETE FROM uploaded_files WHERE object_key = ?', [key]);
  assert.equal((await call('direct/finish', finish)).status, 410);
});

test('chunk authentication and ranges include the last byte and empty-file tag', async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const secret = encode64(raw);
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  for (const size of [0, CHUNK_BYTES + 3]) {
    const key = '1/direct-v2/test';
    const bytes = new Uint8Array(size).fill(71);
    const blocks = [];
    for (let i = 0; i < Math.max(1, Math.ceil(size / CHUNK_BYTES)); i++) {
      blocks.push(await crypto.subtle.encrypt(chunkAlgorithm(key, size, i), aes, bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)));
    }
    const encrypted = new Blob(blocks);
    const read = (offset, length) => Promise.resolve(encrypted.slice(offset, offset + length).stream());
    const info = { key, size, secret, headers: {} };
    const response = await decryptedResponse(info, size ? 'bytes=8388607-8388609' : null, read);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), size ? bytes.slice(CHUNK_BYTES - 1, CHUNK_BYTES + 2) : bytes);
    assert.equal((await decryptedResponse(info, 'bytes=' + size + '-', read)).status, 416);
    const wrongKey = await decryptedResponse({ ...info, key: key + 'x' }, size ? 'bytes=-1' : null, read);
    await assert.rejects(wrongKey.arrayBuffer());
  }
});
