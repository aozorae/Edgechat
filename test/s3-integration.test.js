import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import worker from '../worker/src/index.js';
import { createSession } from '../worker/src/auth.js';
import { getUserByUsername } from '../worker/src/data/users.js';
import { cleanupR2Keys, runScheduledGc } from '../worker/src/gc.js';
import { deleteRoomMessage } from '../worker/src/message-deletion.js';
import { runSystemCheck } from '../worker/src/maintenance/system-check.ts';
import { importTelegramAttachment, loadEdgeChatAttachment, deleteImportedTelegramAttachment } from '../worker/src/integrations/telegram/files.js';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const SQL = await initSqlJs();
const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');

async function harness(t) {
  const database = new SQL.Database();
  t.after(() => database.close());
  database.exec(schema);
  database.run("INSERT INTO users (username, display_name, password_hash, password_salt, is_super_admin) VALUES ('owner', 'Owner', 'hash', 'salt', 1)");
  const env = {
    DB: createD1Adapter(database), SESSIONS: createKvAdapter(),
    EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 7).toString('base64') } }),
    EDGECHAT_S3: JSON.stringify({ endpoint: 'https://s3.test', bucket: 'files', accessKeyId: 'test-key', secretAccessKey: 'test-secret' }),
  };
  const session = await createSession(env, await getUserByUsername(env.DB, 'owner'));
  const objects = new Map();
  const calls = [];
  const failedDeletes = new Set();
  t.mock.method(globalThis, 'fetch', async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    if (url.hostname === 'api.telegram.org') {
      if (url.pathname.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'test.bin', file_size: 5 } });
      return new Response('hello');
    }
    assert.equal(url.origin, 'https://s3.test');
    assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
    const key = decodeURIComponent(url.pathname.slice('/files/'.length));
    calls.push({ key, method: request.method });
    if (url.searchParams.has('list-type')) {
      const items = [...objects].map(([name, value]) => `<Contents><Key>${encodeURIComponent(name)}</Key><Size>${value.bytes.byteLength}</Size><LastModified>2026-11-15T00:00:00Z</LastModified></Contents>`).join('');
      return new Response(`<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
    }
    if (request.method === 'PUT') {
      objects.set(key, { bytes: await request.arrayBuffer(), headers: new Headers(request.headers) });
      return new Response(null, { status: 200 });
    }
    if (request.method === 'DELETE') {
      if (failedDeletes.has(key)) return new Response('provider detail not for clients', { status: 503 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(key);
    return object ? new Response(object.bytes, { headers: object.headers }) : new Response(null, { status: 404 });
  });
  async function request(path, { method = 'GET', body, token = session.token } = {}) {
    const headers = new Headers(token ? { Authorization: `Bearer ${token}` } : {});
    if (body && !(body instanceof FormData)) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(body);
    }
    return worker.fetch(new Request(`https://edgechat.test${path}`, { method, body, headers }), env, { waitUntil(promise) { promise.catch(() => {}); } });
  }
  async function upload(path = '/api/upload', clientUploadId) {
    const body = new FormData();
    body.set('file', new File(['hello'], '报告.txt', { type: 'text/plain' }));
    if (clientUploadId) body.set('clientUploadId', clientUploadId);
    const response = await request(path, { method: 'POST', body });
    assert.equal(response.status, clientUploadId ? 201 : 200);
    return (await response.json()).file;
  }
  return { env, database, objects, calls, failedDeletes, request, upload };
}

test('S3-only deployment uploads encrypted bytes, enforces download authorization, and preserves public avatars', async (t) => {
  const h = await harness(t);
  const file = await h.upload();
  assert.notEqual(Buffer.from(h.objects.get(file.key).bytes).toString(), 'hello');
  const read = await h.request(file.url);
  assert.equal(read.status, 200);
  assert.equal(await read.text(), 'hello');
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  const before = h.calls.length;
  for (const token of ['', 'invalid']) assert.equal((await h.request(file.url, { token })).status, 403);
  assert.equal(h.calls.length, before);
  h.database.run('UPDATE users SET avatar_key = ? WHERE id = 1', [file.key]);
  assert.equal((await h.request(file.url, { token: '' })).status, 200);
  const capabilities = await h.request('/api/v1/capabilities');
  assert.equal((await capabilities.json()).features.idempotentUploads, true);
  const id = crypto.randomUUID();
  const mobile = await h.upload('/api/v1/uploads', id);
  const puts = h.calls.filter((call) => call.method === 'PUT').length;
  const body = new FormData();
  body.set('file', new File(['hello'], '报告.txt', { type: 'text/plain' }));
  body.set('clientUploadId', id);
  const duplicate = await h.request('/api/v1/uploads', { method: 'POST', body });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).file.key, mobile.key);
  assert.equal(h.calls.filter((call) => call.method === 'PUT').length, puts);
});

test('S3 scan and maintenance use the selected backend and never expose object keys or credentials', async (t) => {
  const h = await harness(t);
  const file = await h.upload();
  const scan = await h.request('/api/admin/storage/scan', { method: 'POST', body: {} });
  assert.equal(scan.status, 200);
  const result = await scan.json();
  assert.equal(result.scannedObjects, 1);
  assert.doesNotMatch(JSON.stringify(result), /test-secret|报告|test-key/);
  assert.equal(JSON.stringify(result).includes(file.key), false);
  assert.equal((await (await h.request('/api/admin/storage')).json()).items[0].objectCount, 1);
  const check = await runSystemCheck(h.env);
  assert.equal(check.checks.find((item) => item.id === 'files').status, 'ok');
  assert.equal(JSON.stringify(check).includes('test-secret'), false);
});

test('S3 cleanup preserves referenced objects, records retries, then deletes after a successful retry', async (t) => {
  const h = await harness(t);
  const file = await h.upload();
  h.database.run('UPDATE users SET avatar_key = ? WHERE id = 1', [file.key]);
  assert.equal((await cleanupR2Keys(h.env, [file.key])).r2SkippedReferenced, 1);
  h.database.run('UPDATE users SET avatar_key = NULL WHERE id = 1');
  h.failedDeletes.add(file.key);
  assert.equal((await cleanupR2Keys(h.env, [file.key])).r2DeleteFailed, 1);
  const pending = await h.env.DB.prepare('SELECT * FROM pending_r2_delete WHERE object_key = ?').bind(file.key).first();
  assert.equal(pending.retry_count, 1);
  assert.equal(pending.last_error.includes('provider detail'), false);
  assert.equal(h.objects.has(file.key), true);
  h.failedDeletes.clear();
  h.database.run("UPDATE pending_r2_delete SET next_retry_at = datetime('now', '-1 minute')");
  assert.equal((await runScheduledGc(h.env)).r2Deleted, 1);
  assert.equal(h.objects.has(file.key), false);
  assert.equal(await h.env.DB.prepare('SELECT * FROM uploaded_files WHERE object_key = ?').bind(file.key).first(), null);
});

test('S3 message deletion runs attachment cleanup without a FILES binding', async (t) => {
  const h = await harness(t);
  const file = await h.upload();
  h.database.run("INSERT INTO channels (kind, name) VALUES ('public', 'cleanup')");
  const channelId = Number(h.database.exec('SELECT last_insert_rowid()')[0].values[0][0]);
  h.database.run("INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, 1, 'owner')", [channelId]);
  h.database.run('INSERT INTO messages (channel_id, sender_id, attachment_key) VALUES (?, 1, ?)', [channelId, file.key]);
  const messageId = Number(h.database.exec('SELECT last_insert_rowid()')[0].values[0][0]);
  const result = await deleteRoomMessage(h.env, { principal: { userId: 1 }, room: { kind: 'public', id: channelId } }, { messageId });
  assert.ok(result.cleanupPromise);
  await result.cleanupPromise;
  assert.equal(h.objects.has(file.key), false);
});

test('Telegram S3 imports remain encrypted, load through the adapter, and clean up temporary objects', async (t) => {
  const h = await harness(t);
  const result = await importTelegramAttachment(h.env, {
    botToken: '123456:test-token', telegramChatId: -100, telegramMessageId: 1,
    attachment: { fileId: 'test-file', fileSize: 5, fileName: '报告.txt', mimeType: 'text/plain' },
  });
  assert.equal(result.skipReason, null);
  assert.notEqual(Buffer.from(h.objects.get(result.attachment.key).bytes).toString(), 'hello');
  const loaded = await loadEdgeChatAttachment(h.env, result.attachment);
  assert.equal(new TextDecoder().decode(loaded.file.bytes), 'hello');
  await deleteImportedTelegramAttachment(h.env, result.attachment);
  assert.equal(h.objects.size, 0);
});
