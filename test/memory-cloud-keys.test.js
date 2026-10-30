import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import worker from "../worker/src/index.js";
import { createSession, hashPassword } from "../worker/src/auth.js";
import { getUserByUsername } from "../worker/src/data/users.js";
import {
  getMemoryAccount,
  markMemoryAccountFailed,
  memoryDeviceId,
  saveMemoryAccount
} from "../worker/src/integrations/memory/accounts.js";
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

function jsonResponse(status, payload) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(payload) };
}

function get(env, session, path) {
  return worker.fetch(
    new Request(`https://memory.test${path}`, {
      headers: { Authorization: `Bearer ${session.token}` }
    }),
    env,
    { waitUntil: () => {} }
  );
}

function post(env, session, path, body) {
  return worker.fetch(
    new Request(`https://memory.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body)
    }),
    env,
    { waitUntil: () => {} }
  );
}

test("记忆状态：无台账=未开可自愈，有台账=已开，且响应不含令牌", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "state-user");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("状态接口不应触发任何代调");
  });

  const before = await get(env, session, "/api/v1/memory/status");
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { memoried: false, status: "none", retryable: true });

  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_state_secret",
    deviceId: memoryDeviceId(user.id)
  });
  const after = await get(env, session, "/api/v1/memory/status");
  assert.equal(after.status, 200);
  const body = await after.json();
  assert.deepEqual(body, { memoried: true, status: "active", retryable: false });
  assert.equal(JSON.stringify(body).includes("sagk_state_secret"), false);

  const anonymous = await worker.fetch(new Request("https://memory.test/api/v1/memory/status"), env);
  assert.equal(anonymous.status, 401);
});

test("开场摘要：有令牌时由服务端代调 /pi 并只透传 prompt", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "opening-user");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_opening",
    deviceId: memoryDeviceId(user.id)
  });

  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {} });
    return jsonResponse(200, { available: true, session_recap_prompt: "【上次对话摘要】她说幼儿园报名" });
  });

  const res = await get(env, session, "/api/v1/memory/session/opening");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.prompt.includes("幼儿园报名"), true);
  assert.equal(JSON.stringify(body).includes("sagk_opening"), false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sag.lanxingbei.cn/pi/api/session/opening");
  assert.equal(calls[0].headers["X-SAG-Token"], "sagk_opening");
});

test("开场摘要：/pi 说没有摘要时回 200 + available=false，不报错", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "opening-empty");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_empty",
    deviceId: memoryDeviceId(user.id)
  });
  t.mock.method(globalThis, "fetch", async () => jsonResponse(200, { available: false, reason: "none" }));

  const res = await get(env, session, "/api/v1/memory/session/opening");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(body.prompt, "");
});

test("懒补开：建号钩子没跑成时，开场接口自行开户并立即可用", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "lazy-open");
  const session = await createSession(env, { ...user, id: Number(user.id) });

  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    urls.push(String(url));
    if (String(url).includes("trial-register")) {
      assert.equal(JSON.parse(init.body).device_id, memoryDeviceId(user.id));
      return jsonResponse(200, {
        format: "vflow-client-config",
        customer_id: "CUST-LAZY",
        config: { sag_api_token: "sagk_lazy", customer_id: "CUST-LAZY" }
      });
    }
    return jsonResponse(200, { available: true, session_recap_prompt: "补开之后拿到的摘要" });
  });

  const res = await get(env, session, "/api/v1/memory/session/opening");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.prompt, "补开之后拿到的摘要");

  const account = await getMemoryAccount(env.DB, user.id);
  assert.equal(account.status, "active");
  assert.equal(account.customer_id, "CUST-LAZY");
  assert.equal(urls.some((u) => u.includes("trial-register")), true);
  assert.equal(urls.some((u) => u.endsWith("/pi/api/session/opening")), true);
});

test("懒补开失败：回 200 + available=false，状态落成 failed 且 10 分钟内不再重试", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "lazy-fail");
  const session = await createSession(env, { ...user, id: Number(user.id) });

  let trialCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("trial-register")) {
      trialCalls += 1;
      return jsonResponse(503, { error: "unavailable" });
    }
    return jsonResponse(500, {});
  });

  const first = await get(env, session, "/api/v1/memory/session/opening");
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.available, false);
  assert.equal(firstBody.reason, "failed");
  assert.equal(trialCalls, 1);

  const account = await getMemoryAccount(env.DB, user.id);
  assert.equal(account.status, "failed");

  // 10 分钟冷却内再开一次：不许再打一次会白等 15 秒的开户请求
  const second = await get(env, session, "/api/v1/memory/session/opening");
  assert.equal(second.status, 200);
  assert.equal((await second.json()).available, false);
  assert.equal(trialCalls, 1);
});

test("语音会话结束：服务端代报 /pi，一律 202；无令牌时回 no_token 且不代调", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "voice-report");
  const session = await createSession(env, { ...user, id: Number(user.id) });

  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return jsonResponse(202, { ok: true, accepted: true });
  });

  // 还没开户：不代调，直接 202
  const none = await post(env, session, "/api/v1/memory/voice-session/ended", { sessionId: "chatvoice_1", endedAt: 1793095432000 });
  assert.equal(none.status, 202);
  assert.equal((await none.json()).status, "no_token");
  assert.equal(calls.length, 0);

  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_voice",
    deviceId: memoryDeviceId(user.id)
  });

  const ok = await post(env, session, "/api/v1/memory/voice-session/ended", {
    sessionId: "chatvoice_1793095432000",
    startedAt: 1793095232000,
    endedAt: 1793095432000,
    turnCount: 3,
    lastUserText: "我今天有点累"
  });
  assert.equal(ok.status, 202);
  const okBody = await ok.json();
  assert.equal(okBody.status, "reported");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sag.lanxingbei.cn/pi/api/session/ended");
  assert.equal(calls[0].headers["X-SAG-Token"], "sagk_voice");
  assert.equal(calls[0].body.session_id, "chatvoice_1793095432000");
  assert.equal(calls[0].body.turn_count, 3);

  // /pi 拒绝（例如每日 3 次额度用光）时仍然 202，只把状态写进响应体
  t.mock.method(globalThis, "fetch", async () => jsonResponse(429, { error: "daily_limit" }));
  const limited = await post(env, session, "/api/v1/memory/voice-session/ended", {
    sessionId: "chatvoice_2",
    endedAt: 1793095532000
  });
  assert.equal(limited.status, 202);
  assert.equal((await limited.json()).status, "http_429");
});

test("台账 failed 且刚失败过：开场接口不重试，直接回未开", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "cooldown");
  const session = await createSession(env, { ...user, id: Number(user.id) });
  await markMemoryAccountFailed(env.DB, user.id, "http_503");

  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(500, {});
  });

  const res = await get(env, session, "/api/v1/memory/session/opening");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(body.reason, "failed");
  assert.equal(calls, 0);
});
test("记忆库查询：服务端代调 V2 并透传 zhengju_bao_v2，端上不再手填令牌", async (t) => {
  const { env } = await createEnv();
  const user = await seedUser(env, "query-user");
  const session = await createSession(env, { ...user, id: Number(user.id) });

  // 还未开户：不代调，回 200 + available=false（端上显示"记忆还没开"）
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(503, {});
  });
  const notOpen = await get(env, session, "/api/v1/memory/query?q=%E7%8E%89%E7%9F%B3");
  assert.equal(notOpen.status, 200);
  const notOpenBody = await notOpen.json();
  assert.equal(notOpenBody.available, false);

  // 开户后再查：带 Bearer 打 V2，响应原样透传
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_query",
    deviceId: memoryDeviceId(user.id)
  });
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization || "" });
    return jsonResponse(200, {
      zhengju_bao_v2: [{ title: "喜欢玉石", detail: "她说过喜欢和田玉", confidence: 0.9, fact_id: 7 }],
      sheng_lve: 0
    });
  });
  const res = await get(env, session, "/api/v1/memory/query?q=%E7%8E%89%E7%9F%B3");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.zhengju_bao_v2[0].title, "喜欢玉石");
  assert.equal(JSON.stringify(body).includes("sagk_query"), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, "Bearer sagk_query");
  assert.equal(seen[0].url.includes("q="), true);
});
