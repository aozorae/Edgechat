import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import worker from "../worker/src/index.js";
import { ChannelRoom } from "../worker/src/do/ChannelRoom.js";
import { encryptSecretValue } from "../worker/src/encryption.js";
import { getMessageById } from "../worker/src/data/messages.js";
import { buildTelegramNotification } from "../worker/src/integrations/telegram/notification-content.ts";
import { telegramDmButton } from "../worker/src/integrations/telegram/direct-messages.ts";
import { createD1Adapter } from "./support/d1.js";

const SQL = await initSqlJs();
async function fixture(t) {
  const db = new SQL.Database();
  db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
  db.run("PRAGMA foreign_keys = ON");
  for (let id = 1; id <= 14; id++) {
    db.run("INSERT INTO users (id, username, display_name, password_hash, password_salt) VALUES (?, ?, ?, 'hash', 'salt')",
      [id, `user${id}`, `用户 ${id}`]);
  }
  db.run("INSERT INTO telegram_notification_users (user_id, telegram_chat_id) VALUES (1, '1001'), (2, '1002')");
  db.run("INSERT INTO channels (id, kind, name, dm_key) VALUES (17, 'dm', 'DM', '1:2'), (18, 'dm', 'Other DM', '2:3'), (19, 'public', 'Group', NULL)");
  db.run("INSERT INTO channel_members (channel_id, user_id) VALUES (17, 1), (17, 2), (18, 2), (18, 3), (19, 1), (19, 2)");
  const pending = [];
  const env = { DB: createD1Adapter(db),
    EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({ activeKeyId: "v1", keys: { v1: Buffer.alloc(32, 7).toString("base64") } }) };
  const room = new ChannelRoom({ getWebSockets: () => [], waitUntil: p => pending.push(p) }, env);
  env.CHANNEL_ROOM = { idFromName: name => name, get: () => room };
  env.USER_INBOX = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  env.TELEGRAM_NOTIFICATIONS = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const bot = await encryptSecretValue(env, "123456:example-token", "telegram:bot-token");
  const secret = await encryptSecretValue(env, "secret", "telegram:webhook-secret");
  db.run("INSERT INTO telegram_bridge_config (id, bot_token_ciphertext, webhook_secret_ciphertext, bot_username) VALUES (1, ?, ?, 'EdgeChatBot')", [bot, secret]);
  const sent = [];
  let nextPrompt = 500;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const messageId = nextPrompt++;
    sent.push({ ...payload, message_id: messageId });
    return Response.json({ ok: true, result: { message_id: messageId } });
  };
  t.after(() => { globalThis.fetch = originalFetch; db.close(); });
  let nextMessage = 1;
  async function post(text, extra = {}, secretHeader = "secret") {
    const message = { message_id: nextMessage++, chat: { id: 1001, type: "private" }, from: { id: 1001 }, text, ...extra };
    const response = await worker.fetch(new Request("https://telegram.test/api/integrations/telegram/webhook", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secretHeader },
      body: JSON.stringify({ update_id: message.message_id, message }),
    }), env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending.splice(0));
    return response;
  }
  const select = id => post(telegramDmButton({ id, name: `用户 ${id}` }).text);
  const count = () => db.exec("SELECT COUNT(*) FROM messages WHERE channel_id = 17")[0].values[0][0];
  return { db, env, sent, post, select, count };
}

test("Telegram：命令→私聊按钮→回复→真实 DO 加密写入、投影与重复 webhook 去重", async t => {
  const f = await fixture(t);
  assert.equal((await f.post("/chats", {}, "wrong")).status, 401);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.post("/chats")).status, 200);
  const labels = f.sent.at(-1).reply_markup.keyboard.flat().map(button => button.text);
  assert.ok(labels.some(label => label.includes("[17]")));
  assert.ok(!labels.some(label => /\[(18|19)\]/.test(label)));
  await f.select(17);
  const prompt = f.sent.at(-1);
  assert.equal(prompt.reply_markup.force_reply, true);
  const reply = { message_id: 100, reply_to_message: { message_id: prompt.message_id } };
  assert.equal((await f.post("你好 <b>明文</b>", reply)).status, 200);
  assert.equal((await f.post("你好 <b>明文</b>", reply)).status, 200);
  assert.equal(f.count(), 1);
  const row = await f.env.DB.prepare("SELECT id, content, sender_id, client_message_id FROM messages WHERE channel_id = 17").first();
  assert.match(row.content, /^edgechat:enc:v1:/);
  assert.equal(row.sender_id, 1);
  assert.equal(row.client_message_id, "tg:1001:100");
  assert.equal((await getMessageById(f.env, row.id)).content, "你好 <b>明文</b>");
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM telegram_notification_outbox WHERE user_id = 2").first()).count, 1);
});

test("Telegram：分页只列本人可发送私聊，伪造群/他人房间和普通文字不能发信", async t => {
  const f = await fixture(t);
  for (let id = 4; id <= 14; id++) {
    f.db.run("INSERT INTO channels (id, kind, name, dm_key) VALUES (?, 'dm', ?, ?)", [id + 20, `DM ${id}`, `1:${id}`]);
    f.db.run("INSERT INTO channel_members (channel_id, user_id) VALUES (?, 1), (?, ?)", [id + 20, id + 20, id]);
  }
  await f.post("/chats");
  assert.equal(f.sent.at(-1).reply_markup.keyboard.filter(row => row[0].text.startsWith("✉")).length, 8);
  assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().some(button => button.text === "▶ 私聊第 2 页"));
  await f.post("▶ 私聊第 2 页");
  assert.equal(f.sent.at(-1).reply_markup.keyboard.filter(row => row[0].text.startsWith("✉")).length, 4);
  await f.select(18);
  assert.match(f.sent.at(-1).text, /不可发送/);
  await f.select(19);
  assert.match(f.sent.at(-1).text, /不可发送/);
  await f.post("不应默认发送到上一次的联系人");
  assert.equal(f.count(), 0);
  await f.post("/chats", { from: { id: 2001 } });
  assert.equal(f.count(), 0);
});

test("Telegram：拉黑/封禁/退会话/解绑/过期/取消均使提示失效", async t => {
  const f = await fixture(t);
  await f.select(17);
  const promptId = f.sent.at(-1).message_id;
  const reply = { reply_to_message: { message_id: promptId } };
  f.db.run("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (2, 1)");
  await f.post("拒绝", reply);
  assert.equal(f.count(), 0);
  f.db.run("DELETE FROM user_blocks");
  f.db.run("UPDATE users SET is_disabled = 1 WHERE id = 1");
  await f.post("拒绝", reply);
  assert.equal(f.count(), 0);
  f.db.run("UPDATE users SET is_disabled = 0 WHERE id = 1");
  f.db.run("DELETE FROM channel_members WHERE channel_id = 17 AND user_id = 1");
  await f.post("拒绝", reply);
  assert.equal(f.count(), 0);
  f.db.run("INSERT INTO channel_members (channel_id, user_id) VALUES (17, 1)");
  f.db.run("UPDATE telegram_dm_prompts SET expires_at = '2000-01-01'");
  await f.post("拒绝", reply);
  assert.equal(f.count(), 0);
  await f.select(17);
  const newer = { reply_to_message: { message_id: f.sent.at(-1).message_id } };
  await f.post("/cancel");
  await f.post("拒绝", newer);
  assert.equal(f.count(), 0);
  await f.select(17);
  f.db.run("UPDATE telegram_notification_users SET telegram_chat_id = '1001' WHERE user_id = 1");
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM telegram_dm_prompts").first()).count, 0);
  await f.select(17);
  f.db.run("DELETE FROM telegram_notification_users WHERE user_id = 1");
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM telegram_dm_prompts").first()).count, 0);
});

test("Telegram：旧提示不会发给新目标，重复选择不再生成未登记的提示，非文字不落库", async t => {
  const f = await fixture(t);
  await f.post("✉ 用户 2 [17]", { message_id: 50 });
  const prompt = f.sent.at(-1).message_id;
  const sentCount = f.sent.length;
  await f.post("✉ 用户 2 [17]", { message_id: 50 });
  assert.equal(f.sent.length, sentCount);
  await f.post("✉ 用户 2 [17]", { message_id: 51, reply_to_message: { message_id: prompt } });
  assert.equal(f.count(), 0);
  await f.post("过期回复", { reply_to_message: { message_id: prompt } });
  assert.equal(f.count(), 0);
  const current = await f.env.DB.prepare("SELECT prompt_message_id FROM telegram_dm_prompts").first();
  await f.post("", { reply_to_message: { message_id: current.prompt_message_id }, photo: [{ file_id: "test" }] });
  assert.equal(f.count(), 0);
});

test("Telegram：推送仅前8个Unicode字符和无凭据会话链接；删除/退群/拉黑/关闭偏好后不泄露正文", async t => {
  const f = await fixture(t);
  await f.select(17);
  await f.post("😀".repeat(1900), { reply_to_message: { message_id: f.sent.at(-1).message_id } });
  const outbox = await f.env.DB.prepare("SELECT id FROM telegram_notification_outbox WHERE user_id = 2").first();
  const args = { ids: [outbox.id], userId: 2, chatId: "1002", kind: "dm",
    webhookUrl: "https://chat.test/api/integrations/telegram/webhook?token=must-not-leak" };
  const notification = await buildTelegramNotification(f.env, args);
  assert.ok(notification.text.includes(`${"😀".repeat(8)}…`));
  assert.ok(!notification.text.includes("😀".repeat(9)));
  assert.match(notification.text, /https:\/\/chat\.test\/\?notificationRoomKind=dm&notificationRoomId=17/);
  assert.ok(!notification.text.includes("must-not-leak"));
  assert.ok(!notification.text.includes("/api/"));
  assert.ok(notification.text.length <= 4096);
  assert.match(notification.text, /打开 EdgeChat 查看/);
  assert.equal(await buildTelegramNotification(f.env, { ...args, chatId: "someone-else" }), null);
  f.db.run("UPDATE telegram_notification_users SET dm_enabled = 0 WHERE user_id = 2");
  assert.equal(await buildTelegramNotification(f.env, args), null);
  f.db.run("UPDATE telegram_notification_users SET dm_enabled = 1 WHERE user_id = 2");
  f.db.run("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (2, 1)");
  assert.equal(await buildTelegramNotification(f.env, args), null);
  f.db.run("DELETE FROM user_blocks");
  f.db.run("DELETE FROM channel_members WHERE channel_id = 17 AND user_id = 2");
  assert.equal(await buildTelegramNotification(f.env, args), null);
  f.db.run("INSERT INTO channel_members (channel_id, user_id) VALUES (17, 2)");
  f.db.run("UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE channel_id = 17");
  assert.equal(await buildTelegramNotification(f.env, args), null);
});

test("Telegram：群提及和附件只发短预览，不暴露正文尾部或附件名，非法站点不生成链接", async t => {
  const f = await fixture(t);
  f.db.run("INSERT INTO uploaded_files (object_key, owner_user_id) VALUES ('private-key', 1)");
  f.db.run("INSERT INTO messages (id, channel_id, sender_id, content, attachment_key, attachment_name) VALUES (101, 19, 1, ?, 'private-key', 'secret-filename.pdf')",
    ["一二三四五六七八绝不发送的秘密尾部"]);
  f.db.run("INSERT INTO telegram_notification_outbox (id, user_id, channel_id, message_id, kind, room_name) VALUES (201, 2, 19, 101, 'mention', 'Group')");
  const args = { ids: [201], userId: 2, chatId: "1002", kind: "mention", webhookUrl: "https://chat.test/webhook" };
  const notification = await buildTelegramNotification(f.env, args);
  assert.match(notification.text, /一二三四五六七八…/);
  assert.match(notification.text, /notificationRoomKind=public&notificationRoomId=19/);
  assert.match(notification.text, /有附件/);
  for (const secret of ["秘密尾部", "secret-filename", "private-key"]) assert.ok(!notification.text.includes(secret));
  for (const webhookUrl of ["", "invalid", "http://unsafe.test/webhook", "javascript:alert(1)"]) {
    const result = await buildTelegramNotification(f.env, { ...args, webhookUrl });
    assert.ok(!result.text.includes("https://"));
    assert.ok(!result.text.includes("unsafe.test"));
  }
  f.db.run("UPDATE messages SET content = '' WHERE id = 101");
  assert.match((await buildTelegramNotification(f.env, args)).text, /无文字内容/);
  f.db.run("UPDATE channels SET kind = 'private' WHERE id = 19");
  assert.match((await buildTelegramNotification(f.env, args)).text, /notificationRoomKind=private/);
});
