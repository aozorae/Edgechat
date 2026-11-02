import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import worker from '../worker/src/index.js';
import { ChannelRoom } from '../worker/src/do/ChannelRoom.js';
import { TelegramNotifications } from '../worker/src/do/TelegramNotifications.ts';
import { encryptSecretValue } from '../worker/src/encryption.js';
import { putSession } from '../worker/src/auth.js';
import { enqueueTelegramNotification, deliverTelegramNotification, nextTelegramNotificationAt,
  rescueTelegramNotifications } from '../worker/src/integrations/telegram/notification-queue.ts';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const SQL = await initSqlJs();
async function fixture(t, count = 30) {
  const db = new SQL.Database();
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  for (let id = 1; id <= count; id++) {
    db.run(`INSERT INTO users (id, username, display_name, password_hash, password_salt)
      VALUES (?, ?, ?, 'hash', 'salt')`, [id, `user${id}`, `User ${id}`]);
    db.run('INSERT INTO telegram_notification_users (user_id, telegram_chat_id) VALUES (?, ?)', [id, String(id + 1000)]);
  }
  const alarms = [];
  let deleted = 0;
  const env = { DB: createD1Adapter(db), SESSIONS: createKvAdapter(),
    EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({ activeKeyId: 'v1', keys: { v1: Buffer.alloc(32, 7).toString('base64') } }) };
  const scheduler = new TelegramNotifications({ storage: {
    async setAlarm(at) { alarms.push(at); }, async deleteAlarm() { deleted++; },
  } }, env);
  env.TELEGRAM_NOTIFICATIONS = { idFromName: name => name, get: () => scheduler };
  const bot = await encryptSecretValue(env, '123456:example-token', 'telegram:bot-token');
  const secret = await encryptSecretValue(env, 'secret', 'telegram:webhook-secret');
  db.run(`INSERT INTO telegram_bridge_config (id, bot_token_ciphertext, webhook_secret_ciphertext, bot_username, webhook_url)
    VALUES (1, ?, ?, 'EdgeChatBot', 'https://notification.test/api/integrations/telegram/webhook')`, [bot, secret]);
  const requests = [];
  const originalFetch = globalThis.fetch;
  let response = () => Response.json({ ok: true, result: { message_id: 1 } });
  globalThis.fetch = async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return response(); };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { db, env, scheduler, alarms, requests, deleted: () => deleted,
    response: fn => { response = fn; },
    count: (where = '1=1') => db.exec(`SELECT COUNT(*) FROM telegram_notification_outbox WHERE ${where}`)[0].values[0][0],
    due() { db.run("UPDATE telegram_notification_outbox SET next_attempt_at = datetime('now', '-1 minute')"); },
    clearGates() {
      db.run("UPDATE telegram_notification_gate SET next_send_at = '1970-01-01 00:00:00'");
      db.run("UPDATE telegram_notification_users SET next_notification_at = '1970-01-01 00:00:00'");
    },
  };
}
async function enqueue(env, senderId, userId, id, kind = 'dm', channel = 17) {
  // 短预览在投递时读取真实消息并验证成员，预算测试也需建立对应的最小消息上下文。
  await env.DB.prepare("INSERT OR IGNORE INTO channels (id, kind, name) VALUES (?, ?, ?)")
    .bind(channel, kind === 'dm' ? 'dm' : 'public', `Private room ${channel}`).run();
  await env.DB.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?), (?, ?)')
    .bind(channel, senderId, channel, userId).run();
  await env.DB.prepare("INSERT OR IGNORE INTO messages (id, channel_id, sender_id, content) VALUES (?, ?, ?, 'message body')")
    .bind(id, channel, senderId).run();
  return enqueueTelegramNotification(env, { userId, senderId, room: { id: channel, name: 'Private room' }, message: { id }, kind });
}

test('通知：增量迁移保留旧绑定、偏好与投递记录并回填预算时间', t => {
  const db = new SQL.Database();
  t.after(() => db.close());
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1)');
  db.exec(readFileSync(new URL('../worker/migrations/2026-09-26-telegram-notifications.sql', import.meta.url), 'utf8'));
  db.run("INSERT INTO telegram_notification_users (user_id, telegram_chat_id, mention_enabled) VALUES (1, '1001', 0)");
  db.run("INSERT INTO telegram_notification_outbox (user_id, channel_id, message_id, kind, room_name, attempts) VALUES (1, 17, 21, 'dm', 'Old room', 2)");
  db.exec(readFileSync(new URL('../worker/migrations/2026-10-11-telegram-notification-budgets.sql', import.meta.url), 'utf8'));
  assert.deepEqual(db.exec('SELECT telegram_chat_id, mention_enabled, next_notification_at FROM telegram_notification_users')[0].values[0], ['1001', 0, '1970-01-01 00:00:00']);
  assert.deepEqual(db.exec('SELECT message_id, attempts, sender_id, created_at = updated_at FROM telegram_notification_outbox')[0].values[0], [21, 2, 0, 1]);
  assert.equal(db.exec('SELECT COUNT(*) FROM telegram_notification_gate')[0].values[0][0], 1);
});

test('通知：并发私信受收件人预算限制，延迟合并，重放不触发新请求', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 50 }, (_, i) => enqueue(f.env, 1, 2, i + 1)));
  assert.equal(f.count(), 5);
  assert.equal(f.requests.length, 0);
  assert.ok(f.alarms.length > 0);
  await enqueue(f.env, 1, 2, 1);
  assert.equal(f.count(), 5);
  f.due();
  await f.scheduler.alarm();
  assert.equal(f.requests.length, 1);
  assert.equal(f.count("status = 'sent'"), 5);
  assert.match(f.requests[0].body.text, /message …/);
  assert.ok(!f.requests[0].body.text.includes('message body'));
  assert.match(f.requests[0].body.text, /https:\/\/notification\.test\/\?notificationRoomKind=dm&notificationRoomId=17/);
  assert.equal(f.requests[0].body.link_preview_options.is_disabled, true);
  assert.match(f.requests[0].body.text, /User 1/);
  assert.equal(f.deleted(), 1);
});

test('通知：跨房间并发发送者预算和每消息群提及扇出均不可绕过', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 25 }, (_, i) => enqueue(f.env, 1, i + 2, i + 1, 'mention', i + 10)));
  assert.equal(f.count(), 20);
  f.db.run("UPDATE telegram_notification_outbox SET created_at = datetime('now', '-2 minutes')");
  await Promise.all(Array.from({ length: 25 }, (_, i) => enqueue(f.env, 1, i + 2, 99, 'mention', 99)));
  assert.equal(f.count('message_id = 99'), 10);
});

test('通知：全站入队预算和积压上限限制队列增长', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 120; i++) await enqueue(f.env, Math.floor(i / 20) + 1, (i % 24) + 2, i + 1);
  assert.equal(f.count(), 100);
  for (let batch = 1; batch <= 5; batch++) {
    f.db.run("UPDATE telegram_notification_outbox SET created_at = datetime('now', '-2 minutes')");
    for (let i = 0; i < 100; i++) await enqueue(f.env, Math.floor(i / 20) + 1, (i % 24) + 2, batch * 1000 + i);
  }
  assert.equal(f.count(), 500);
});

test('通知：发送和重试共享 Bot 闸门，收件人一分钟内不重复打扰', async t => {
  const f = await fixture(t);
  await enqueue(f.env, 1, 2, 1);
  await enqueue(f.env, 3, 4, 2);
  f.due();
  await Promise.all([deliverTelegramNotification(f.env), deliverTelegramNotification(f.env)]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.count("status = 'pending'"), 1);
  f.db.run("UPDATE telegram_notification_gate SET next_send_at = '1970-01-01 00:00:00'");
  await deliverTelegramNotification(f.env);
  assert.equal(f.requests.length, 2);
  await enqueue(f.env, 1, 2, 3);
  f.due();
  f.db.run("UPDATE telegram_notification_gate SET next_send_at = '1970-01-01 00:00:00'");
  await deliverTelegramNotification(f.env);
  assert.equal(f.requests.length, 2);
  assert.ok(await nextTelegramNotificationAt(f.env) > Date.now());
});

test('通知：429 的 retry_after 暂停全站，其他发送者不消耗尝试次数', async t => {
  const f = await fixture(t);
  await enqueue(f.env, 1, 2, 1);
  await enqueue(f.env, 3, 4, 2);
  f.due();
  f.response(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 120 }, description: 'rate limit' }, { status: 429 }));
  await f.scheduler.alarm();
  await f.scheduler.alarm();
  await rescueTelegramNotifications(f.env);
  assert.equal(f.requests.length, 1);
  assert.equal(f.db.exec('SELECT attempts FROM telegram_notification_outbox ORDER BY id')[0].values[1][0], 0);
  assert.ok(await nextTelegramNotificationAt(f.env) >= Date.now() + 118_000);
  f.response(() => Response.json({ ok: true, result: { message_id: 2 } }));
  f.clearGates();
  // 429 行仍在未来，健康发送者的到期提醒应当先获得服务。
  await f.scheduler.alarm();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].body.chat_id, '1004');
});

test('通知：有限重试、最后租约中断恢复、关闭偏好及 DO 内部门禁', async t => {
  const f = await fixture(t);
  await enqueue(f.env, 1, 2, 1);
  f.response(() => Response.json({ ok: false, description: 'temporary' }, { status: 503 }));
  for (let i = 0; i < 5; i++) { f.due(); f.clearGates(); await f.scheduler.alarm(); }
  assert.equal(f.requests.length, 4);
  assert.equal(f.count("status = 'failed'"), 1);
  await enqueue(f.env, 3, 4, 2);
  f.db.run("UPDATE telegram_notification_outbox SET status = 'sending', attempts = 4 WHERE message_id = 2");
  f.due(); f.clearGates(); await f.scheduler.alarm();
  assert.equal(f.count("status = 'failed'"), 2);
  await enqueue(f.env, 1, 5, 3);
  f.db.run('UPDATE telegram_notification_users SET dm_enabled = 0 WHERE user_id = 5');
  f.due(); f.clearGates(); await f.scheduler.alarm();
  assert.equal(f.requests.length, 4);
  assert.equal(await nextTelegramNotificationAt(f.env), null);
  const alarmCount = f.alarms.length;
  assert.equal((await f.scheduler.fetch(new Request('https://internal/wake'))).status, 401);
  assert.equal(f.alarms.length, alarmCount);
});

test('通知：真实 HTTP→ChannelRoom→SQL 投影队列限制 distinct DM，429 不拖垮他人的重试', async t => {
  const f = await fixture(t);
  f.db.run("INSERT INTO channels (id, kind, name, dm_key) VALUES (17, 'dm', 'DM', '1:2'), (18, 'dm', 'DM2', '3:4')");
  f.db.run('INSERT INTO channel_members (channel_id, user_id) VALUES (17, 1), (17, 2), (18, 3), (18, 4)');
  const pending = [];
  const state = { getWebSockets: () => [], waitUntil: p => pending.push(p) };
  const room = new ChannelRoom(state, f.env);
  f.env.CHANNEL_ROOM = { idFromName: name => name, get: () => room };
  f.env.USER_INBOX = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const token1 = 'local-sender-one';
  const token3 = 'local-sender-three';
  await putSession(f.env, { token: token1, userId: 1, username: 'user1', displayName: 'User 1', sessionVersion: 0 });
  await putSession(f.env, { token: token3, userId: 3, username: 'user3', displayName: 'User 3', sessionVersion: 0 });
  const messageIds = new Map();
  async function post(token, channel, id, kind = 'dm', fields = {}) {
    if (!messageIds.has(id)) messageIds.set(id, crypto.randomUUID());
    const result = await worker.fetch(new Request(`https://notification.test/api/v1/rooms/${kind}/${channel}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: messageIds.get(id), content: 'Private content', ...fields }),
    }), f.env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending.splice(0));
    return result;
  }
  assert.equal((await post('', 17, 'unauthenticated')).status, 401);
  for (let i = 0; i < 8; i++) {
    const result = await post(token1, 17, `distinct-${i}`);
    assert.equal(result.status, 200, JSON.stringify(await result.json()));
  }
  assert.equal(f.count(), 5);
  assert.equal(f.count('sender_id = 1'), 5);
  assert.equal(f.requests.length, 0);
  await post(token1, 17, 'distinct-0');
  assert.equal(f.count(), 5);
  assert.equal((await post(token3, 18, 'another-sender')).status, 200);
  f.due();
  f.response(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, { status: 429 }));
  await f.scheduler.alarm(); await f.scheduler.alarm();
  assert.equal(f.requests.length, 1);
  assert.equal(f.count('user_id = 4 AND attempts = 0'), 1);
  f.clearGates();
  f.response(() => Response.json({ ok: true, result: { message_id: 2 } }));
  await f.scheduler.alarm();
  assert.equal(f.requests.at(-1).body.chat_id, '1004');
  assert.equal(f.count("user_id = 4 AND status = 'sent'"), 1);
  f.db.run("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (2, 1)");
  assert.equal((await post(token1, 17, 'blocked-message')).status, 403);
  assert.equal(f.count(), 6);
  f.db.run('UPDATE telegram_notification_users SET dm_enabled = 0 WHERE user_id = 4');
  assert.equal((await post(token3, 18, 'opted-out')).status, 200);
  assert.equal(f.count(), 6);
  f.db.run("INSERT INTO channels (id, kind, name) VALUES (19, 'public', 'Group')");
  for (let id = 1; id <= 26; id++) f.db.run('INSERT INTO channel_members (channel_id, user_id) VALUES (19, ?)', [id]);
  const mentionIds = Array.from({ length: 25 }, (_, i) => i + 2);
  assert.equal((await post(token1, 19, 'no-valid-mention', 'public', { mentionUserIds: mentionIds })).status, 200);
  assert.equal(f.count(), 6);
  const result = await post(token1, 19, 'valid-mentions', 'public', {
    content: mentionIds.map(id => `@user${id}`).join(' '), mentionUserIds: mentionIds,
  });
  assert.equal(result.status, 200);
  assert.equal(f.count("kind = 'mention'"), 10);
  assert.equal(f.requests.length, 2);
});
