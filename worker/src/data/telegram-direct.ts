import { activeUserSql } from "../user-status.js";

interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface TelegramDatabase {
  prepare(sql: string): Statement;
}
export interface TelegramDm {
  id: number;
  name: string;
}
export interface TelegramPrompt {
  channel_id: number;
  prompt_message_id: number;
}

export async function getTelegramBoundUser(db: TelegramDatabase, chatId: string) {
  return db.prepare(`SELECT n.user_id FROM telegram_notification_users n
    JOIN users u ON u.id = n.user_id
    WHERE n.telegram_chat_id = ? AND u.deleted_at IS NULL AND ${activeUserSql("u")}`)
    .bind(chatId).first<{ user_id: number }>();
}

// 只展示本人已有且当前可发送的私聊；不用全站通讯录，也不查询群组或解密历史正文。
const DM_SELECT = `SELECT c.id, COALESCE(NULLIF(peer.display_name, ''), peer.username) AS name
  FROM channel_members me JOIN channels c ON c.id = me.channel_id
  JOIN channel_members other ON other.channel_id = c.id AND other.user_id != me.user_id
  JOIN users peer ON peer.id = other.user_id JOIN users viewer ON viewer.id = me.user_id
  WHERE me.user_id = ? AND c.kind = 'dm' AND c.deleted_at IS NULL
    AND peer.deleted_at IS NULL AND ${activeUserSql("peer")}
    AND viewer.deleted_at IS NULL AND ${activeUserSql("viewer")}
    AND NOT EXISTS (SELECT 1 FROM user_blocks b
      WHERE (b.blocker_id = me.user_id AND b.blocked_id = other.user_id)
         OR (b.blocker_id = other.user_id AND b.blocked_id = me.user_id))`;

export async function listTelegramDms(db: TelegramDatabase, userId: number, page: number) {
  const { results } = await db.prepare(`${DM_SELECT} ORDER BY c.id DESC LIMIT 9 OFFSET ?`)
    .bind(userId, page * 8).all<TelegramDm>();
  return { rooms: results.slice(0, 8), hasNext: results.length > 8 };
}

export function getTelegramDm(db: TelegramDatabase, userId: number, channelId: number) {
  return db.prepare(`${DM_SELECT} AND c.id = ?`).bind(userId, channelId).first<TelegramDm>();
}

export async function saveTelegramPrompt(db: TelegramDatabase, {
  userId, chatId, channelId, promptId, requestId,
}: { userId: number; chatId: string; channelId: number; promptId: number; requestId: number }) {
  // 每用户只保存一个目标；旧提示不能把正文误投到新选择的人，重复/乱序 webhook 也不能覆盖新目标。
  await db.prepare(`INSERT INTO telegram_dm_prompts
    (user_id, telegram_chat_id, channel_id, prompt_message_id, request_message_id, expires_at)
    SELECT user_id, ?, ?, ?, ?, datetime('now', '+10 minutes')
    FROM telegram_notification_users WHERE user_id = ? AND telegram_chat_id = ?
    ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id,
      channel_id = excluded.channel_id, prompt_message_id = excluded.prompt_message_id,
      request_message_id = excluded.request_message_id, expires_at = excluded.expires_at
    WHERE excluded.request_message_id > telegram_dm_prompts.request_message_id`)
    .bind(chatId, channelId, promptId, requestId, userId, chatId).run();
}

export function getTelegramPrompt(db: TelegramDatabase, userId: number, chatId: string, promptId: number) {
  return db.prepare(`SELECT channel_id, prompt_message_id FROM telegram_dm_prompts
    WHERE user_id = ? AND telegram_chat_id = ? AND prompt_message_id = ?
      AND expires_at > CURRENT_TIMESTAMP`).bind(userId, chatId, promptId).first<TelegramPrompt>();
}
