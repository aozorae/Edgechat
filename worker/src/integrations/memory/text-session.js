import {
  createTextSessionReport,
  getTextSessionReport,
  listRetryableReports,
  listStalePendingDmSessions,
  markTextSessionRetry,
  readMemoryToken,
  updateTextSessionReportResult
} from "./accounts.js";
import { reportSessionEnded } from "./pi-client.js";

/**
 * TASK-133：文本会话结算（本单最大坑的落点）。
 *
 * 判据（变更单 §三）：
 * - 主判据：客户端切后台时上报 —— POST /api/v1/memory/text-session/ended → 本函数转调 /pi/api/session/ended
 * - 兜底：cron 扫"未结算且最后消息 > 30 分钟前"的 DM 会话补报
 * - 状态机：pending → reported（pi 2xx）/ failed（非 2xx 或网络失败）；failed 由 cron 限次重试，
 *   防止"pi 一次失败导致该段摘要永久静默丢失"
 * - session_id 语义（定死）：`chat_dm_<roomId>_<lastMessageId>`，与变更单 §3.1 保持一致
 */

const MAX_ATTEMPTS = 3;
const RETRY_AGE_MINUTES = 5;

/** session_id 语义唯一实现：roomId + 该段最后一条消息 id。 */
export function sessionIdFor(roomId, lastMessageId) {
  return `chat_dm_${Number(roomId)}_${Number(lastMessageId)}`;
}

async function attemptReport(
  env,
  { roomId, lastMessageId, userId, sessionId, startedAt, turnCount = 0, lastUserText = "", fetchImpl = fetch }
) {
  const account = await readMemoryToken(env, userId);
  if (!account) {
    console.log(
      JSON.stringify({ message: "text_session skipped no_account", roomId, lastMsg: lastMessageId, userId })
    );
    return { status: "no_account", piStatus: null };
  }
  const endedAt = Date.now();
  const piStatus = await reportSessionEnded(
    env,
    account.token,
    { sessionId, startedAt: Number(startedAt) || endedAt, endedAt, turnCount, lastUserText },
    { fetchImpl }
  );
  const ok = piStatus >= 200 && piStatus < 300;
  await updateTextSessionReportResult(env.DB, { roomId, lastMessageId, piStatus, ok });
  console.log(
    JSON.stringify({
      message: ok ? "text_session ended" : "text_session ended failed",
      roomId,
      lastMsg: lastMessageId,
      piStatus
    })
  );
  return { status: ok ? "reported" : "pi_failed", piStatus };
}

/**
 * 结算一个文本会话段。
 * 返回 { status: 'reported'|'duplicate'|'no_account'|'pi_failed'|'retry_exhausted'|'invalid', piStatus }
 */
export async function settleTextSession(
  env,
  { roomId, userId, lastMessageId, startedAt, turnCount = 0, lastUserText = "", fetchImpl = fetch } = {}
) {
  const room = Number(roomId);
  const messageId = Number(lastMessageId);
  const uid = Number(userId);
  if (!Number.isInteger(room) || room <= 0 || !Number.isInteger(messageId) || messageId <= 0 || !Number.isInteger(uid) || uid <= 0) {
    return { status: "invalid", piStatus: null };
  }

  const existing = await getTextSessionReport(env.DB, room, messageId);
  if (existing) {
    // 已成功 → 幂等返回；失败/进行中 → 限次重试（cron 另有兜底拾取）
    if (existing.status === "reported") {
      console.log(
        JSON.stringify({ message: "text_session duplicate skipped", roomId: room, lastMsg: messageId })
      );
      return { status: "duplicate", piStatus: existing.pi_status ?? null };
    }
    if (Number(existing.attempts) >= MAX_ATTEMPTS) {
      console.log(
        JSON.stringify({ message: "text_session retry exhausted", roomId: room, lastMsg: messageId })
      );
      return { status: "retry_exhausted", piStatus: existing.pi_status ?? null };
    }
    await markTextSessionRetry(env.DB, { roomId: room, lastMessageId: messageId });
    return attemptReport(env, {
      roomId: room,
      lastMessageId: messageId,
      userId: uid,
      sessionId: existing.session_id || sessionIdFor(room, messageId),
      startedAt,
      turnCount,
      lastUserText,
      fetchImpl
    });
  }

  const account = await readMemoryToken(env, uid);
  if (!account) {
    console.log(JSON.stringify({ message: "text_session skipped no_account", roomId: room, userId: uid }));
    return { status: "no_account", piStatus: null };
  }

  const sessionId = sessionIdFor(room, messageId);
  const created = await createTextSessionReport(env.DB, {
    roomId: room,
    lastMessageId: messageId,
    userId: uid,
    sessionId
  });
  if (!created) {
    console.log(JSON.stringify({ message: "text_session duplicate skipped", roomId: room, lastMsg: messageId }));
    return { status: "duplicate", piStatus: null };
  }
  return attemptReport(env, {
    roomId: room,
    lastMessageId: messageId,
    userId: uid,
    sessionId,
    startedAt,
    turnCount,
    lastUserText,
    fetchImpl
  });
}

/**
 * cron 拾取失败记录重试（防"pi 非 2xx 导致该段摘要永久静默丢失"）。
 * 返回 { retried, recovered }。
 */
export async function retryFailedReports(env, { fetchImpl = fetch, limit = 20 } = {}) {
  const rows = await listRetryableReports(env.DB, {
    maxAttempts: MAX_ATTEMPTS,
    minAgeMinutes: RETRY_AGE_MINUTES,
    limit
  });
  let retried = 0;
  let recovered = 0;
  for (const row of rows) {
    const roomId = Number(row.room_id);
    const lastMessageId = Number(row.last_message_id);
    const userId = Number(row.user_id);
    await markTextSessionRetry(env.DB, { roomId, lastMessageId });
    const result = await attemptReport(env, {
      roomId,
      lastMessageId,
      userId,
      sessionId: row.session_id || sessionIdFor(roomId, lastMessageId),
      startedAt: Date.now(),
      turnCount: 0,
      lastUserText: "",
      fetchImpl
    });
    retried += 1;
    if (result.status === "reported") recovered += 1;
  }
  return { retried, recovered };
}

/**
 * cron 兜底：①扫描并补报"静默超过阈值的未结算 DM 会话"；②重试失败记录。
 */
export async function backfillStaleSessions(
  env,
  { botId, minSilentMinutes = 30, limit = 20, fetchImpl = fetch } = {}
) {
  const bot = Number(botId);
  if (!Number.isInteger(bot) || bot <= 0) return { scanned: 0, settled: 0, skipped: 0, retried: 0, recovered: 0 };

  const rows = await listStalePendingDmSessions(env.DB, { botId: bot, minSilentMinutes, limit });
  let settled = 0;
  let skipped = 0;
  for (const row of rows) {
    const roomId = Number(row.room_id);
    const lastMessageId = Number(row.last_message_id);
    const { results } = await env.DB
      .prepare(`SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ? LIMIT 1`)
      .bind(roomId, bot)
      .all();
    const userId = Number(results?.[0]?.user_id || 0);
    if (!userId) {
      skipped += 1;
      continue;
    }
    const result = await settleTextSession(env, {
      roomId,
      userId,
      lastMessageId,
      startedAt: Date.parse(row.last_message_at || "") || Date.now(),
      turnCount: Number(row.message_count || 0),
      lastUserText: "",
      fetchImpl
    });
    if (result.status === "reported") settled += 1;
    else skipped += 1;
  }

  const retry = await retryFailedReports(env, { fetchImpl, limit });
  return {
    scanned: rows.length,
    settled,
    skipped,
    retried: retry.retried,
    recovered: retry.recovered
  };
}
