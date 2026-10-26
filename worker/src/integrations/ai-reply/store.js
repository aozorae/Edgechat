import { ensureBenbenBot } from "../../data/distribution.js";

/**
 * 期一增项：文本回复链数据层。
 * - 配置：site_settings（缺失时按环境变量/默认值兜底，缺 API Key 时整链自动关闭）
 * - 任务：ai_reply_jobs（trigger_message_id 唯一 = 一条用户消息只回一次）
 * - 触发范围：只对「用户 与 笨笨」的一对一 dm 生效
 */

const ENABLED_KEY = "aiReply.enabled";
const LIMIT_KEY = "aiReply.dailyLimit";
const MODEL_KEY = "aiReply.model";

export const DEFAULT_MODEL = "qwen-plus";
export const DEFAULT_DAILY_LIMIT = 200;
export const MAX_DAILY_LIMIT = 5000;
export const DEFAULT_CONTEXT_MESSAGES = 12;
export const DEFAULT_MAX_TOKENS = 400;
export const DEFAULT_TIMEOUT_MS = 15000;

const JOB_STATUS = new Set(["pending", "running", "done", "failed", "skipped"]);
const JOB_PATCH_FIELDS = new Set([
  "status",
  "attempts",
  "provider",
  "model",
  "replied_message_id",
  "error",
]);

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function clampDailyLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.floor(parsed), 0), MAX_DAILY_LIMIT);
}

/** 读取回复链配置；数据库缺值时按 env / 默认值兜底。 */
export async function getAiReplyConfig(db, env = {}) {
  const { results } = await db
    .prepare(
      `SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN (?, ?, ?)`
    )
    .bind(ENABLED_KEY, LIMIT_KEY, MODEL_KEY)
    .all();
  const map = Object.fromEntries(
    (results || []).map((row) => [row.setting_key, row.setting_value])
  );
  return {
    enabled: (map[ENABLED_KEY] ?? "1") !== "0",
    dailyLimit: positiveInt(
      map[LIMIT_KEY] ?? env.AI_REPLY_DAILY_LIMIT_PER_USER,
      DEFAULT_DAILY_LIMIT,
      MAX_DAILY_LIMIT
    ),
    model:
      String(map[MODEL_KEY] || env.AI_REPLY_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    hasApiKey: Boolean(env.DASHSCOPE_API_KEY)
  };
}

/** 后台改配置（白名单字段：enabled / dailyLimit）。 */
export async function updateAiReplyConfig(db, { enabled, dailyLimit } = {}) {
  const statements = [];
  // 每条语句独立 prepare：后台写库走 authorizedDatabase 的 batch，
  // 复用同一个 prepared statement 会被最后一次 bind 覆盖。
  const upsert = (key, value) =>
    db
      .prepare(
        `INSERT INTO site_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(setting_key) DO UPDATE
         SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`
      )
      .bind(key, value);
  if (typeof enabled === "boolean") {
    statements.push(upsert(ENABLED_KEY, enabled ? "1" : "0"));
  }
  if (dailyLimit !== undefined && dailyLimit !== null) {
    const limit = clampDailyLimit(dailyLimit);
    if (limit === null) throw new Error("dailyLimit 必须是 0 到 5000 的整数");
    statements.push(upsert(LIMIT_KEY, String(limit)));
  }
  if (statements.length) {
    await db.batch(statements);
  }
}

/** 解析「是否笨笨 DM」：房间成员恰好是笨笨 + 当前发送者。 */
export async function resolveBenbenDm(db, channelId, senderId) {
  const bot = await ensureBenbenBot(db);
  const botId = Number(bot.id);
  const { results } = await db
    .prepare(`SELECT user_id FROM channel_members WHERE channel_id = ?`)
    .bind(Number(channelId))
    .all();
  const memberIds = (results || []).map((row) => Number(row.user_id));
  if (!memberIds.includes(botId)) return null;
  const peers = memberIds.filter((userId) => userId !== botId);
  if (peers.length !== 1 || peers[0] !== Number(senderId)) return null;
  return { botId, bot, recipientUserId: peers[0] };
}

/** 幂等登记待回复任务；已登记过返回 created=false。 */
export async function createAiReplyJob(db, { channelId, triggerMessageId, recipientUserId }) {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ai_reply_jobs (channel_id, trigger_message_id, recipient_user_id)
       VALUES (?, ?, ?)`
    )
    .bind(Number(channelId), Number(triggerMessageId), Number(recipientUserId))
    .run();
  if (Number(result.meta?.changes || 0) > 0) {
    return { created: true, id: Number(result.meta.last_row_id) };
  }
  const { results } = await db
    .prepare(`SELECT id FROM ai_reply_jobs WHERE trigger_message_id = ? LIMIT 1`)
    .bind(Number(triggerMessageId))
    .all();
  return { created: false, id: results?.[0] ? Number(results[0].id) : null };
}

/** 更新任务状态（字段白名单，防注入）。 */
export async function updateAiReplyJob(db, jobId, patch = {}) {
  const columns = Object.keys(patch).filter((key) => JOB_PATCH_FIELDS.has(key));
  if (!columns.length) return;
  if (patch.status !== undefined && !JOB_STATUS.has(String(patch.status))) {
    throw new Error("非法的任务状态");
  }
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  await db
    .prepare(
      `UPDATE ai_reply_jobs SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    .bind(...columns.map((column) => patch[column]), Number(jobId))
    .run();
}

/** 当日已占用额度（pending/running/done 都算，避免并发超额）。 */
export async function countRecentReplies(db, { recipientUserId, since }) {
  const { results } = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM ai_reply_jobs
       WHERE recipient_user_id = ?
         AND created_at >= ?
         AND status IN ('pending', 'running', 'done')`
    )
    .bind(Number(recipientUserId), String(since))
    .all();
  return Number(results?.[0]?.count || 0);
}

/** UTC 当日零点字符串（数据库 created_at 为 CURRENT_TIMESTAMP，即 UTC）。 */
export function utcDayStart(now = new Date()) {
  return `${now.toISOString().slice(0, 10)} 00:00:00`;
}

/** 后台统计：按天汇总最近若干天任务结果。 */
export async function getAiReplyStats(db, { days = 7, now = new Date() } = {}) {
  const span = Math.min(Math.max(Math.floor(Number(days) || 7), 1), 30);
  const since = `${new Date(now.getTime() - (span - 1) * 86400000)
    .toISOString()
    .slice(0, 10)} 00:00:00`;
  const { results } = await db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              status,
              COUNT(*) AS count,
              COUNT(DISTINCT recipient_user_id) AS users
       FROM ai_reply_jobs
       WHERE created_at >= ?
       GROUP BY day, status
       ORDER BY day ASC`
    )
    .bind(since)
    .all();
  const byDay = new Map();
  for (const row of results || []) {
    const day = String(row.day || "");
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        done: 0,
        failed: 0,
        skipped: 0,
        pending: 0,
        users: 0
      });
    }
    const entry = byDay.get(day);
    const status = String(row.status || "");
    if (status === "done") entry.done += Number(row.count || 0);
    else if (status === "failed") entry.failed += Number(row.count || 0);
    else if (status === "skipped") entry.skipped += Number(row.count || 0);
    else entry.pending += Number(row.count || 0);
    entry.users = Math.max(entry.users, Number(row.users || 0));
  }
  return { days: span, rows: [...byDay.values()] };
}
