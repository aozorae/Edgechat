import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Hono } from "hono";
import initSqlJs from "sql.js";
import worker from "../worker/src/index.js";
import { createSession, putSession } from "../worker/src/auth.js";
import { registerMessageRoutes } from "../worker/src/api/messages.js";
import { listVisibleChannels } from "../worker/src/data/channels.js";
import { listUserDms } from "../worker/src/data/dm-queries.js";
import { getPinnedMessage } from "../worker/src/data/pins.js";
import { markRoomRead } from "../worker/src/data/unread.js";
import { AUTHORIZATION_COLUMNS, AUTHORIZATION_JOIN } from "../worker/src/rbac/authorization.ts";
import { useChatSidebar } from "../frontend/src/composables/useChatSidebar.js";
import { requestDemo } from "../frontend/src/demo/api.js";
import { demoState, resetDemoState } from "../frontend/src/demo/state.js";
import { createD1Adapter, createKvAdapter } from "./support/d1.js";

const SQL = await initSqlJs();
const schema = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");

function fixture(t) {
	const database = new SQL.Database();
	database.exec(schema);
	database.run(`INSERT INTO users (id, username, display_name, password_hash, password_salt)
	 VALUES (1, 'alice', 'Alice', 'hash', 'salt'), (2, 'bob', 'Bob', 'hash', 'salt')`);
	const adapter = createD1Adapter(database);
	const calls = [];
	let beforeQuery = async () => {};
	const env = {
		DB: {
			...adapter,
			prepare(sql) {
				function statement(binds = []) {
					const original = adapter.prepare(sql).bind(...binds);
					return {
						...original,
						bind(...values) { return statement(values); },
						async all() {
							calls.push({ sql, binds });
							await beforeQuery(sql);
							return original.all();
						},
						async run() {
							calls.push({ sql, binds });
							await beforeQuery(sql);
							return original.run();
						},
					};
				}
				return statement();
			},
		},
		SESSIONS: createKvAdapter(),
	};
	const generalId = Number(database.exec("SELECT id FROM channels WHERE name = 'general'")[0].values[0][0]);
	function message(channelId, { senderId = 2, mentions = [], replyTo = null, deleted = false, time = "2026-10-23 12:00:00" } = {}) {
		database.run(`INSERT INTO messages (channel_id, sender_id, sender_kind, content, mention_user_ids, reply_to_sender_id, deleted_at, created_at)
		 VALUES (?, ?, ?, 'hello', ?, ?, ?, ?)`, [channelId, senderId, senderId === null ? "external" : "local", JSON.stringify(mentions), replyTo, deleted ? time : null, time]);
		return Number(database.exec("SELECT last_insert_rowid()")[0].values[0][0]);
	}
	function room(kind, name, members = [1, 2]) {
		database.run("INSERT INTO channels (kind, name, dm_key) VALUES (?, ?, ?)", [kind, name, kind === "dm" ? name : null]);
		const id = Number(database.exec("SELECT last_insert_rowid()")[0].values[0][0]);
		for (const userId of members) database.run("INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)", [id, userId, userId === 1 ? "owner" : "member"]);
		return id;
	}
	t.after(() => database.close());
	return { database, env, calls, generalId, message, room, setBeforeQuery(fn) { beforeQuery = fn; } };
}

async function webSession(h) {
	const user = await h.env.DB.prepare(`SELECT u.*, ${AUTHORIZATION_COLUMNS} FROM users u ${AUTHORIZATION_JOIN} WHERE u.id = 1`).first();
	return createSession(h.env, user);
}

function request(h, token, path) {
	return worker.fetch(new Request(`https://loading.test/api${path}`, { headers: { Authorization: `Bearer ${token}` } }), h.env, { waitUntil() {} });
}

test("会话恢复复用鉴权用户查询，未变更不写 KV，资料变更只写一次", async (t) => {
	const h = fixture(t);
	const session = await webSession(h);
	let writes = 0;
	const originalPut = h.env.SESSIONS.put;
	h.env.SESSIONS.put = async (...args) => { writes += 1; return originalPut(...args); };
	for (const changed of [false, true, false]) {
		if (changed) h.database.run("UPDATE users SET display_name = 'Updated', bio = 'About', avatar_key = NULL WHERE id = 1");
		h.calls.length = 0;
		const response = await request(h, session.token, "/auth/session");
		assert.equal(response.status, 200);
		const restored = (await response.json()).session;
		assert.equal(restored.displayName, writes ? "Updated" : "Alice");
		assert.equal(h.calls.filter(({ sql }) => /FROM users u/.test(sql)).length, 1);
		assert.equal(h.calls.some(({ sql }) => /SELECT display_name, avatar_key, bio/.test(sql)), false);
		assert.equal(writes, changed || restored.displayName === "Updated" ? 1 : 0);
	}
	assert.equal(writes, 1);
});

for (const change of ["is_disabled = 1", "deleted_at = CURRENT_TIMESTAMP", "session_version = session_version + 1"]) {
	test(`合并用户读取后仍实时拒绝失效会话：${change}`, async (t) => {
		const h = fixture(t);
		const session = await webSession(h);
		h.database.run(`UPDATE users SET ${change} WHERE id = 1`);
		assert.equal((await request(h, session.token, "/auth/session")).status, 401);
		assert.equal(await h.env.SESSIONS.get(session.token), null);
	});
}

test("移动会话刷新资料仍保留原 access token 截止时间", async (t) => {
	const h = fixture(t);
	const session = { ...await webSession(h), expiresAt: new Date(Date.now() + 1800000).toISOString(), deviceSessionId: "device-1" };
	h.database.run(`INSERT INTO device_sessions (id, user_id, installation_id, device_name, refresh_token_hash, session_version, expires_at)
	 VALUES ('device-1', 1, 'install-1', 'android', 'digest', 0, datetime('now', '+1 day'))`);
	await putSession(h.env, session);
	h.database.run("UPDATE users SET display_name = 'Changed' WHERE id = 1");
	let options;
	const originalPut = h.env.SESSIONS.put;
	h.env.SESSIONS.put = async (key, value, ttl) => { options = ttl; return originalPut(key, value); };
	assert.equal((await request(h, session.token, "/auth/session")).status, 200);
	assert.ok(options.expirationTtl <= 1800);
	assert.equal(JSON.parse(await h.env.SESSIONS.get(session.token)).expiresAt, session.expiresAt);
});

test("bootstrap 和独立群列表只读，系统群成员仍由 schema 触发器提供", async (t) => {
	const h = fixture(t);
	const session = await webSession(h);
	for (const path of ["/bootstrap", "/channels"]) {
		h.calls.length = 0;
		const response = await request(h, session.token, path);
		assert.equal(response.status, 200);
		const general = (await response.json()).channels.find((channel) => channel.isGeneral);
		assert.equal(general.isMember, true);
		assert.equal(h.calls.some(({ sql }) => /INSERT|UPDATE|DELETE/.test(sql)), false);
	}
});

function historyApp(h) {
	const app = new Hono();
	app.use("*", async (c, next) => { c.set("session", { userId: 1 }); await next(); });
	registerMessageRoutes(app);
	const waits = [];
	return {
		waits,
		get(query = "", roomId = h.generalId) {
			return app.fetch(new Request(`https://history.test/api/messages?kind=public&roomId=${roomId}${query}`), h.env,
				{ waitUntil(promise) { waits.push(promise); } });
		},
	};
}

test("已读写被挂起时历史立即返回，后台只确认响应快照的最高消息", { timeout: 3000 }, async (t) => {
	const h = fixture(t);
	const first = h.message(h.generalId);
	const latest = h.message(h.generalId);
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	t.after(() => release());
	h.setBeforeQuery(async (sql) => { if (sql.startsWith("INSERT INTO message_reads")) await gate; });
	const app = historyApp(h);
	const response = await app.get();
	assert.equal(response.status, 200);
	assert.deepEqual((await response.json()).messages.map(({ id }) => id), [first, latest]);
	assert.equal(app.waits.length, 1);
	const unseen = h.message(h.generalId);
	release();
	await Promise.all(app.waits);
	assert.ok(unseen > latest);
	assert.equal((await h.env.DB.prepare("SELECT last_read_message_id FROM message_reads").first()).last_read_message_id, latest);
	assert.equal(h.calls.filter(({ sql }) => sql.startsWith("INSERT INTO message_reads")).length, 1);
});

test("旧页、空房间和拒绝访问不提交隐式已读", async (t) => {
	const h = fixture(t);
	const first = h.message(h.generalId);
	const latest = h.message(h.generalId);
	const app = historyApp(h);
	const old = await app.get(`&before=${latest}`);
	assert.deepEqual((await old.json()).messages.map(({ id }) => id), [first]);
	assert.equal((await app.get("", h.room("public", "empty"))).status, 200);
	assert.equal((await app.get("", h.room("public", "unjoined", [2]))).status, 403);
	assert.equal(app.waits.length, 0);
	assert.equal(h.calls.some(({ sql }) => sql.startsWith("INSERT INTO message_reads")), false);
});

test("后台已读失败不会让历史请求失败", async (t) => {
	const h = fixture(t);
	h.message(h.generalId);
	h.setBeforeQuery(async (sql) => { if (sql.startsWith("INSERT INTO message_reads")) throw new Error("private database detail"); });
	const app = historyApp(h);
	const response = await app.get();
	assert.equal(response.status, 200);
	assert.equal((await response.json()).messages.length, 1);
	await Promise.all(app.waits);
});

test("单条 SQL 解析并写入已读水位，乱序、删除和跨房间 ID 不会回退或越界", async (t) => {
	const h = fixture(t);
	const a = h.message(h.generalId);
	const b = h.message(h.generalId);
	const deleted = h.message(h.generalId, { deleted: true });
	const other = h.message(h.room("private", "other"));
	const read = (messageId) => markRoomRead(h.env.DB, { channelId: h.generalId, userId: 1, messageId });
	assert.equal(await read(b), b);
	assert.equal(await read(a), b);
	assert.equal(await read(deleted), b);
	assert.equal(await read(other), b);
	assert.equal(await read(null), b);
	assert.equal(h.calls.length, 5);
	assert.ok(h.calls.every(({ sql }) => sql.includes("RETURNING last_read_message_id")));
});

test("置顶查询一次往返完成完整消息投影", async (t) => {
	const h = fixture(t);
	const id = h.message(h.generalId);
	h.database.run("INSERT INTO channel_pins (channel_id, message_id, pinned_by) VALUES (?, ?, 1)", [h.generalId, id]);
	assert.equal((await getPinnedMessage(h.env, h.generalId)).id, id);
	assert.equal(h.calls.length, 1);
	assert.equal(await getPinnedMessage(h.env, h.room("public", "no-pin")), null);
});

test("点击会话仅更新选择与本地未读，不再另发已读请求", async () => {
	const selected = [];
	const sidebar = useChatSidebar({
		applyActiveChannel: (value) => selected.push(value), selectDm: (value) => selected.push(value),
		sidebarApi: { markRoomRead() { assert.fail("重复的已读请求"); } },
	});
	for (const kind of ["public", "dm"]) {
		const source = { id: 1, kind, unreadCount: 2, mentionUnreadCount: 1 };
		(kind === "dm" ? sidebar.dms : sidebar.channels).value = [source];
		await sidebar.openConversation({ kind, id: 1, source });
		assert.equal((kind === "dm" ? sidebar.dms : sidebar.channels).value[0].unreadCount, 0);
	}
	assert.equal(selected.length, 2);
});

test("demo 首屏历史承担进入会话的已读确认，旧页不清除未读", async () => {
	resetDemoState();
	const channel = demoState.channels.find((item) => item.isMember);
	channel.unreadCount = 3;
	channel.mentionUnreadCount = 1;
	const path = `/messages?kind=${channel.kind}&roomId=${channel.id}`;
	await requestDemo(`${path}&before=1`);
	assert.equal(channel.unreadCount, 3);
	assert.ok((await requestDemo(path)).messages.length > 0);
	assert.equal(channel.unreadCount, 0);
	assert.equal(channel.mentionUnreadCount, 0);
});

test("群和 DM 列表保留可见性及未读语义，合并聚合使用消息水位索引", async (t) => {
	const h = fixture(t);
	const privateId = h.room("private", "joined");
	const dmId = h.room("dm", "1:2");
	const publicId = h.room("public", "not-joined", [2]);
	const hiddenId = h.room("private", "hidden", [2]);
	for (const id of [h.generalId, privateId, dmId, publicId, hiddenId]) {
		const readThrough = h.message(id, { mentions: [1], replyTo: 1 });
		h.database.run("INSERT INTO message_reads (channel_id, user_id, last_read_message_id) VALUES (?, 1, ?)", [id, readThrough]);
		h.message(id, { senderId: 1, mentions: [1], replyTo: 1 });
		h.message(id, { mentions: [1], replyTo: 1 });
		h.message(id, { senderId: null });
		h.message(id, { deleted: true, replyTo: 1 });
	}
	const channels = await listVisibleChannels(h.env.DB, 1);
	assert.equal(channels.some(({ id }) => id === hiddenId), false);
	for (const channel of channels) {
		assert.equal(channel.unreadCount, channel.isMember ? 2 : 0);
		assert.equal(channel.mentionUnreadCount, channel.isMember ? 1 : 0);
	}
	const [dm] = await listUserDms(h.env.DB, 1);
	assert.equal(dm.id, dmId);
	assert.equal(dm.unreadCount, 2);
	assert.equal(dm.mentionUnreadCount, 1);
	const listQueries = h.calls.filter(({ sql }) => sql.startsWith("WITH viewer"));
	assert.equal(listQueries.length, 2, "分别核验群列表和 DM 列表的查询计划");
	for (const { sql, binds } of listQueries) {
		const plan = (await createD1Adapter(h.database).prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all()).results.map(({ detail }) => detail).join("\n");
		assert.match(plan, /SEARCH m USING INDEX idx_messages_channel_created \(channel_id=\? AND id>\?\)/);
		assert.match(plan, /SEARCH m USING (?:COVERING )?INDEX idx_messages_channel_live_time \(channel_id=\?\)/);
		assert.doesNotMatch(plan, /SCAN m\b/);
	}
});

test("会话时间索引迁移幂等，保留存量消息与按时间而非 ID 排序的语义", async (t) => {
	const h = fixture(t);
	h.message(h.generalId, { time: "2026-10-23 15:00:00" });
	h.message(h.generalId, { time: "2026-10-23 12:00:00" });
	const before = h.database.exec("SELECT * FROM messages");
	h.database.exec("DROP INDEX idx_messages_channel_live_time");
	const migration = readFileSync(new URL("../worker/migrations/2026-10-23-conversation-query-index.sql", import.meta.url), "utf8");
	h.database.exec(migration);
	h.database.exec(migration);
	assert.deepEqual(h.database.exec("SELECT * FROM messages"), before);
	assert.equal((await listVisibleChannels(h.env.DB, 1)).find(({ id }) => id === h.generalId).lastMessageAt, "2026-10-23 15:00:00");
});
