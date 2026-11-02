// 只聚合本人已加入且超过已读水位的消息，普通未读与关注未读共用一次索引范围扫描。
export function conversationUnreadCte(kind: "group" | "dm"): string {
	const roomFilter = kind === "dm" ? "rooms.kind = 'dm'" : "rooms.kind IN ('public', 'private')";
	const attention = kind === "dm" ? "m.reply_to_sender_id = viewer.user_id" : `
		m.reply_to_sender_id = viewer.user_id OR EXISTS (
			SELECT 1 FROM json_each(COALESCE(m.mention_user_ids, '[]')) mention_ids
			WHERE CAST(mention_ids.value AS INTEGER) = viewer.user_id
		)`;
	return `WITH viewer AS (SELECT ? AS user_id),
	 unread AS MATERIALIZED (
		SELECT m.channel_id, COUNT(*) AS unread_count,
		       SUM(CASE WHEN ${attention} THEN 1 ELSE 0 END) AS attention_unread_count
		FROM viewer
		JOIN channel_members membership ON membership.user_id = viewer.user_id
		JOIN channels rooms ON rooms.id = membership.channel_id
		LEFT JOIN message_reads mr ON mr.channel_id = membership.channel_id AND mr.user_id = viewer.user_id
		JOIN messages m ON m.channel_id = membership.channel_id AND m.id > COALESCE(mr.last_read_message_id, 0)
		WHERE ${roomFilter} AND rooms.deleted_at IS NULL AND m.deleted_at IS NULL
		  AND (m.sender_id IS NULL OR m.sender_id != viewer.user_id)
		GROUP BY m.channel_id
	 )`;
}
