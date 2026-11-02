export { getPinnedMessage } from "./messages.js";

export async function pinMessage(db, { channelId, messageId, pinnedBy }) {
	// 用单条 INSERT SELECT 同时确认消息仍然存活，避免删除与置顶并发时留下失效引用。
	const result = await db
		.prepare(
			`INSERT INTO channel_pins (channel_id, message_id, pinned_by, pinned_at)
			 SELECT ?, m.id, ?, CURRENT_TIMESTAMP
			 FROM messages m
			 WHERE m.id = ?
			   AND m.channel_id = ?
			   AND m.deleted_at IS NULL
			 ON CONFLICT(channel_id) DO UPDATE SET
			   message_id = excluded.message_id,
			   pinned_by = excluded.pinned_by,
			   pinned_at = CURRENT_TIMESTAMP`,
		)
		.bind(Number(channelId), Number(pinnedBy), Number(messageId), Number(channelId))
		.run();
	return Number(result.meta?.changes || 0) > 0;
}

export async function unpinMessage(db, { channelId, messageId }) {
	const result = await db
		.prepare(
			`DELETE FROM channel_pins
			 WHERE channel_id = ?
			   AND message_id = ?`,
		)
		.bind(Number(channelId), Number(messageId))
		.run();
	return Number(result.meta?.changes || 0) > 0;
}
