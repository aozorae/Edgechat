import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import worker from "../worker/src/index.js";
import { createSession, hashPassword } from "../worker/src/auth.js";
import { getUserByUsername } from "../worker/src/data/users.js";
import { memoryDeviceId, saveMemoryAccount } from "../worker/src/integrations/memory/accounts.js";
import { createD1Adapter, createKvAdapter } from "./support/d1.js";

const SQL = await initSqlJs();
const schema = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");
const password = await hashPassword("test-password");

function encodedKey() {
  return Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");
}

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

async function seedUser(env, username) {
  await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)`
  )
    .bind(username, username, password.hash, password.salt)
    .run();
  return getUserByUsername(env.DB, username);
}

function sampleEvents(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    type: "notification",
    content: `工资到账 ${index}`,
    ts: 1761888000000 + index * 1000,
    meta: { package: "com.demo.app", title: "通知" }
  }));
}

async function callIngest(env, token, body) {
  return worker.fetch(
    new Request("https://memory.test/api/v1/memory/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    }),
    env,
    { waitUntil: () => {} }
  );
}

function captureFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init?.body || "{}")) });
    return reply;
  };
  return { calls, impl };
}

const okReply = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, accepted: 2 }) };

test("路由级：/api/v1/memory/ingest 无 Bearer → 401，且不打上游", async (t) => {
  const { env } = await createEnv();
  let called = 0;
  t.mock.method(globalThis, "fetch", async () => {
    called += 1;
    return okReply;
  });
  const res = await worker.fetch(
    new Request("https://memory.test/api/v1/memory/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: sampleEvents(1) })
    }),
    env,
    { waitUntil: () => {} }
  );
  assert.equal(res.status, 401);
  assert.equal(called, 0);
});

test("路由级：成功代报——URL/请求头/请求体/响应体口径", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u1");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_test_token_ingest",
    deviceId: memoryDeviceId(user.id)
  });

  const { calls, impl } = captureFetch(okReply);
  t.mock.method(globalThis, "fetch", impl);

  const res = await callIngest(env, session.token, { events: sampleEvents(2) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 2);
  assert.equal(body.skipped, 0);
  assert.match(body.batchId, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(body).includes("sagk_test_token_ingest"), false);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/pi\/ingest$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-SAG-Token"], "sagk_test_token_ingest");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.match(calls[0].body.batch_id, /^[0-9a-f]{32}$/);
  assert.equal(calls[0].body.events.length, 2);
  assert.match(calls[0].body.events[0].event_id, /^[0-9a-f]{32}$/);
  assert.equal(calls[0].body.events[0].type, "notification");
  assert.equal(calls[0].body.events[0].content, "工资到账 0");
  assert.equal(calls[0].body.events[0].ts, 1761888000000);
  assert.equal(calls[0].body.events[0].meta.package, "com.demo.app");
  // 这条链路只收文字：请求体里不出现任何音频字段
  assert.equal(JSON.stringify(calls[0].body).includes("audio"), false);
});

test("幂等：同一批离线补发两次 → batch_id/event_id 完全一致（不重）；内容变了才换键", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u2");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_t2",
    deviceId: memoryDeviceId(user.id)
  });

  const { calls, impl } = captureFetch(okReply);
  t.mock.method(globalThis, "fetch", impl);

  const first = sampleEvents(2);
  await callIngest(env, session.token, { events: first });
  // 重发时 meta 键顺序被打乱（模拟端上重新序列化），键必须仍然稳定
  const replay = first.map((event) => ({
    ts: event.ts,
    meta: { title: event.meta.title, package: event.meta.package },
    content: `  ${event.content}  `,
    type: event.type
  }));
  await callIngest(env, session.token, { events: replay });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.batch_id, calls[0].body.batch_id);
  assert.deepEqual(
    calls[1].body.events.map((event) => event.event_id),
    calls[0].body.events.map((event) => event.event_id)
  );

  const changed = sampleEvents(2);
  changed[0].content = "工资到账 0（改过）";
  await callIngest(env, session.token, { events: changed });
  assert.notEqual(calls[2].body.events[0].event_id, calls[0].body.events[0].event_id);
});

test("批内重复：同一条事件塞两次 → 只发一条、skipped 记 1（不重）", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u3");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_t3",
    deviceId: memoryDeviceId(user.id)
  });

  const { calls, impl } = captureFetch({ ok: true, status: 200, text: async () => JSON.stringify({ accepted: 1 }) });
  t.mock.method(globalThis, "fetch", impl);

  const one = sampleEvents(1)[0];
  const res = await callIngest(env, session.token, { events: [one, { ...one }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 1);
  assert.equal(body.skipped, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.events.length, 1);
});

test("端上自带 eventId/batchId → 原样透传（不重算）", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u4");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_t4",
    deviceId: memoryDeviceId(user.id)
  });

  const { calls, impl } = captureFetch(okReply);
  t.mock.method(globalThis, "fetch", impl);

  const res = await callIngest(env, session.token, {
    batchId: "batch-20261031-0001",
    events: [{ eventId: "evt-0001", type: "location_sample", content: "公司在 3 楼", ts: 1761888000000, meta: {} }]
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).batchId, "batch-20261031-0001");
  assert.equal(calls[0].body.batch_id, "batch-20261031-0001");
  assert.equal(calls[0].body.events[0].event_id, "evt-0001");
});

test("400 口径：超 50 条 / 非文字 content / 非法 type / 缺 ts / 非法 eventId 一律不落上游", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u5");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_t5",
    deviceId: memoryDeviceId(user.id)
  });

  let called = 0;
  t.mock.method(globalThis, "fetch", async () => {
    called += 1;
    return okReply;
  });

  const tooMany = await callIngest(env, session.token, { events: sampleEvents(51) });
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).error, "events 单批最多 50 条，请端上拆批");

  const audio = await callIngest(env, session.token, {
    events: [{ type: "notification", content: { audio: "base64" }, ts: 1761888000000 }]
  });
  assert.equal(audio.status, 400);
  assert.equal((await audio.json()).error, "content 只收文字（字符串）");

  const badType = await callIngest(env, session.token, {
    events: [{ type: "call_log", content: "打了 3 分钟", ts: 1761888000000 }]
  });
  assert.equal(badType.status, 400);

  const noTs = await callIngest(env, session.token, {
    events: [{ type: "app_session", content: "用了 10 分钟" }]
  });
  assert.equal(noTs.status, 400);
  assert.equal((await noTs.json()).error, "ts 必须是毫秒时间戳");

  const empty = await callIngest(env, session.token, { events: [] });
  assert.equal(empty.status, 400);

  const badId = await callIngest(env, session.token, {
    events: [{ eventId: "带空格 的 id", type: "outgoing", content: "打了电话", ts: 1761888000000 }]
  });
  assert.equal(badId.status, 400);
  assert.equal(called, 0);
});

test("SAG 失败 → 502 {ok:false,reason}（端上据非 2xx 补发）；无台账同 502 且不回令牌", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u6");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_t6_secret",
    deviceId: memoryDeviceId(user.id)
  });

  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ error: "ingest disabled" })
  }));
  const failed = await callIngest(env, session.token, { events: sampleEvents(1) });
  assert.equal(failed.status, 502);
  const failedBody = await failed.json();
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.reason, "http_503");
  assert.equal(JSON.stringify(failedBody).includes("sagk_t6_secret"), false);

  // 未开户的普通用户：不落库、不报错、也不放行
  const stranger = await seedUser(env, "u7");
  const strangerSession = await createSession(env, { ...stranger, id: Number(stranger.id) });
  const noToken = await callIngest(env, strangerSession.token, { events: sampleEvents(1) });
  assert.equal(noToken.status, 502);
  const noTokenBody = await noToken.json();
  assert.equal(noTokenBody.ok, false);
  assert.equal(noTokenBody.reason, "none");
});

test("注册顺序：新路由不被 v1 legacy 兜底吞掉（与 text-session/ended 同一条注册链）", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u8");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_t8",
    deviceId: memoryDeviceId(user.id)
  });
  t.mock.method(globalThis, "fetch", async () => okReply);
  const res = await callIngest(env, session.token, { events: sampleEvents(1) });
  assert.notEqual(res.status, 404);
  assert.equal(res.status, 200);
});