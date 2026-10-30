import { authMiddleware } from "../middleware.js";
import { errorResponse, parseJsonRequest } from "../utils.js";
import { getMemoryAccount, readMemoryToken } from "../integrations/memory/accounts.js";
import { ensureMemoryAccount } from "../integrations/memory/trial-register.js";
import { fetchSessionOpening, reportSessionEnded } from "../integrations/memory/pi-client.js";
import { settleTextSession } from "../integrations/memory/text-session.js";
import { fetchMemoryContext } from "../integrations/memory/v2-query.js";

/**
 * TASK-133：Chat 版记忆接口。
 * - POST /api/v1/memory/text-session/ended   客户端切后台时上报文本会话结束（转调 /pi 生成摘要）
 * - GET  /api/v1/memory/status               只读：本用户记忆是否可用（不含令牌）
 * - GET  /api/v1/memory/session/opening      服务端代取开场摘要（拿不到令牌时先懒补开）
 * - POST /api/v1/memory/voice-session/ended  服务端代报语音会话结束（一律 202）
 * - GET  /api/v1/memory/query?q=             服务端代调 V2 记忆库（端上不再手填令牌）
 * - GET  /api/admin/memory/account?userId=   管理员只读台账状态（不含令牌）
 *
 * 安全：任何响应都不返回令牌明文；只回 has_account / customer_id / status。
 */

/** 开户失败后 10 分钟内不再重试：避免客户每次开语音页都白等一次 15 秒超时（见细案第九节）。 */
const LAZY_OPEN_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

/** D1 的 CURRENT_TIMESTAMP 是 UTC 的 "YYYY-MM-DD HH:MM:SS"，转毫秒；解析不出返回 0。 */
function dbTimestampMs(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const normalized = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 取可用令牌；没有就做一次「懒补开」（建号钩子没跑成时靠这里自愈）。
 * 台账已是 failed 且 10 分钟内刚试过 → 不再重试，直接返回空。
 */
async function readTokenWithLazyOpen(env, userId) {
  const token = await readMemoryToken(env, userId);
  if (token) return { token, opened: false, account: null };

  const existing = await getMemoryAccount(env.DB, userId);
  if (existing && existing.status === "failed") {
    const updatedAt = dbTimestampMs(existing.updated_at);
    if (updatedAt && Date.now() - updatedAt < LAZY_OPEN_RETRY_COOLDOWN_MS) {
      return { token: null, opened: false, account: existing };
    }
  }

  const account = await ensureMemoryAccount(env, userId);
  if (!account) {
    // 开户失败会落成 failed 行（markMemoryAccountFailed），回读一次让上层能区分「没开过」与「开失败」
    const failed = await getMemoryAccount(env.DB, userId);
    return { token: null, opened: true, account: failed };
  }
  const retried = await readMemoryToken(env, userId);
  return { token: retried, opened: true, account };
}

/** 台账状态 → 客户侧可显示的三态。 */
function memoryState(account) {
  if (!account) return { memoried: false, status: "none", retryable: true };
  if (account.status === "active" && account.sag_token_cipher) {
    return { memoried: true, status: "active", retryable: false };
  }
  return { memoried: false, status: String(account.status || "failed"), retryable: true };
}

export function registerMemoryRoutes(app) {
  // 记忆是否可用（客户端据此显示「记忆：已开／未开」，不含令牌、不触发任何网络代调）
  app.get("/api/v1/memory/status", authMiddleware, async (c) => {
    const session = c.get("session");
    const account = await getMemoryAccount(c.env.DB, Number(session.userId));
    return c.json(memoryState(account));
  });

  // 开场摘要：服务端拿密文令牌代调 /pi，拿不到令牌先懒补开一次；任何失败都回 200 + available=false
  app.get("/api/v1/memory/session/opening", authMiddleware, async (c) => {
    const session = c.get("session");
    const userId = Number(session.userId);
    const { token, account } = await readTokenWithLazyOpen(c.env, userId);
    if (!token) {
      const state = memoryState(account);
      return c.json({ available: false, prompt: "", reason: state.status }, 200);
    }
    const opening = await fetchSessionOpening(c.env, token.token);
    return c.json(
      { available: opening.available, prompt: opening.prompt, reason: opening.reason },
      200
    );
  });

  // 语音会话结束：服务端代报 /pi；无论成败一律 202（异步语义，客户端不等）
  app.post("/api/v1/memory/voice-session/ended", authMiddleware, async (c) => {
    const session = c.get("session");
    const userId = Number(session.userId);
    const payload = await parseJsonRequest(c.req.raw);
    const endedAt = Number(payload.endedAt) || Date.now();
    const token = await readMemoryToken(c.env, userId);
    if (!token) {
      // 没有可用令牌时不懒补开：语音摘要没有账号就报不上去，等下次开场时再自愈
      return c.json({ ok: true, accepted: true, status: "no_token" }, 202);
    }
    const status = await reportSessionEnded(c.env, token.token, {
      sessionId: String(payload.sessionId || ""),
      startedAt: Number(payload.startedAt) || endedAt,
      endedAt,
      turnCount: Number(payload.turnCount) || 0,
      lastUserText: String(payload.lastUserText || "")
    });
    const result = status >= 200 && status < 300 ? "reported" : status ? `http_${status}` : "network";
    return c.json({ ok: true, accepted: true, status: result }, 202);
  });

  // 记忆库查询：客户不再手填令牌，由服务端带密文令牌代调 V2；拿不到令牌先懒补开一次。
  // 一律 200：端上按 available 分支（false 时显示"记忆还没开"），不用 401/403 折磨客户。
  app.get("/api/v1/memory/query", authMiddleware, async (c) => {
    const session = c.get("session");
    const userId = Number(session.userId);
    const { token, account } = await readTokenWithLazyOpen(c.env, userId);
    if (!token) {
      const state = memoryState(account);
      return c.json({ available: false, reason: state.status }, 200);
    }
    const result = await fetchMemoryContext(c.env, token.token, { q: c.req.query("q") });
    if (!result.ok) {
      return c.json({ available: false, reason: result.reason }, 200);
    }
    return c.json({ available: true, ...result.payload }, 200);
  });
  app.post("/api/v1/memory/text-session/ended", authMiddleware, async (c) => {
    const session = c.get("session");
    const payload = await parseJsonRequest(c.req.raw);
    const roomId = Number(payload.roomId);
    const lastMessageId = Number(payload.lastMessageId);
    if (!Number.isInteger(roomId) || roomId <= 0 || !Number.isInteger(lastMessageId) || lastMessageId <= 0) {
      return errorResponse("参数无效", 400);
    }

    // 只允许结算自己所在的 DM 房间，且该消息属于该房间
    const member = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM channel_members WHERE channel_id = ? AND user_id = ? LIMIT 1`
    )
      .bind(roomId, Number(session.userId))
      .all();
    if (!member.results?.length) {
      return errorResponse("无权访问该会话", 403);
    }
    const message = await c.env.DB.prepare(
      `SELECT id FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL LIMIT 1`
    )
      .bind(lastMessageId, roomId)
      .all();
    if (!message.results?.length) {
      return errorResponse("消息不存在", 400);
    }

    // 只允许「用户 ↔ 笨笨」一对一 DM（避免把普通用户间 DM 当记忆结算）
    const bot = await c.env.DB.prepare(
      `SELECT id FROM users WHERE username = 'benben' AND deleted_at IS NULL LIMIT 1`
    ).first();
    const botId = Number(bot?.id || 0);
    const members = await c.env.DB.prepare(
      `SELECT user_id FROM channel_members WHERE channel_id = ?`
    )
      .bind(roomId)
      .all();
    const memberIds = (members.results || []).map((row) => Number(row.user_id));
    if (!botId || !memberIds.includes(botId) || memberIds.length !== 2) {
      return c.json({ ok: true, accepted: true, status: "ignored_not_benben_dm" }, 202);
    }

    const result = await settleTextSession(c.env, {
      roomId,
      userId: Number(session.userId),
      lastMessageId,
      startedAt: Number(payload.startedAt) || Date.now(),
      turnCount: Number(payload.turnCount) || 0,
      lastUserText: String(payload.lastUserText || "")
    });

    // 客户端只需要知道"收到了"：失败一律 202（异步语义），状态码只在服务端日志/台账里
    return c.json({ ok: true, accepted: true, status: result.status }, 202);
  });
}

export function registerMemoryAdminRoutes(app) {
  app.get("/api/admin/memory/account", async (c) => {
    const userId = Number(c.req.query("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      return errorResponse("参数无效", 400);
    }
    const account = await getMemoryAccount(c.env.DB, userId);
    if (!account) {
      return c.json({ userId, hasAccount: false });
    }
    return c.json({
      userId,
      hasAccount: account.status === "active",
      status: account.status,
      customerId: account.customer_id || "",
      deviceId: account.device_id,
      hasToken: Boolean(account.sag_token_cipher),
      lastError: account.last_error || "",
      updatedAt: account.updated_at
    });
  });
}
