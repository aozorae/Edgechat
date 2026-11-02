import { publicFileUrl } from "../utils.js";
import { isUserDisabled } from "../user-status.js";
import { conversationUnreadCte } from "./conversation-unread.ts";

function mapVisibleChannel(row) {
	return {
		id: Number(row.id),
		name: row.name,
		description: row.description,
		avatarKey: row.avatar_key || "",
		avatarUrl: row.avatar_key ? publicFileUrl(row.avatar_key) : "",
		kind: row.kind,
		isGeneral: Boolean(Number(row.is_general)),
		ownerDisplayName: row.owner_display_name || "",
		isMember: Boolean(Number(row.is_member)),
		myRole: row.my_role || "",
		canManage: Boolean(Number(row.can_manage)),
		memberCount: Number(row.member_count || 0),
		lastMessageAt: row.last_message_at || null,
		unreadCount: Number(row.unread_count || 0),
			mentionUnreadCount: Number(row.attention_unread_count || 0),
	};
}

function mapAdminChannel(row, includeAvatar) {
	const channel = {
		id: Number(row.id),
		name: row.name,
		description: row.description,
		kind: row.kind,
		isGeneral: Boolean(Number(row.is_general)),
		createdAt: row.created_at,
		ownerDisplayName: row.owner_display_name || "未知",
		memberCount: Number(row.member_count),
		messageCount: Number(row.message_count),
	};
	if (includeAvatar) {
		channel.avatarKey = row.avatar_key || "";
		channel.avatarUrl = row.avatar_key ? publicFileUrl(row.avatar_key) : "";
	}
	return channel;
}

export async function listVisibleChannels(db, userId) {
	const { results } = await db
		.prepare(
			`${conversationUnreadCte("group")}
			 SELECT c.id, c.name, c.description, c.avatar_key, c.kind,
			        CASE WHEN c.name = 'general' THEN 1 ELSE 0 END AS is_general,
			        owner.display_name AS owner_display_name,
			        me.user_id IS NOT NULL AS is_member,
			        COALESCE(me.role, '') AS my_role,
			        COALESCE(me.role = 'owner', 0) AS can_manage,
			        (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) AS member_count,
			        (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS last_message_at,
			        COALESCE(unread.unread_count, 0) AS unread_count,
			        COALESCE(unread.attention_unread_count, 0) AS attention_unread_count
			 FROM viewer CROSS JOIN channels c
			 LEFT JOIN users owner ON owner.id = c.created_by
			 LEFT JOIN channel_members me ON me.channel_id = c.id AND me.user_id = viewer.user_id
			 LEFT JOIN unread ON unread.channel_id = c.id
			 WHERE c.kind IN ('public', 'private') AND c.deleted_at IS NULL
			   AND (c.kind = 'public' OR me.user_id IS NOT NULL)
			 ORDER BY CASE WHEN c.name = 'general' THEN 0 ELSE 1 END,
			          CASE c.kind WHEN 'public' THEN 0 ELSE 1 END, c.name ASC`,
		)
		.bind(Number(userId))
		.all();
	return results.map(mapVisibleChannel);
}

export async function listAdminChannels(db, { includeAvatar = true } = {}) {
	const { results } = await db
		.prepare(
				`SELECT
				   c.id, c.name, c.description, c.avatar_key, c.kind, c.created_at,
				   CASE WHEN c.name = 'general' THEN 1 ELSE 0 END AS is_general,
			   owner.display_name AS owner_display_name,
			   (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) AS member_count,
			   (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS message_count
			 FROM channels c
			 LEFT JOIN users owner ON owner.id = c.created_by
				 WHERE c.deleted_at IS NULL AND c.kind IN ('public', 'private')
				 ORDER BY CASE WHEN c.name = 'general' THEN 0 ELSE 1 END, c.created_at DESC`,
		)
		.all();
	return results.map((row) => mapAdminChannel(row, includeAvatar));
}

export async function listChannelMembers(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT cm.user_id, cm.role, cm.joined_at, u.username, u.display_name, u.avatar_key,
			        u.is_super_admin, u.is_disabled, u.disabled_until
			 FROM channel_members cm
			 JOIN users u ON u.id = cm.user_id
			 WHERE cm.channel_id = ? AND u.deleted_at IS NULL
			 ORDER BY CASE cm.role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name ASC`,
		)
		.bind(Number(channelId))
		.all();
	return results.map((row) => ({
		id: Number(row.user_id),
		username: row.username,
		displayName: row.display_name,
		avatarUrl: row.avatar_key ? publicFileUrl(row.avatar_key) : "",
		isAdmin: Boolean(Number(row.is_super_admin)),
		isDisabled: isUserDisabled(row),
		role: row.role,
		joinedAt: row.joined_at,
	}));
}
