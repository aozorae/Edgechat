import assert from "node:assert/strict";
import test from "node:test";

import {
	listAdminChannels,
	listChannelMembers,
	listVisibleChannels,
} from "../worker/src/data/channels.js";
import { listAdminDms, listUserDms } from "../worker/src/data/dm-queries.js";
import { listMessages, mapMessage } from "../worker/src/data/messages.js";
import { getSiteSettings } from "../worker/src/data/site-settings.js";
import { countUnreadMessages, listRoomMemberIds } from "../worker/src/data/unread.js";
import { listAdminUsers } from "../worker/src/data/users.js";

function createQueryDb(results) {
	const capture = { sql: "", binds: [] };
	return {
		capture,
		db: {
			prepare(sql) {
				capture.sql = sql;
				return {
					bind(...binds) {
						capture.binds = binds;
						return this;
					},
					async all() {
						return { results };
					},
				};
			},
		},
	};
}

test("可见频道查询复用单个身份绑定与合并关注 projection", async () => {
	const { db, capture } = createQueryDb([
			{
				id: "9",
				name: "General",
				description: "",
				avatar_key: "avatars/a b.png",
				kind: "public",
				is_general: 1,
				owner_display_name: "Owner",
			is_member: 1,
			my_role: "member",
			can_manage: 0,
			member_count: "3",
			last_message_at: null,
				unread_count: "2",
					attention_unread_count: "1",
		},
	]);

	const channels = await listVisibleChannels(db, "7");

	assert.deepEqual(capture.binds, [7]);
	assert.deepEqual(channels[0], {
		id: 9,
			name: "General",
			description: "",
			avatarKey: "avatars/a b.png",
			avatarUrl: "/files/avatars%2Fa%20b.png",
			kind: "public",
			isGeneral: true,
			ownerDisplayName: "Owner",
		isMember: true,
		myRole: "member",
		canManage: false,
		memberCount: 3,
		lastMessageAt: null,
		unreadCount: 2,
		mentionUnreadCount: 1,
	});
	assert.match(capture.sql, /CASE WHEN c\.name = 'general' THEN 0 ELSE 1 END/);
});

	test("overview 频道 projection 不额外暴露头像字段", async () => {
		const { db, capture } = createQueryDb([
			{
				id: 1,
				name: "General",
				description: "",
				avatar_key: "secret-key",
				kind: "public",
				is_general: 1,
			created_at: "2026-07-23",
			owner_display_name: null,
			member_count: 2,
			message_count: 4,
		},
	]);

	const [channel] = await listAdminChannels(db, { includeAvatar: false });
	assert.equal("avatarKey" in channel, false);
	assert.equal("avatarUrl" in channel, false);
	assert.equal(channel.ownerDisplayName, "未知");
	assert.equal(channel.isGeneral, true);
	assert.match(capture.sql, /CASE WHEN c\.name = 'general' THEN 0 ELSE 1 END/);
});

test("DM 查询复用单个身份绑定计算拉黑与回复关注计数", async () => {
	const { db, capture } = createQueryDb([]);
	await listUserDms(db, "12");
	assert.deepEqual(capture.binds, [12]);
});

test("后台 DM projection 保持参与者、计数与时间字段", async () => {
	const { db } = createQueryDb([
		{
			id: "8",
			dm_key: "2:9",
			participants: "Alice / Bob",
			created_at: "2026-07-23",
			message_count: "4",
		},
	]);
	assert.deepEqual(await listAdminDms(db), [
		{
			id: 8,
			name: "2:9",
			participants: "Alice / Bob",
			createdAt: "2026-07-23",
			messageCount: 4,
		},
	]);
});

test("后台用户与频道成员 projection 保持稳定字段", async () => {
	const adminUsers = createQueryDb([
		{
			id: "2",
			username: "alice",
			display_name: "Alice",
			avatar_key: "a.png",
			is_disabled: "1",
			disabled_until: null,
			created_at: "2026-07-23",
		},
	]);
	assert.deepEqual((await listAdminUsers(adminUsers.db))[0], {
		id: 2,
		username: "alice",
		displayName: "Alice",
		avatarUrl: "/files/a.png",
		isDisabled: true,
		isPermanentlyDisabled: true,
		disabledUntil: null,
		createdAt: "2026-07-23",
		isAdmin: false, isSuperAdmin: false, canAccessAdmin: false, managementProtected: false,
    authzVersion: 0, roleRevision: 0, role: null,
	});

	const members = createQueryDb([
		{
			user_id: "2",
			username: "alice",
			display_name: "Alice",
			avatar_key: null,
			is_super_admin: "1",
			is_disabled: "0",
			disabled_until: null,
			role: "owner",
			joined_at: "2026-07-23",
		},
	]);
	assert.deepEqual((await listChannelMembers(members.db, "6"))[0], {
		id: 2,
		username: "alice",
		displayName: "Alice",
		avatarUrl: "",
		isAdmin: true,
		isDisabled: false,
		role: "owner",
		joinedAt: "2026-07-23",
	});
	assert.deepEqual(members.capture.binds, [6]);
});

test("消息查询保持倒序 SQL、绑定顺序与升序 projection", async () => {
	const { db, capture } = createQueryDb([
		{
			id: "5",
			content: "new",
			created_at: "later",
			sender_id: 2,
			sender_username: "alice",
			sender_display_name: "Alice",
		},
		{
			id: "4",
			content: "old",
			created_at: "earlier",
			sender_id: 2,
			sender_username: "alice",
			sender_display_name: "Alice",
		},
	]);
	const messages = await listMessages({ DB: db }, "3", "9", "20");
	assert.deepEqual(capture.binds, [3, 9, 20]);
	assert.match(capture.sql, /ORDER BY m\.id DESC LIMIT \?/);
	assert.deepEqual(messages.map((message) => message.id), [4, 5]);
});

test("未读查询绑定稳定，成员 projection 排除禁用和删除用户", async () => {
	const unread = createQueryDb([{ unread_count: "7" }]);
	assert.equal(await countUnreadMessages(unread.db, { channelId: "3", userId: "2" }), 7);
	assert.deepEqual(unread.capture.binds, [3, 2, 3, 2]);

	const members = createQueryDb([{ user_id: "2" }, { user_id: "invalid" }]);
	assert.deepEqual(await listRoomMemberIds(members.db, "3"), [2]);
	assert.deepEqual(members.capture.binds, [3]);
	assert.match(members.capture.sql, /JOIN users u ON u\.id = cm\.user_id/);
	assert.match(members.capture.sql, /u\.is_disabled = 0/);
});

test("站点设置 projection 使用稳定默认值", async () => {
	const configured = createQueryDb([
		{ setting_key: "site_name", setting_value: "CFChat" },
		{ setting_key: "site_icon_url", setting_value: "/icon.png" },
	]);
	assert.deepEqual(await getSiteSettings(configured.db), {
		siteName: "CFChat",
		siteIconUrl: "/icon.png",
		colorTheme: "default",
	});
	const defaults = createQueryDb([]);
	assert.deepEqual(await getSiteSettings(defaults.db), {
		siteName: "Edgechat",
		siteIconUrl: "",
		colorTheme: "default",
	});
});

test("消息 projection 保持附件和发送者字段", () => {
	assert.deepEqual(
		mapMessage({
			id: "5",
			content: "hello",
			mentions_json: "[]",
			created_at: "2026-07-23",
			sender_id: "2",
			sender_username: "alice",
			sender_display_name: "Alice",
			sender_is_admin: "1",
			sender_is_disabled: "0",
			sender_disabled_until: "2099-01-01T00:00:00.000Z",
			sender_avatar_key: "avatar.png",
			attachment_key: "files/a b.txt",
			attachment_name: "a b.txt",
			attachment_type: "text/plain",
			attachment_size: "10",
			attachment_kind: null,
			attachment_duration_ms: null,
			attachment_waveform: null,
			source_attachment_id: null,
			source_attachment_unique_id: null,
		}),
		{
			id: 5,
			content: "hello",
			mentionUserIds: [],
			mentions: [],
			createdAt: "2026-07-23",
			source: "edgechat",
			sender: {
				kind: "local",
				id: 2,
				username: "alice",
				displayName: "Alice",
				avatarUrl: "/files/avatar.png",
				isAdmin: true,
				isDisabled: true,
				source: "edgechat",
			},
			attachment: {
				key: "files/a b.txt",
				name: "a b.txt",
				type: "text/plain",
				size: 10,
				url: "/files/files%2Fa%20b.txt",
			},
		},
	);
});

test("语音消息 projection 保留时长与压缩波形", () => {
	const message = mapMessage({
		id: 6,
		content: "",
		mentions_json: "[]",
		mention_user_ids: "[]",
		created_at: "2026-09-02",
		sender_id: 2,
		sender_username: "alice",
		sender_display_name: "Alice",
		attachment_key: "files/voice.ogg",
		attachment_name: "voice.ogg",
		attachment_type: "audio/ogg",
		attachment_size: 2048,
		attachment_kind: "voice",
		attachment_duration_ms: 8400,
		attachment_waveform: "[12,45,90]",
	});
	assert.deepEqual(message.attachment, {
		key: "files/voice.ogg",
		name: "voice.ogg",
		type: "audio/ogg",
		size: 2048,
		url: "/files/files%2Fvoice.ogg",
		kind: "voice",
		durationMs: 8400,
		waveform: [12, 45, 90],
	});
});
