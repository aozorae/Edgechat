import { getTelegramCredentials } from "../../data/telegram.js";
import { randomToken } from "../../utils.js";
import { activeUserSql } from "../../user-status.js";

async function tokenHash(token) {
	const bytes = new TextEncoder().encode(token);
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function getTelegramNotificationState(env, userId) {
	const [credentials, row] = await Promise.all([
		getTelegramCredentials(env),
		env.DB.prepare(
			"SELECT telegram_chat_id, telegram_name, dm_enabled, mention_enabled FROM telegram_notification_users WHERE user_id = ?",
		).bind(userId).first(),
	]);
	return {
		available: Boolean(credentials?.botUsername),
		connected: Boolean(row?.telegram_chat_id),
		telegramName: row?.telegram_name || "",
		dmEnabled: row ? Boolean(row.dm_enabled) : true,
		mentionEnabled: row ? Boolean(row.mention_enabled) : true,
	};
}

export async function createTelegramNotificationLink(env, userId) {
	const credentials = await getTelegramCredentials(env);
	if (!credentials?.botUsername || !/^[A-Za-z0-9_]{5,32}$/.test(credentials.botUsername)) {
		return null;
	}
	const token = randomToken(24);
	const hash = await tokenHash(token);
	await env.DB.prepare(
		`INSERT INTO telegram_notification_users (user_id, pending_token_hash, pending_expires_at)
		 VALUES (?, ?, datetime('now', '+10 minutes'))
		 ON CONFLICT(user_id) DO UPDATE SET pending_token_hash = excluded.pending_token_hash,
		 pending_expires_at = excluded.pending_expires_at, updated_at = CURRENT_TIMESTAMP`,
	).bind(userId, hash).run();
	return `https://t.me/${credentials.botUsername}?start=${token}`;
}

export async function consumeTelegramNotificationLink(env, message) {
	if (message?.chat?.type !== "private" || message.from?.is_bot ||
		String(message.chat.id) !== String(message.from?.id)) return false;
	const match = /^\/start ([A-Za-z0-9_-]{32})$/.exec(String(message.text || "").trim());
	if (!match) return false;
	const hash = await tokenHash(match[1]);
	const chatId = String(message.chat.id);
	const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") ||
		message.from.username || chatId;
	const result = await env.DB.prepare(
		`UPDATE telegram_notification_users SET telegram_chat_id = ?, telegram_name = ?,
		 pending_token_hash = NULL, pending_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
		 WHERE pending_token_hash = ? AND pending_expires_at > CURRENT_TIMESTAMP
		 AND NOT EXISTS (SELECT 1 FROM telegram_notification_users other
		                 WHERE other.telegram_chat_id = ? AND other.user_id != telegram_notification_users.user_id)
		 AND EXISTS (SELECT 1 FROM users u WHERE u.id = telegram_notification_users.user_id
		             AND u.deleted_at IS NULL AND ${activeUserSql("u")})
		 RETURNING user_id`,
	).bind(chatId, String(name).slice(0, 80), hash, chatId).first();
	return Boolean(result);
}

export async function updateTelegramNotificationPreferences(db, userId, { dmEnabled, mentionEnabled }) {
	await db.prepare(
		`INSERT INTO telegram_notification_users (user_id, dm_enabled, mention_enabled)
		 VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET dm_enabled = excluded.dm_enabled,
		 mention_enabled = excluded.mention_enabled, updated_at = CURRENT_TIMESTAMP`,
	).bind(userId, Number(dmEnabled), Number(mentionEnabled)).run();
}

export async function disconnectTelegramNotifications(db, userId) {
	await db.prepare("DELETE FROM telegram_notification_users WHERE user_id = ?").bind(userId).run();
	await db.prepare("DELETE FROM telegram_notification_outbox WHERE user_id = ? AND status != 'sent'").bind(userId).run();
}

export { enqueueTelegramNotification, deliverTelegramNotification, rescueTelegramNotifications } from "./notification-queue.ts";

export async function pruneTelegramNotifications(env) {
	await env.DB.prepare("DELETE FROM telegram_dm_prompts WHERE expires_at <= CURRENT_TIMESTAMP").run();
	// 去重只需要覆盖最近消息，终态提醒不应永久占用数据库。
	await env.DB.prepare(
		"DELETE FROM telegram_notification_outbox WHERE status IN ('sent', 'failed') AND updated_at < datetime('now', '-7 days')",
	).run();
}
