import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';

import worker from '../worker/src/index.js';
import { hashPassword } from '../worker/src/auth.js';
import {
  getRoomSyncCursor,
  insertMessageIdempotent,
  listRoomMessageEvents
} from '../worker/src/data/messages.js';
import { runScheduledGc } from '../worker/src/gc.js';
import { saveUploadedFile } from '../worker/src/api/upload.js';
import {
  createMobileDeviceSession,
  refreshMobileDeviceSession,
  revokeMobileDeviceSession
} from '../worker/src/mobile-session.js';
import { issueRealtimeTicket, consumeRealtimeTicket } from '../worker/src/realtime-tickets.js';
import { validateSession } from '../worker/src/session.js';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const SQL = await initSqlJs();

function encodedKey(seed = 1) {
  return Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => seed + index)).toString(
    'base64'
  );
}

function createEnvironment() {
  const database = new SQL.Database();
  database.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  const files = new Map();
  return {
    database,
    env: {
      DB: createD1Adapter(database),
      SESSIONS: createKvAdapter(),
      EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({
        activeKeyId: 'test-v1',
        keys: { 'test-v1': encodedKey() }
      }),
      MAX_FILE_SIZE: '20971520',
			ALLOWED_FILE_TYPES: 'image/,video/,audio/,text/,application/pdf,application/octet-stream',
      FILES: {
        files,
        async put(key, value, metadata) {
          files.set(key, { value, metadata });
        },
        async delete(key) {
          files.delete(key);
        },
        async get(key) {
          return files.get(key) || null;
        }
      }
    }
  };
}

async function seedUser(database, username = 'alice') {
  const password = 'correct horse battery staple';
  const credentials = await hashPassword(password);
  database.run(
    `INSERT INTO users (
       username, display_name, password_hash, password_salt, is_super_admin, session_version
     ) VALUES (?, ?, ?, ?, 0, 0)`,
    [username, 'Alice', credentials.hash, credentials.salt]
  );
  const id = Number(database.exec('SELECT last_insert_rowid()')[0].values[0][0]);
  return {
    password,
    user: {
      id,
      username,
      display_name: 'Alice',
      avatar_key: null,
      is_super_admin: 0,
      session_version: 0
    }
  };
}

test('设备会话轮换 refresh token，注销后立即拒绝现有 access token', async () => {
  const { database, env } = createEnvironment();
  const { user } = await seedUser(database);
  const device = {
    installationId: crypto.randomUUID(),
    name: 'Pixel test',
    appVersion: '1.0.0'
  };
  const first = await createMobileDeviceSession(env, user, device);
  assert.equal((await validateSession(env, first.accessToken)).ok, true);

  const second = await refreshMobileDeviceSession(
    env,
    first.refreshToken,
    device.installationId
  );
  assert.notEqual(second.refreshToken, first.refreshToken);
  await assert.rejects(
    refreshMobileDeviceSession(env, first.refreshToken, device.installationId),
    /刷新凭据/
  );
  assert.equal((await validateSession(env, second.accessToken)).ok, true);

  const stored = JSON.parse(await env.SESSIONS.get(second.accessToken));
  await revokeMobileDeviceSession(env, stored);
  assert.equal((await validateSession(env, second.accessToken)).ok, false);
});

test('实时票据绑定移动会话并且只能消费一次', async () => {
  const { database, env } = createEnvironment();
  const { user } = await seedUser(database);
  const login = await createMobileDeviceSession(env, user, {
    installationId: crypto.randomUUID(),
    name: 'Ticket device',
    appVersion: '1.0.0'
  });
  const session = JSON.parse(await env.SESSIONS.get(login.accessToken));
  const issued = await issueRealtimeTicket(env, session, {
    scope: 'room',
    roomKind: 'public',
    roomId: 1
  });
  const consumed = await consumeRealtimeTicket(env, issued.ticket);
  assert.equal(consumed.scope, 'room');
  assert.equal(consumed.roomId, 1);
  assert.equal(await consumeRealtimeTicket(env, issued.ticket), null);
});

test('客户端消息和附件重试复用同一服务端记录', async () => {
  const { database, env } = createEnvironment();
  const { user } = await seedUser(database);
  const channelId = Number(
    database.exec("SELECT id FROM channels WHERE name = 'general'")[0].values[0][0]
  );
  const clientMessageId = crypto.randomUUID();
  const firstMessage = await insertMessageIdempotent(env, {
    channelId,
    senderId: user.id,
    content: 'hello',
    clientMessageId
  });
  const retryMessage = await insertMessageIdempotent(env, {
    channelId,
    senderId: user.id,
    content: 'hello',
    clientMessageId
  });
  assert.equal(firstMessage.created, true);
  assert.equal(retryMessage.created, false);
  assert.equal(retryMessage.message.id, firstMessage.message.id);
  assert.equal(retryMessage.message.clientMessageId, clientMessageId);

  database.run("INSERT INTO channels (name, kind, created_by) VALUES ('mobile-test', 'private', ?)", [
    user.id
  ]);
  const secondChannelId = Number(database.exec('SELECT last_insert_rowid()')[0].values[0][0]);
  const sameIdInAnotherRoom = await insertMessageIdempotent(env, {
    channelId: secondChannelId,
    senderId: user.id,
    content: 'same client id, different room',
    clientMessageId
  });
  assert.equal(sameIdInAnotherRoom.created, true);
  assert.notEqual(sameIdInAnotherRoom.message.id, firstMessage.message.id);

  const uploadId = crypto.randomUUID();
  const file = new File([new TextEncoder().encode('file body')], 'note.txt', {
    type: 'text/plain'
  });
  const firstUpload = await saveUploadedFile(env, { userId: user.id }, file, {
    clientUploadId: uploadId
  });
  const retryUpload = await saveUploadedFile(env, { userId: user.id }, file, {
    clientUploadId: uploadId
  });
  assert.equal(firstUpload.created, true);
  assert.equal(retryUpload.created, false);
	assert.equal(retryUpload.file.key, firstUpload.file.key);
	assert.equal(env.FILES.files.size, 1);
	const voiceUpload = await saveUploadedFile(
		env,
		{ userId: user.id },
		new File([Uint8Array.from([1, 2, 3])], 'voice.ogg', { type: 'audio/ogg' }),
	);
	assert.equal(voiceUpload.file.type, 'audio/ogg');

  database.run('UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [
    firstMessage.message.id
  ]);
  const sync = await listRoomMessageEvents(env, channelId, 0, 100);
  assert.equal(sync.events.at(-1).type, 'message_deleted');
  assert.equal(sync.events.at(-1).messageId, firstMessage.message.id);

  await assert.rejects(
    insertMessageIdempotent(env, {
      channelId,
      senderId: user.id,
      content: 'deleted retry',
      clientMessageId
    }),
    /idempotency key was already consumed/
  );

  database.run(
    `INSERT INTO message_event_compaction (channel_id, compacted_through)
     VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET compacted_through = excluded.compacted_through`,
    [channelId, sync.nextCursor]
  );
  await assert.rejects(
    listRoomMessageEvents(env, channelId, sync.nextCursor - 1, 100),
    (error) => error.code === 'sync_cursor_expired' && error.status === 409
  );
});

test('API v1 从 capabilities、设备登录到复用 bootstrap 保持统一契约', async () => {
  const { database, env } = createEnvironment();
  const { password } = await seedUser(database);

  const capabilities = await worker.fetch(new Request('https://chat.example/api/v1/capabilities'), env);
  assert.equal(capabilities.status, 200);
  const capabilityPayload = await capabilities.json();
  assert.equal(capabilityPayload.apiVersion, 1);
  assert.equal(capabilityPayload.limits.messageRetentionDays, 30);
  const customCapabilities = await worker.fetch(
    new Request('https://chat.example/api/v1/capabilities'),
    { ...env, MESSAGE_RETENTION_DAYS: '7' }
  );
  assert.equal((await customCapabilities.json()).limits.messageRetentionDays, 7);

  const login = await worker.fetch(
    new Request('https://chat.example/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice',
        password,
        device: {
          installationId: crypto.randomUUID(),
          name: 'API device',
          appVersion: '1.0.0'
        }
      })
    }),
    env
  );
  assert.equal(login.status, 200);
  const credentials = await login.json();
  assert.ok(credentials.accessToken);
  assert.ok(credentials.refreshToken);

  const bootstrap = await worker.fetch(
    new Request('https://chat.example/api/v1/bootstrap', {
      headers: { Authorization: `Bearer ${credentials.accessToken}` }
    }),
    env
  );
  assert.equal(bootstrap.status, 200);
  const payload = await bootstrap.json();
  assert.equal(Array.isArray(payload.channels), true);
  assert.equal(payload.channels[0].name, 'general');

  const unauthorized = await worker.fetch(
    new Request('https://chat.example/api/v1/bootstrap'),
    env
  );
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(Object.keys((await unauthorized.json()).error).sort(), ['code', 'message']);
});

test('GC 清理同步事件前记录每个会话的压缩游标', async () => {
  const { database, env } = createEnvironment();
  const { user } = await seedUser(database);
  const channelId = Number(
    database.exec("SELECT id FROM channels WHERE name = 'general'")[0].values[0][0]
  );
  const message = await insertMessageIdempotent(env, {
    channelId,
    senderId: user.id,
    content: 'old event',
    clientMessageId: crypto.randomUUID()
  });
  assert.ok(message.message.id > 0);
  const eventSequence = database.exec('SELECT MAX(sequence) FROM message_events')[0].values[0][0];
  database.run("UPDATE message_events SET created_at = datetime('now', '-10 day')");

  const summary = await runScheduledGc({
    ...env,
    MESSAGE_RETENTION_DAYS: '7',
    GC_BATCH_SIZE: '10'
  });

  assert.equal(summary.expiredMessageEventsDeleted, 1);
  assert.equal(database.exec('SELECT COUNT(*) FROM message_events')[0].values[0][0], 0);
  assert.equal(await getRoomSyncCursor(env.DB, channelId), eventSequence);
  assert.equal(
    database.exec(
      `SELECT compacted_through FROM message_event_compaction WHERE channel_id = ${channelId}`
    )[0].values[0][0],
    eventSequence
  );
});
