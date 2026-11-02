import { getTelegramCredentials } from "../../data/telegram.js";
import { activeUserSql } from "../../user-status.js";
import { TelegramApiError, sendTelegramText } from "./client.js";
import { buildTelegramNotification } from "./notification-content.ts";

interface Statement {
  bind(...values: (string | number)[]): Statement;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface NotificationEnv {
  DB: { prepare(sql: string): Statement };
  TELEGRAM_NOTIFICATIONS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

const MAX_ATTEMPTS = 4;

export async function wakeTelegramNotifications(env: NotificationEnv) {
  const stub = env.TELEGRAM_NOTIFICATIONS.get(env.TELEGRAM_NOTIFICATIONS.idFromName("notifications"));
  const response = await stub.fetch(new Request("https://notifications.internal/wake", {
    method: "POST", headers: { "x-cfchat-internal-auth": "worker-verified" },
  }));
  if (!response.ok) throw new Error("Telegram notification scheduler unavailable");
}

export async function enqueueTelegramNotification(env: NotificationEnv, {
  userId, senderId, room, message, kind,
}: {
  userId: number; senderId: number | null;
  room: { id: number; name?: string }; message: { id: number }; kind: string;
}) {
  if (kind !== "dm" && kind !== "mention") return;
  // 预算与插入在同一条 SQL 内完成，跨房间并发也不能超额；被抑制的只是提醒，不是聊天消息。
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO telegram_notification_outbox
    (user_id, sender_id, channel_id, message_id, kind, room_name, next_attempt_at, created_at)
    SELECT n.user_id, ?, ?, ?, ?, ?, datetime('now', '+10 seconds'), CURRENT_TIMESTAMP
    FROM telegram_notification_users n JOIN users u ON u.id = n.user_id
    WHERE n.user_id = ? AND n.telegram_chat_id IS NOT NULL
      AND u.deleted_at IS NULL AND ${activeUserSql("u")}
      AND CASE WHEN ? = 'dm' THEN n.dm_enabled ELSE n.mention_enabled END = 1
      AND (SELECT COUNT(*) FROM telegram_notification_outbox WHERE sender_id = ? AND created_at > datetime('now', '-1 minute')) < 20
      AND (SELECT COUNT(*) FROM telegram_notification_outbox WHERE user_id = ? AND created_at > datetime('now', '-1 minute')) < 5
      AND (SELECT COUNT(*) FROM telegram_notification_outbox WHERE created_at > datetime('now', '-1 minute')) < 100
      AND (SELECT COUNT(*) FROM telegram_notification_outbox WHERE channel_id = ? AND message_id = ?) < 10
      AND (SELECT COUNT(*) FROM telegram_notification_outbox WHERE status IN ('pending', 'sending')) < 500
  `).bind(senderId ?? 0, room.id, message.id, kind, String(room.name || "EdgeChat").slice(0, 80),
    userId, kind, senderId ?? 0, userId, room.id, message.id).run();
  if (result.meta?.changes) await wakeTelegramNotifications(env);
}

export async function nextTelegramNotificationAt(env: NotificationEnv): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT MIN(MAX(o.next_attempt_at, n.next_notification_at, g.next_send_at)) AS due
    FROM telegram_notification_outbox o
    JOIN telegram_notification_users n ON n.user_id = o.user_id
    CROSS JOIN telegram_notification_gate g
    WHERE o.status IN ('pending', 'sending')`).first<{ due: string | null }>();
  return row?.due ? Date.parse(`${row.due.replace(" ", "T")}Z`) : null;
}

export async function deliverTelegramNotification(env: NotificationEnv) {
  // 租约耗尽后也要收尾，避免最后一次网络请求中断留下永久 sending 行。
  await env.DB.prepare(`UPDATE telegram_notification_outbox SET status = 'failed', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'sending' AND attempts >= ? AND next_attempt_at <= CURRENT_TIMESTAMP`).bind(MAX_ATTEMPTS).run();
  await env.DB.prepare(`UPDATE telegram_notification_outbox SET status = 'failed', updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('pending', 'sending') AND NOT EXISTS (
      SELECT 1 FROM telegram_notification_users n JOIN users u ON u.id = n.user_id
      WHERE n.user_id = telegram_notification_outbox.user_id AND n.telegram_chat_id IS NOT NULL
      AND u.deleted_at IS NULL AND ${activeUserSql("u")}
      AND CASE WHEN telegram_notification_outbox.kind = 'dm' THEN n.dm_enabled ELSE n.mention_enabled END = 1)
  `).run();
  const candidate = await env.DB.prepare(`SELECT o.user_id, o.kind, n.telegram_chat_id
    FROM telegram_notification_outbox o JOIN telegram_notification_users n ON n.user_id = o.user_id
    WHERE o.status IN ('pending', 'sending') AND o.attempts < ?
      AND o.next_attempt_at <= CURRENT_TIMESTAMP AND n.next_notification_at <= CURRENT_TIMESTAMP
    ORDER BY o.next_attempt_at, o.id LIMIT 1`).bind(MAX_ATTEMPTS)
    .first<{ user_id: number; kind: string; telegram_chat_id: string }>();
  if (!candidate) return;
  // D1 全站闸门也保护救援或重入调用；失败和重试同样占用发送预算。
  const slot = await env.DB.prepare(`UPDATE telegram_notification_gate SET next_send_at = datetime('now', '+1 second')
    WHERE id = 1 AND next_send_at <= CURRENT_TIMESTAMP RETURNING id`).first();
  if (!slot) return;
  const { results: claimed } = await env.DB.prepare(`UPDATE telegram_notification_outbox
    SET status = 'sending', attempts = attempts + 1, next_attempt_at = datetime('now', '+5 minutes'), updated_at = CURRENT_TIMESTAMP
    WHERE id IN (SELECT id FROM telegram_notification_outbox WHERE user_id = ? AND kind = ?
      AND status IN ('pending', 'sending') AND attempts < ? AND next_attempt_at <= CURRENT_TIMESTAMP
      ORDER BY id LIMIT 5) RETURNING id, room_name, attempts`).bind(candidate.user_id, candidate.kind, MAX_ATTEMPTS)
    .all<{ id: number; room_name: string; attempts: number }>();
  if (!claimed.length) return;
  await env.DB.prepare(`UPDATE telegram_notification_users SET next_notification_at = datetime('now', '+1 minute')
    WHERE user_id = ?`).bind(candidate.user_id).run();
  const ids = claimed.map(row => row.id);
  const placeholders = ids.map(() => "?").join(",");
  try {
    const credentials = await getTelegramCredentials(env);
    if (!credentials) throw new Error("Telegram bot unavailable");
    const notification = await buildTelegramNotification(env, {
      ids, userId: candidate.user_id, chatId: candidate.telegram_chat_id, kind: candidate.kind,
      webhookUrl: credentials.webhookUrl,
    });
    if (notification) {
      await sendTelegramText(credentials.botToken, {
        chatId: candidate.telegram_chat_id, ...notification,
        parseMode: null, disableLinkPreview: true, timeoutMs: 5000,
      });
    }
    await env.DB.prepare(`UPDATE telegram_notification_outbox SET status = 'sent', updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders}) AND status = 'sending'`).bind(...ids).run();
  } catch (error) {
    const throttled = error instanceof TelegramApiError && error.status === 429;
    const delay = throttled ? Math.max(1, Math.ceil(error.retryAfter || 60)) : Math.max(...claimed.map(row => row.attempts)) * 300;
    if (throttled) {
      // Telegram 的限额由共享 Bot 承担，不能只推迟触发 429 的那一位收件人。
      await env.DB.prepare(`UPDATE telegram_notification_gate SET next_send_at = MAX(next_send_at, datetime('now', '+' || ? || ' seconds'))
        WHERE id = 1`).bind(delay).run();
    }
    await env.DB.prepare(`UPDATE telegram_notification_outbox
      SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
        next_attempt_at = datetime('now', '+' || ? || ' seconds'), updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders}) AND status = 'sending'`).bind(MAX_ATTEMPTS, delay, ...ids).run();
    console.warn(JSON.stringify({ message: "telegram_notification_delivery_failed", throttled, count: ids.length }));
  }
}

export async function rescueTelegramNotifications(env: NotificationEnv) {
  if (await nextTelegramNotificationAt(env) !== null) await wakeTelegramNotifications(env);
  const { results } = await env.DB.prepare(`SELECT status, COUNT(*) AS count FROM telegram_notification_outbox
    WHERE status IN ('pending', 'sending', 'failed') GROUP BY status`).all();
  console.info(JSON.stringify({ message: "telegram_notification_queue", counts: results }));
}
