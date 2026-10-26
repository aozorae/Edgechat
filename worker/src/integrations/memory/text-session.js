import {
  createTextSessionReport,
  getTextSessionReport,
  listStalePendingDmSessions,
  readMemoryToken,
  updateTextSessionReportStatus
} from "./accounts.js";
import { reportSessionEnded } from "./pi-client.js";

/**
 * TASK-133：文本会话结算（本单最大坑的落点）。
 *
 * 判据（变更单 §三）：
 * - 主判据：客户端切后台时上报 —— POST /api/v1/memory/text-session/ended → 本函数转调 /pi/api/session/ended
 * - 兜底：cron 扫"未结算且最后消息 > 30 分钟前"的 DM 会话补报
 * - 防重：text_session_reports(room_id, last_message_id) 唯一，重复上报直接返回 duplicate
 */

function sessionIdFor(roomId, lastMessageId) {
  return `chat_dm_${Number(roomId)}_${Number(lastMessageId)}`;
}

/**
 * 结算一个文本会话段。
 * 返回 { status: 'reported'|'duplicate'|'no_account'|'pi_failed'|'invalid', piStatus }
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
    console.log(
      JSON.stringify({ message: "text_session duplicate skipped", roomId: room, lastMsg: messageId })
    );
    return { status: "duplicate", piStatus: existing.pi_status ?? null };
  }

  const account = await readMemoryToken(env, uid);
  if (!account) {
    console.log(
      JSON.stringify({ message: "text_session skipped no_account", roomId: room, userId: uid })
    );
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

  const endedAt = Date.now();
  const piStatus = await reportSessionEnded(
    env,
    account.token,
    {
      sessionId,
      startedAt: Number(startedAt) || endedAt,
      endedAt,
      turnCount,
      lastUserText
    },
    { fetchImpl }
  );
  await updateTextSessionReportStatus(env.DB, { roomId: room, lastMessageId: messageId, piStatus });

  const ok = piStatus >= 200 && piStatus < 300;
  console.log(
    JSON.stringify({
      message: ok ? "text_session ended" : "text_session ended failed",
      roomId: room,
      lastMsg: messageId,
      piStatus
    })
  );
  return { status: ok ? "reported" : "pi_failed", piStatus };
}

/**
 * cron 兜底：扫描并补报"静默超过阈值的未结算 DM 会话"。
 * 只处理与笨笨 bot 的一对一 DM。
 */
export async function backfillStaleSessions(
  env,
  { botId, minSilentMinutes = 30, limit = 20, fetchImpl = fetch } = {}
) {
  const bot = Number(botId);
  if (!Number.isInteger(bot) || bot <= 0) return { scanned: 0, settled: 0, skipped: 0 };

  const rows = await listStalePendingDmSessions(env.DB, { botId: bot, minSilentMinutes, limit });
  let settled = 0;
  let skipped = 0;
  for (const row of rows) {
    const roomId = Number(row.room_id);
    const lastMessageId = Number(row.last_message_id);
    const { results } = await env.DB
      .prepare(
        `SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ? LIMIT 1`
      )
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
  return { scanned: rows.length, settled, skipped };
}
