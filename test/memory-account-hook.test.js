import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import worker from "../worker/src/index.js";
import { hashPassword } from "../worker/src/auth.js";
import { getUserByUsername } from "../worker/src/data/users.js";
import { getMemoryAccount, memoryDeviceId } from "../worker/src/integrations/memory/accounts.js";
import { ensureMemoryAccount, TRIAL_REGISTER_TIMEOUT_MS } from "../worker/src/integrations/memory/trial-register.js";
import { createD1Adapter, createKvAdapter } from "./support/d1.js";

/**
 * TASK-133 建号钩子（distribution auto-register → ensureMemoryAccount）验收单测。
 * 这三条补的是 E1 的真实缺口：E1 的原始输出是"本机 Node 同请求体直连 + d1 execute 写台账"，
 * 建号钩子这条 worker 代码路径当时没被真实跑到（见 TASK-133\E1E2E3-原始输出-20261026.txt）。
 */

const SQL = await initSqlJs();
const schema = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");
const password = await hashPassword("test-password");

const TEST_URL = "https://sag.invalid/api/trial-register";

function encodedKey() {
  return Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");
}

async function createEnv() {
  const database = new SQL.Database();
  database.exec(schema);
  const env = {
    DB: createD1Adapter(database),
    SESSIONS: createKvAdapter(),
    EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({
      activeKeyId: "test-v1",
      keys: { "test-v1": encodedKey() }
    }),
    MEMORY_TRIAL_REGISTER_URL: TEST_URL
  };
  return { database, env };
}

async function seedAdminAndInvite(env, token) {
  await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt, is_super_admin, management_protected)
     VALUES ('root', 'root', ?, ?, 1, 1)`
  )
    .bind(password.hash, password.salt)
    .run();
  const admin = await getUserByUsername(env.DB, "root");
  await env.DB.prepare(
    `INSERT INTO registration_invites (token, note, max_uses, created_by) VALUES (?, 'hook-test', 1, ?)`
  )
    .bind(token, admin.id)
    .run();
  return admin;
}

async function seedUser(env, username) {
  await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)`
  )
    .bind(username, username, password.hash, password.salt)
    .run();
  return getUserByUsername(env.DB, username);
}

/** 与生产 trial-register 同构的响应体（令牌是假的，只验落库/请求形态）。 */
function trialResponse(customerId = "CUST-T0777") {
  const payload = {
    format: "vflow-client-config",
    customer_id: customerId,
    trial: { status: "trial", turns_limit: 30, turns_used: 0, expires_at: 1793193207 },
    config: {
      sag_api_token: "sagk_hook_test_token",
      sag_base_url: "https://sag.invalid",
      customer_id: customerId
    }
  };
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function registerRequest(env, { token, installationId, executionCtx }) {
  return worker.fetch(
    new Request("https://hook.test/api/v1/distribution/auto-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, installationId, deviceName: "hook-test" })
    }),
    env,
    executionCtx
  );
}

test("建号钩子：auto-register 真发 trial-register POST（device_id=63686174-<userId 8位hex>），台账 active", async (t) => {
  const { env } = await createEnv();
  await seedAdminAndInvite(env, "hook-token-1");
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body, contentType: init?.headers?.["Content-Type"] });
    return trialResponse("CUST-T0777");
  });

  const pending = [];
  const res = await registerRequest(env, {
    token: "hook-token-1",
    installationId: "install-hook-a",
    executionCtx: { waitUntil: (p) => pending.push(p) }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, true);
  assert.ok(body.accessToken);
  await Promise.allSettled(pending);

  // ① 钩子确实发出了 POST（不是靠本机脚本代写台账）
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TEST_URL);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].contentType, "application/json");
  assert.deepEqual(JSON.parse(calls[0].body), { device_id: memoryDeviceId(body.user.id) });
  // ② device_id 格式定死：63686174-<userId 8 位十六进制小写>
  assert.equal(memoryDeviceId(body.user.id), `63686174-${Number(body.user.id).toString(16).padStart(8, "0")}`);
  assert.equal(memoryDeviceId(body.user.id), "63686174-00000002"); // root=1，首聊用户 id=2
  // ③ 台账 active，令牌密文落库（响应不回显明文）
  const account = await getMemoryAccount(env.DB, body.user.id);
  assert.equal(account.status, "active");
  assert.equal(account.customer_id, "CUST-T0777");
  assert.equal(account.device_id, memoryDeviceId(body.user.id));
  assert.ok(account.sag_token_cipher && account.sag_token_cipher.length > 20);
  assert.equal(String(account.sag_token_cipher).includes("sagk_hook_test_token"), false);
});

test("开户超时：15s 触发 abort → 台账标 failed(timeout)，不阻塞建号（不传 ctx 时也不预开）", async (t) => {
  // 门一：超时常量就是一个确定值 15s（源码可断言）
  assert.equal(TRIAL_REGISTER_TIMEOUT_MS, 15000);

  const { env } = await createEnv();
  const user = await seedUser(env, "u-timeout");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  const pending = ensureMemoryAccount(env, Number(user.id), { fetchImpl });
  await new Promise((resolve) => setImmediate(resolve)); // 等 getMemoryAccount 完成、setTimeout 注册
  t.mock.timers.tick(14999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, false, "14.999s 时不应 abort（超时必须满 15s）");

  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(aborted, true, "满 15s 必须 abort 请求");
  assert.equal(result, null);
  const account = await getMemoryAccount(env.DB, user.id);
  assert.equal(account.status, "failed");
  assert.equal(account.last_error, "timeout");
});

test("开户失败不影响建号响应：网络错误 → 台账 failed，但建号仍 200 且拿到可用会话", async (t) => {
  const { env } = await createEnv();
  await seedAdminAndInvite(env, "hook-token-2");
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });

  const pending = [];
  const res = await registerRequest(env, {
    token: "hook-token-2",
    installationId: "install-hook-b",
    executionCtx: { waitUntil: (p) => pending.push(p) }
  });
  // 建号响应不受记忆开户失败影响
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, true);
  assert.ok(body.accessToken);
  assert.ok(body.refreshToken);
  assert.equal(body.initialRoom.kind, "dm");

  await Promise.allSettled(pending);
  const account = await getMemoryAccount(env.DB, body.user.id);
  assert.equal(account.status, "failed");
  assert.match(String(account.last_error), /network down/);
  // 台账 failed 时读令牌返回 null（上层降级为无记忆，不报错）
  const deviceId = memoryDeviceId(body.user.id);
  assert.equal(account.device_id, deviceId);
});
