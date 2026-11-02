import { AUTHORIZATION_COLUMNS, AUTHORIZATION_JOIN } from "../rbac/authorization.ts";

interface Statement {
	bind(...values: (string | number)[]): Statement;
	all(): Promise<{ results: SessionState[] }>;
}

interface Database {
	prepare(sql: string): Statement;
}

interface RoomTarget {
	id: number;
	kind: string;
}

interface SessionState {
	username: string;
	is_disabled: number;
	disabled_until: string | null;
	deleted_at: string | null;
	session_version: number;
	is_super_admin: number;
	device_session_version?: number | null;
	room_id?: number | null;
	room_name?: string;
	room_description?: string;
	room_avatar_key?: string | null;
	room_kind?: string;
	room_dm_key?: string | null;
}

export async function readSessionState(
	db: Database,
	session: { userId: number; deviceSessionId?: string },
	{ management = false, profile = false, room = null }: {
		management?: boolean;
		profile?: boolean;
		room?: RoomTarget | null;
	} = {},
): Promise<SessionState | undefined> {
	const device = Boolean(session.deviceSessionId);
	// 同一快照读取用户、设备撤销和房间成员，不在连接上缓存授权；LEFT JOIN 保留失效原因的区分。
	const { results } = await db.prepare(
		`SELECT u.username, u.is_disabled, u.disabled_until, u.deleted_at, u.session_version, u.is_super_admin
		   ${profile ? ", u.display_name, u.avatar_key, u.bio" : ""}
		   ${management ? `, ${AUTHORIZATION_COLUMNS}` : ""}
		   ${device ? ", ds.session_version AS device_session_version" : ""}
		   ${room ? `, c.id AS room_id, c.name AS room_name, c.description AS room_description,
		     c.avatar_key AS room_avatar_key, c.kind AS room_kind, c.dm_key AS room_dm_key` : ""}
		 FROM users u ${management ? AUTHORIZATION_JOIN : ""}
		 ${device ? `LEFT JOIN device_sessions ds ON ds.id = ? AND ds.user_id = u.id
		   AND ds.revoked_at IS NULL AND ds.expires_at > CURRENT_TIMESTAMP` : ""}
		 ${room ? `LEFT JOIN channels c ON c.id = ? AND c.kind = ? AND c.deleted_at IS NULL
		   AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = u.id)` : ""}
		 WHERE u.id = ? LIMIT 1`,
	).bind(
		...(device ? [String(session.deviceSessionId)] : []),
		...(room ? [Number(room.id), room.kind] : []),
		session.userId,
	).all();
	return results[0];
}
