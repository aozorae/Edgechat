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
import {
  getMemoryAccount,
  getTextSessionReport,
  memoryDeviceId,
  readMemoryToken,
  saveMemoryAccount
} from "../worker/src/integrations/memory/accounts.js";
import { fetchSessionOpening, reportSessionEnded } from "../worker/src/integrations/memory/pi-client.js";
import { ensureMemoryAccount } from "../worker/src/integrations/memory/trial-register.js";
import { retryFailedReports, settleTextSession, sessionIdFor } from "../worker/src/integrations/memory/text-session.js";
import { runAiReply } from "../worker/src/integrations/ai-reply/runner.js";
import { buildChatMessages } from "../worker/src/integrations/ai-reply/persona.js";
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

async function seedBenbenDm(env) {
  const user = await seedUser(env, "friend");
  const bot = await ensureBenbenBot(env.DB);
  const dm = await ensureDmChannel(env.DB, bot.id, user.id);
  return { user: { ...user, id: Number(user.id) }, bot: { ...bot, id: Number(bot.id) }, dm };
}

function trialResponse(deviceId, customerId = "CUST-T0042") {
  const payload = {
    format: "vflow-client-config",
    customer_id: customerId,
    trial: { status: "trial", turns_limit: 30, turns_used: 0, expires_at: 1 },
    config: { sag_api_token: "sagk_test_token_12345", sag_base_url: "https://example.invalid", customer_id: customerId }
  };
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

test("device_id：chat 的 ASCII hex + 8 位用户号", () => {
  assert.equal(memoryDeviceId(8), "63686174-00000008");
  assert.equal(memoryDeviceId(255), "63686174-000000ff");
  assert.match(memoryDeviceId(8), /^[0-9a-fA-F-]{8,64}$/);
  assert.throws(() => memoryDeviceId(0));
});

test("台账：令牌加密落库、可解密读回、密文不含明文", async () => {
  const { database, env } = await createEnv();
  const user = await seedUser(env, "u1");
  await saveMemoryAccount(env, user.id, {
    customerId: "CUST-T0042",
    token: "sagk_super_secret_token",
    deviceId: memoryDeviceId(user.id)
  });
  const account = await getMemoryAccount(env.DB, user.id);
  assert.equal(account.status, "active");
  assert.equal(account.customer_id, "CUST-T0042");
  assert.ok(account.sag_token_cipher && account.sag_token_cipher.length > 20);
  assert.equal(account.sag_token_cipher.includes("sagk_super_secret_token"), false);

  const decrypted = await readMemoryToken(env, user.id);
  assert.equal(decrypted.token, "sagk_super_secret_token");
  assert.equal(decrypted.customerId, "CUST-T0042");
  assert.equal(database.exec("SELECT COUNT(*) FROM user_memory_accounts")[0].values[0][0], 1);
});

test("开户：调 trial-register 幂等，已有 active 台账不再请求", async () => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u2");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return trialResponse(memoryDeviceId(user.id));
  };
  const first = await ensureMemoryAccount(env, user.id, { fetchImpl });
  assert.equal(first.status, "active");
  assert.equal(calls, 1);

  const second = await ensureMemoryAccount(env, user.id, { fetchImpl });
  assert.equal(second.status, "active");
  assert.equal(calls, 1); // 已有 active 台账，不重复打接口
});

test("开户失败：标记 failed，回复链仍可走（无台账降级）", async () => {
  const { env } = await createEnv();
  const user = await seedUser(env, "u3");
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "device_id 无效" }), text: async () => "{}" });
  const result = await ensureMemoryAccount(env, user.id, { fetchImpl });
  assert.equal(result, null);
  const account = await getMemoryAccount(env.DB, user.id);
  assert.equal(account.status, "failed");
  assert.match(String(account.last_error), /400/);
  assert.equal(await readMemoryToken(env, user.id), null);
});

test("记忆接口客户端：opening 两态 + ended 状态码", async () => {
  const { env } = await createEnv();
  const openingOk = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ available: true, session_recap_prompt: "上次聊了面试" })
  });
  const okResult = await fetchSessionOpening(env, "sagk_x", { fetchImpl: openingOk });
  assert.equal(okResult.available, true);
  assert.equal(okResult.prompt, "上次聊了面试");

  const openingNone = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ available: false, session_recap_prompt: "", reason: "none" })
  });
  const noneResult = await fetchSessionOpening(env, "sagk_x", { fetchImpl: openingNone });
  assert.equal(noneResult.available, false);

  const ended = async () => ({ status: 202, text: async () => JSON.stringify({ ok: true }) });
  const status = await reportSessionEnded(env, "sagk_x", { sessionId: "s1", endedAt: Date.now() }, { fetchImpl: ended });
  assert.equal(status, 202);
});

test("文本会话结算：幂等、无台账降级、202 记录", async () => {
  const { database, env } = await createEnv();
  const { user, dm } = await seedBenbenDm(env);
  const message = await insertMessage(env, { channelId: dm.id, senderId: user.id, content: "在吗" });

  // 无台账 → no_account，不写结算记录
  const noAccount = await settleTextSession(env, {
    roomId: dm.id,
    userId: user.id,
    lastMessageId: message.id,
    fetchImpl: async () => ({ status: 202 })
  });
  assert.equal(noAccount.status, "no_account");

  // 开户后 → reported
  await saveMemoryAccount(env, user.id, { customerId: "CUST-T0042", token: "sagk_t", deviceId: memoryDeviceId(user.id) });
  let piCalls = 0;
  const piFetch = async () => {
    piCalls += 1;
    return { status: 202, text: async () => JSON.stringify({ ok: true }) };
  };
  const first = await settleTextSession(env, {
    roomId: dm.id,
    userId: user.id,
    lastMessageId: message.id,
    fetchImpl: piFetch
  });
  assert.equal(first.status, "reported");
  assert.equal(first.piStatus, 202);

  // 同 room+lastMessageId 再结算 → duplicate，且不再调 /pi
  const second = await settleTextSession(env, {
    roomId: dm.id,
    userId: user.id,
    lastMessageId: message.id,
    fetchImpl: piFetch
  });
  assert.equal(second.status, "duplicate");
  assert.equal(piCalls, 1);
  const report = await getTextSessionReport(env.DB, dm.id, message.id);
  assert.equal(Number(report.pi_status), 202);
  assert.equal(database.exec("SELECT COUNT(*) FROM text_session_reports")[0].values[0][0], 1);
});

test("T7：pi 非 2xx 不永久丢摘要——cron 重试成功", async () => {
  const { env } = await createEnv();
  const { user, dm } = await seedBenbenDm(env);
  await saveMemoryAccount(env, user.id, { customerId: "CUST-T0042", token: "sagk_t", deviceId: memoryDeviceId(user.id) });
  const message = await insertMessage(env, { channelId: dm.id, senderId: user.id, content: "在吗" });

  let call = 0;
  const piFetch = async () => {
    call += 1;
    return call === 1
      ? { status: 503, text: async () => JSON.stringify({ error: "disabled" }) }
      : { status: 202, text: async () => JSON.stringify({ ok: true, accepted: true }) };
  };
  const first = await settleTextSession(env, {
    roomId: dm.id,
    userId: user.id,
    lastMessageId: message.id,
    fetchImpl: piFetch
  });
  assert.equal(first.status, "pi_failed");
  const failed = await getTextSessionReport(env.DB, dm.id, message.id);
  assert.equal(failed.status, "failed");
  assert.equal(Number(failed.pi_status), 503);
  assert.ok(Number(failed.attempts) >= 1);

  // 模拟时间过去：把 last_attempt_at 拨到 10 分钟前，cron 才能拾取
  await env.DB
    .prepare(`UPDATE text_session_reports SET last_attempt_at = datetime('now', '-10 minutes') WHERE room_id = ? AND last_message_id = ?`)
    .bind(dm.id, message.id)
    .run();
  const retry = await retryFailedReports(env, { fetchImpl: piFetch });
  assert.equal(retry.retried, 1);
  assert.equal(retry.recovered, 1);
  const reported = await getTextSessionReport(env.DB, dm.id, message.id);
  assert.equal(reported.status, "reported");
  assert.equal(Number(reported.pi_status), 202);
});

test("T8：session_id 语义唯一（chat_dm_<roomId>_<lastMessageId>）且落库一致", async () => {
  const { env } = await createEnv();
  const { user, dm } = await seedBenbenDm(env);
  await saveMemoryAccount(env, user.id, { customerId: "CUST-T0042", token: "sagk_t", deviceId: memoryDeviceId(user.id) });
  const message = await insertMessage(env, { channelId: dm.id, senderId: user.id, content: "在吗" });
  const expected = `chat_dm_${dm.id}_${message.id}`;
  assert.equal(sessionIdFor(dm.id, message.id), expected);

  await settleTextSession(env, {
    roomId: dm.id,
    userId: user.id,
    lastMessageId: message.id,
    fetchImpl: async () => ({ status: 202, text: async () => "{}" })
  });
  const report = await getTextSessionReport(env.DB, dm.id, message.id);
  assert.equal(report.session_id, expected);
});

test("ai-reply 注入：有摘要注入 system prompt，无摘要严格等于纯人设", async () => {
  const plain = buildChatMessages({ history: [], botId: 1 });
  assert.equal(plain[0].content.includes("上次聊天的摘要"), false);

  const withRecap = buildChatMessages({ history: [], botId: 1, recapPrompt: "上次聊了面试很难过" });
  assert.equal(withRecap[0].content.includes("上次聊了面试很难过"), true);
  assert.equal(withRecap[0].content.includes("不确定就说记不清"), true);

  // runner 端到端：mock opening 返回摘要 → provider 收到含摘要的 system prompt
  const { env } = await createEnv();
  const { user, dm } = await seedBenbenDm(env);
  await saveMemoryAccount(env, user.id, { customerId: "CUST-T0042", token: "sagk_t", deviceId: memoryDeviceId(user.id) });
  const trigger = await insertMessage(env, { channelId: dm.id, senderId: user.id, content: "我今天有点累" });

  let capturedSystem = "";
  const providerFetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    capturedSystem = body.messages?.[0]?.content || "";
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "抱抱你" } }] })
    };
  };
  const memoryFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ available: true, session_recap_prompt: "上次聊了面试没过" })
  });

  const result = await runAiReply({
    env,
    room: { id: dm.id, kind: "dm", name: dm.name },
    triggerMessage: trigger,
    providerFetch,
    memoryFetch,
    sleep: async () => {}
  });
  assert.equal(result.status, "done");
  assert.equal(capturedSystem.includes("上次聊了面试没过"), true);
  const messages = await listMessages(env, dm.id, null, 10);
  assert.equal(messages[messages.length - 1].content, "抱抱你");
});

test("ai-reply 降级：无台账时 system prompt 不含摘要、回复正常", async () => {
  const { env } = await createEnv();
  const { user, dm } = await seedBenbenDm(env);
  const trigger = await insertMessage(env, { channelId: dm.id, senderId: user.id, content: "在吗" });
  let capturedSystem = "";
  const providerFetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    capturedSystem = body.messages?.[0]?.content || "";
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "在的" } }] }) };
  };
  const result = await runAiReply({
    env,
    room: { id: dm.id, kind: "dm", name: dm.name },
    triggerMessage: trigger,
    providerFetch,
    memoryFetch: async () => {
      throw new Error("不应该在无台账时调用");
    },
    sleep: async () => {}
  });
  assert.equal(result.status, "done");
  assert.equal(capturedSystem.includes("上次聊天的摘要"), false);
});

test("admin 接口：台账只读不含令牌，普通用户 403", async () => {
  const { env } = await createEnv();
  const admin = await seedUser(env, "root");
  await env.DB.prepare("UPDATE users SET is_super_admin = 1, management_protected = 1 WHERE id = ?").bind(admin.id).run();
  const adminSession = await createSession(env, { ...admin, isSuperAdmin: true });
  const target = await seedUser(env, "target");
  await saveMemoryAccount(env, target.id, { customerId: "CUST-T0042", token: "sagk_secret", deviceId: memoryDeviceId(target.id) });

  const res = await worker.fetch(
    new Request(`https://memory.test/api/admin/memory/account?userId=${target.id}`, {
      headers: { Authorization: `Bearer ${adminSession.token}` }
    }),
    env
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.hasAccount, true);
  assert.equal(body.customerId, "CUST-T0042");
  assert.equal(JSON.stringify(body).includes("sagk_secret"), false);

  const normal = await seedUser(env, "normal");
  const normalSession = await createSession(env, normal);
  const denied = await worker.fetch(
    new Request(`https://memory.test/api/admin/memory/account?userId=${target.id}`, {
      headers: { Authorization: `Bearer ${normalSession.token}` }
    }),
    env
  );
  assert.equal(denied.status, 403);
});
