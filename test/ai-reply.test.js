import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import worker from "../worker/src/index.js";
import { createSession, hashPassword } from "../worker/src/auth.js";
import { ensureBenbenBot } from "../worker/src/data/distribution.js";
import { ensureDmChannel } from "../worker/src/data/dm-provisioning.js";
import { insertMessage, listMessages } from "../worker/src/data/messages.js";
import { getUserByUsername } from "../worker/src/data/users.js";
import { buildChatMessages } from "../worker/src/integrations/ai-reply/persona.js";
import { runAiReply } from "../worker/src/integrations/ai-reply/runner.js";
import {
  createAiReplyJob,
  getAiReplyConfig,
  resolveBenbenDm,
  updateAiReplyConfig,
  utcDayStart
} from "../worker/src/integrations/ai-reply/store.js";
import { createD1Adapter, createKvAdapter } from "./support/d1.js";

const SQL = await initSqlJs();
const schema = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../worker/migrations/2026-10-26-ai-reply.sql", import.meta.url),
  "utf8"
);

function encodedKey() {
  return Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");
}

const password = await hashPassword("test-password");

async function createEnv(overrides = {}) {
  const database = new SQL.Database();
  database.exec(schema);
  const env = {
    DB: createD1Adapter(database),
    SESSIONS: createKvAdapter(),
    EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({
      activeKeyId: "test-v1",
      keys: { "test-v1": encodedKey() }
    }),
    DASHSCOPE_API_KEY: "test-dashscope-key",
    ...overrides
  };
  return { database, env };
}

async function seedUser(env, username, { admin = false } = {}) {
  await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt, is_super_admin, management_protected)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(username, username, password.hash, password.salt, admin ? 1 : 0, admin ? 1 : 0)
    .run();
  return getUserByUsername(env.DB, username);
}

async function seedBenbenDm(env) {
  const user = await seedUser(env, "friend");
  const bot = await ensureBenbenBot(env.DB);
  const dm = await ensureDmChannel(env.DB, bot.id, user.id);
  return { user: { ...user, id: Number(user.id) }, bot: { ...bot, id: Number(bot.id) }, dm };
}

async function sendMessage(env, { channelId, senderId, content }) {
  return insertMessage(env, { channelId, senderId, content });
}

function replyFetch(content = "在的，我在听。") {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function failingFetch(status = 500) {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    return new Response(JSON.stringify({ error: { message: "mock failure" } }), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jobRows(database) {
  const result = database.exec("SELECT status, error, replied_message_id FROM ai_reply_jobs ORDER BY id");
  return result[0]
    ? result[0].values.map((row) => ({ status: row[0], error: row[1], repliedMessageId: row[2] }))
    : [];
}

function request(env, path, { method = "GET", body, token } = {}) {
  return worker.fetch(
    new Request(`https://ai-reply.test${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    env
  );
}

test("迁移：ai_reply_jobs 可重复执行且不动存量表", async () => {
  const database = new SQL.Database();
  const oldSchema = schema.replace(
    /\n-- 期一增项：文本回复链任务记录[\s\S]*?ON ai_reply_jobs\(status, created_at\);\n/,
    "\n"
  );
  database.exec(oldSchema);
  database.run(
    "INSERT INTO users (username, display_name, password_hash, password_salt) VALUES ('old', 'old', 'h', 's')"
  );
  database.exec(migration);
  database.exec(migration);
  database.run(
    `INSERT INTO ai_reply_jobs (channel_id, trigger_message_id, recipient_user_id) VALUES (1, 10, 2)`
  );
  const count = database.exec("SELECT COUNT(*) FROM ai_reply_jobs")[0].values[0][0];
  const users = database.exec("SELECT COUNT(*) FROM users")[0].values[0][0];
  assert.equal(Number(count), 1);
  assert.equal(Number(users), 1);
});

test("配置：默认开启、缺省限额 200、写入后可读回", async () => {
  const { env } = await createEnv();
  const initial = await getAiReplyConfig(env.DB, env);
  assert.equal(initial.enabled, true);
  assert.equal(initial.dailyLimit, 200);
  assert.equal(initial.model, "qwen-plus");
  assert.equal(initial.hasApiKey, true);

  await updateAiReplyConfig(env.DB, { enabled: false, dailyLimit: 5 });
  const updated = await getAiReplyConfig(env.DB, env);
  assert.equal(updated.enabled, false);
  assert.equal(updated.dailyLimit, 5);

  const noKey = await getAiReplyConfig(env.DB, { ...env, DASHSCOPE_API_KEY: "" });
  assert.equal(noKey.hasApiKey, false);
});

test("任务幂等：同一条消息只登记一次", async () => {
  const { database, env } = await createEnv();
  const first = await createAiReplyJob(env.DB, {
    channelId: 1,
    triggerMessageId: 99,
    recipientUserId: 2
  });
  const second = await createAiReplyJob(env.DB, {
    channelId: 1,
    triggerMessageId: 99,
    recipientUserId: 2
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(jobRows(database).length, 1);
});

test("DM 判定：只认「用户 + 笨笨」的一对一", async () => {
  const { env } = await createEnv();
  const { user, bot, dm } = await seedBenbenDm(env);
  const peer = await resolveBenbenDm(env.DB, dm.id, user.id);
  assert.equal(peer.botId, bot.id);
  assert.equal(peer.recipientUserId, user.id);
  assert.equal(await resolveBenbenDm(env.DB, dm.id, bot.id), null);

  const other = await seedUser(env, "other");
  const plainDm = await ensureDmChannel(env.DB, user.id, other.id);
  assert.equal(await resolveBenbenDm(env.DB, plainDm.id, user.id), null);

  const group = await env.DB.prepare(
    `INSERT INTO channels (name, kind, created_by) VALUES ('room', 'public', ?)`
  ).bind(user.id).run();
  assert.equal(await resolveBenbenDm(env.DB, group.meta.last_row_id, user.id), null);
});

test("上下文：笨笨消息为 assistant，纯附件消息跳过，条数受上限约束", () => {
  const history = [
    { content: "在吗", sender: { kind: "local", id: 7 } },
    { content: "   ", sender: { kind: "local", id: 7 } },
    { content: "在的", sender: { kind: "local", id: 3 } },
    { content: "今天有点累", sender: { kind: "local", id: 7 } }
  ];
  const messages = buildChatMessages({ history, botId: 3, maxMessages: 4 });
  assert.equal(messages[0].role, "system");
  assert.equal(messages.length, 4);
  assert.deepEqual(
    messages.slice(1).map((message) => message.role),
    ["user", "assistant", "user"]
  );
});

test("回复成功：以笨笨身份落库并记 done", async () => {
  const { database, env } = await createEnv();
  const { user, bot, dm } = await seedBenbenDm(env);
  const trigger = await sendMessage(env, { channelId: dm.id, senderId: user.id, content: "在吗" });
  const fetchImpl = replyFetch("在的，今天怎么样？");

  const result = await runAiReply({
    env,
    room: { id: dm.id, kind: "dm", name: dm.name },
    triggerMessage: trigger,
    providerFetch: fetchImpl,
    sleep: async () => {}
  });

  assert.equal(result.status, "done");
  const messages = await listMessages(env, dm.id, null, 30);
  const reply = messages[messages.length - 1];
  assert.equal(reply.content, "在的，今天怎么样？");
  assert.equal(reply.sender.id, bot.id);
  assert.equal(fetchImpl.calls.length, 1);
  const [job] = jobRows(database);
  assert.equal(job.status, "done");
  assert.equal(Number(job.repliedMessageId), reply.id);

  // 同一条触发消息重放：不重复回复
  const replay = await runAiReply({
    env,
    room: { id: dm.id, kind: "dm", name: dm.name },
    triggerMessage: trigger,
    providerFetch: replyFetch(),
    sleep: async () => {}
  });
  assert.equal(replay.status, "ignored");
  assert.equal(replay.reason, "duplicate");
  assert.equal((await listMessages(env, dm.id, null, 30)).length, 2);
});

test("闸门：开关关闭 / 缺 Key / 日限额满都记 skipped 且不回复", async () => {
  const { database, env } = await createEnv();
  const { user, dm } = await seedBenbenDm(env);
  const room = { id: dm.id, kind: "dm", name: dm.name };

  await updateAiReplyConfig(env.DB, { enabled: false });
  const disabled = await runAiReply({
    env,
    room,
    triggerMessage: await sendMessage(env, { channelId: dm.id, senderId: user.id, content: "一" }),
    providerFetch: replyFetch(),
    sleep: async () => {}
  });
  assert.equal(disabled.status, "skipped");
  assert.equal(disabled.reason, "disabled");

  await updateAiReplyConfig(env.DB, { enabled: true, dailyLimit: 1 });
  const noKey = await runAiReply({
    env: { ...env, DASHSCOPE_API_KEY: "" },
    room,
    triggerMessage: await sendMessage(env, { channelId: dm.id, senderId: user.id, content: "二" }),
    providerFetch: replyFetch(),
    sleep: async () => {}
  });
  assert.equal(noKey.reason, "missing_api_key");

  const first = await runAiReply({
    env,
    room,
    triggerMessage: await sendMessage(env, { channelId: dm.id, senderId: user.id, content: "三" }),
    providerFetch: replyFetch(),
    sleep: async () => {}
  });
  assert.equal(first.status, "done");
  const second = await runAiReply({
    env,
    room,
    triggerMessage: await sendMessage(env, { channelId: dm.id, senderId: user.id, content: "四" }),
    providerFetch: replyFetch(),
    sleep: async () => {}
  });
  assert.equal(second.reason, "daily_limit");
  assert.equal(jobRows(database).filter((job) => job.status === "done").length, 1);
});

test("失败降级：模型两次失败记 failed、不向用户发消息", async () => {
  const { database, env } = await createEnv();
  const { user, dm } = await seedBenbenDm(env);
  const fetchImpl = failingFetch(503);
  const result = await runAiReply({
    env,
    room: { id: dm.id, kind: "dm", name: dm.name },
    triggerMessage: await sendMessage(env, { channelId: dm.id, senderId: user.id, content: "在吗" }),
    providerFetch: fetchImpl,
    sleep: async () => {}
  });
  assert.equal(result.status, "failed");
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal((await listMessages(env, dm.id, null, 30)).length, 1);
  const [job] = jobRows(database);
  assert.equal(job.status, "failed");
  assert.match(String(job.error), /http_503/);
});

test("范围：普通用户 DM 与群聊不触发", async () => {
  const { env } = await createEnv();
  const userA = await seedUser(env, "a");
  const userB = await seedUser(env, "b");
  const plainDm = await ensureDmChannel(env.DB, userA.id, userB.id);
  const dmResult = await runAiReply({
    env,
    room: { id: plainDm.id, kind: "dm", name: plainDm.name },
    triggerMessage: await sendMessage(env, { channelId: plainDm.id, senderId: userA.id, content: "嗨" }),
    providerFetch: replyFetch(),
    sleep: async () => {}
  });
  assert.equal(dmResult.status, "ignored");

  const group = await env.DB.prepare(
    `INSERT INTO channels (name, kind, created_by) VALUES ('g', 'public', ?)`
  ).bind(userA.id).run();
  const groupResult = await runAiReply({
    env,
    room: { id: group.meta.last_row_id, kind: "public", name: "g" },
    triggerMessage: {
      id: 1,
      sender: { kind: "local", id: userA.id },
      content: "嗨"
    },
    providerFetch: replyFetch(),
    sleep: async () => {}
  });
  assert.equal(groupResult.status, "ignored");
});

test("后台接口：管理员可读写，普通用户 403，响应不含 key", async () => {
  const { env } = await createEnv();
  const admin = await seedUser(env, "root", { admin: true });
  const normal = await seedUser(env, "normal");
  const adminSession = await createSession(env, admin);
  const normalSession = await createSession(env, normal);

  const read = await request(env, "/api/admin/ai-reply/config", { token: adminSession.token });
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.enabled, true);
  assert.equal(body.hasApiKey, true);
  const text = JSON.stringify(body);
  assert.equal(text.includes("test-dashscope-key"), false);
  assert.equal(Object.keys(body).includes("apiKey"), false);

  const write = await request(env, "/api/admin/ai-reply/config", {
    method: "PUT",
    token: adminSession.token,
    body: { enabled: false, dailyLimit: 3 }
  });
  assert.equal(write.status, 200);
  const written = await write.json();
  assert.equal(written.enabled, false);
  assert.equal(written.dailyLimit, 3);

  const invalid = await request(env, "/api/admin/ai-reply/config", {
    method: "PUT",
    token: adminSession.token,
    body: { dailyLimit: 6000 }
  });
  assert.equal(invalid.status, 400);

  const forbidden = await request(env, "/api/admin/ai-reply/config", {
    token: normalSession.token
  });
  assert.equal(forbidden.status, 403);

  const stats = await request(env, "/api/admin/ai-reply/stats?days=7", {
    token: adminSession.token
  });
  assert.equal(stats.status, 200);
  assert.ok(Array.isArray((await stats.json()).rows));
});

test("时间口径：utcDayStart 为当日零点字符串", () => {
  assert.equal(utcDayStart(new Date("2026-10-26T15:30:00Z")), "2026-10-26 00:00:00");
});
