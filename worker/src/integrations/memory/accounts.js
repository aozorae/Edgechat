import { decryptSecretValue, encryptSecretValue } from "../../encryption.js";

/**
 * TASK-133：Chat 版记忆 A 方案数据层。
 * - user_memory_accounts：每个 Chat 用户一个 SAG 试用号（device_id 幂等），令牌加密存 D1
 * - text_session_reports：文本会话结算幂等记录（room_id + last_message_id 唯一）
 *
 * 安全：令牌只以密文形态落库；解密仅在 worker 内部调用记忆接口时发生；日志/接口一律不含明文。
 */

const MEMORY_TOKEN_CONTEXT = "edgechat.user_memory_accounts.sag_token";

/** EdgeChat 用户 → 稳定的 device_id：`63686174` = "chat" 的 ASCII hex，后接 8 位十六进制用户号。 */
export function memoryDeviceId(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("userId 无效");
  return `63686174-${id.toString(16).padStart(8, "0")}`;
}

export async function getMemoryAccount(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT user_id, device_id, customer_id, sag_token_cipher, token_key_id, status, last_error, created_at, updated_at
       FROM user_memory_accounts WHERE user_id = ? LIMIT 1`
    )
    .bind(Number(userId))
    .all();
  return results?.[0] || null;
}

/** 读出可用的记忆令牌（解密）；无台账/状态非 active/解密失败 → null（上层按现状降级）。 */
export async function readMemoryToken(env, userId) {
  const account = await getMemoryAccount(env.DB, userId);
  if (!account || account.status !== "active" || !account.sag_token_cipher) return null;
  try {
    const token = await decryptSecretValue(env, account.sag_token_cipher, MEMORY_TOKEN_CONTEXT);
    if (!String(token || "").trim()) return null;
    return {
      token: String(token).trim(),
      customerId: account.customer_id || "",
      deviceId: account.device_id
    };
  } catch {
    return null;
  }
}

export async function markMemoryAccountFailed(db, userId, error) {
  const deviceId = memoryDeviceId(userId);
  await db
    .prepare(
      `INSERT INTO user_memory_accounts (user_id, device_id, status, last_error)
       VALUES (?, ?, 'failed', ?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = 'failed',
         last_error = excluded.last_error,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(Number(userId), deviceId, String(error || "").slice(0, 300))
    .run();
}

/**
 * 存入开户结果（幂等：同 user_id 覆盖为 active）。
 * 入参含明文令牌，本函数内部立即加密，绝不落明文。
 */
export async function saveMemoryAccount(env, userId, { customerId, token, deviceId }) {
  const cipher = await encryptSecretValue(env, token, MEMORY_TOKEN_CONTEXT);
  const keyIdMatch = /^([^:]+):/.exec(cipher);
  await env.DB
    .prepare(
      `INSERT INTO user_memory_accounts (user_id, device_id, customer_id, sag_token_cipher, token_key_id, status, last_error)
       VALUES (?, ?, ?, ?, ?, 'active', NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         device_id = excluded.device_id,
         customer_id = excluded.customer_id,
         sag_token_cipher = excluded.sag_token_cipher,
         token_key_id = excluded.token_key_id,
         status = 'active',
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      Number(userId),
      String(deviceId || memoryDeviceId(userId)),
      String(customerId || ""),
      cipher,
      keyIdMatch ? keyIdMatch[1] : ""
    )
    .run();
  return getMemoryAccount(env.DB, userId);
}

// ===== 文本会话结算 =====

/** 该消息的结算记录（幂等键 room_id + last_message_id）。 */
export async function getTextSessionReport(db, roomId, lastMessageId) {
  const { results } = await db
    .prepare(
      `SELECT room_id, last_message_id, user_id, session_id, status, attempts, pi_status, reported_at, last_attempt_at
       FROM text_session_reports WHERE room_id = ? AND last_message_id = ? LIMIT 1`
    )
    .bind(Number(roomId), Number(lastMessageId))
    .all();
  return results?.[0] || null;
}

/** 记录一次结算（先占位 pending，再转调）。返回 created=false 表示已存在。 */
export async function createTextSessionReport(db, { roomId, lastMessageId, userId, sessionId }) {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO text_session_reports (room_id, last_message_id, user_id, session_id, status, attempts, last_attempt_at)
       VALUES (?, ?, ?, ?, 'pending', 1, CURRENT_TIMESTAMP)`
    )
    .bind(Number(roomId), Number(lastMessageId), Number(userId), String(sessionId))
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

/**
 * 写入本次转调结果（状态机 pending → reported / failed）。
 * 每次尝试 attempts+1，last_attempt_at 更新（cron 拾取重试用）。
 */
export async function updateTextSessionReportResult(db, { roomId, lastMessageId, piStatus, ok }) {
  await db
    .prepare(
      `UPDATE text_session_reports
       SET status = ?, pi_status = ?, attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP
       WHERE room_id = ? AND last_message_id = ?`
    )
    .bind(
      ok ? "reported" : "failed",
      piStatus === null || piStatus === undefined ? null : Number(piStatus),
      Number(roomId),
      Number(lastMessageId)
    )
    .run();
}

/** 重试前把记录标记为再次尝试（保持 pending，attempts 由结果写入时 +1）。 */
export async function markTextSessionRetry(db, { roomId, lastMessageId }) {
  await db
    .prepare(
      `UPDATE text_session_reports
       SET status = 'pending', last_attempt_at = CURRENT_TIMESTAMP
       WHERE room_id = ? AND last_message_id = ?`
    )
    .bind(Number(roomId), Number(lastMessageId))
    .run();
}

/** 某 DM 最近一条已结算的消息 id（用于判断"是否有未结算的新消息"）。 */
export async function getLastReportedMessageId(db, roomId) {
  const { results } = await db
    .prepare(
      `SELECT MAX(last_message_id) AS last_id FROM text_session_reports WHERE room_id = ?`
    )
    .bind(Number(roomId))
    .all();
  return Number(results?.[0]?.last_id || 0);
}

/**
 * cron 兜底扫描：找出"有未结算消息、且最后一条消息已静默超过 minSilentMinutes"的 DM 会话。
 * 仅看 DM（kind='dm'）且房间成员里有笨笨 bot 的会话（= 与笨笨的私聊）。
 */
export async function listStalePendingDmSessions(db, { botId, minSilentMinutes = 30, limit = 20 }) {
  const { results } = await db
    .prepare(
      `SELECT m.channel_id AS room_id,
              MAX(m.id) AS last_message_id,
              MAX(m.sender_id) AS last_sender_id,
              MAX(m.created_at) AS last_message_at,
              COUNT(*) AS message_count
       FROM messages m
       JOIN channels c ON c.id = m.channel_id AND c.kind = 'dm' AND c.deleted_at IS NULL
       JOIN channel_members b ON b.channel_id = m.channel_id AND b.user_id = ?
       WHERE m.deleted_at IS NULL
         AND m.created_at <= datetime('now', ?)
         AND m.id > COALESCE((SELECT MAX(r.last_message_id) FROM text_session_reports r WHERE r.room_id = m.channel_id AND r.status = 'reported'), 0)
       GROUP BY m.channel_id
       ORDER BY MAX(m.id) ASC
       LIMIT ?`
    )
    .bind(Number(botId), `-${Number(minSilentMinutes) || 30} minutes`, Number(limit) || 20)
    .all();
  return results || [];
}

/**
 * cron 拾取"pi 非 2xx/网络失败"的结算记录做限次重试（防该段摘要永久静默丢失）。
 * 条件：status IN ('pending','failed') 且 attempts < maxAttempts 且距上次尝试超过 minAgeMinutes。
 */
export async function listRetryableReports(db, { maxAttempts = 3, minAgeMinutes = 5, limit = 20 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT room_id, last_message_id, user_id, session_id, status, attempts
       FROM text_session_reports
       WHERE status IN ('pending', 'failed')
         AND attempts < ?
         AND (last_attempt_at IS NULL OR last_attempt_at <= datetime('now', ?))
       ORDER BY last_attempt_at ASC
       LIMIT ?`
    )
    .bind(Number(maxAttempts) || 3, `-${Number(minAgeMinutes) || 5} minutes`, Number(limit) || 20)
    .all();
  return results || [];
}
