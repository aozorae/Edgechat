import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import { createSession, putSession } from "../worker/src/auth.js";
import { ChannelRoom } from "../worker/src/do/ChannelRoom.js";
import { validateSession } from "../worker/src/session.js";
import { createMessageSubmission, submitRoomMessageIdempotent } from "../worker/src/message-submission.js";
import { getMessageById, insertMessageIdempotent } from "../worker/src/data/messages.js";
import { createD1Adapter, createKvAdapter } from "./support/d1.js";

const SQL = await initSqlJs();
const schema = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");

function fixture(t, kind = "private") {
	const database = new SQL.Database();
	database.exec(schema);
	database.run(`INSERT INTO users (id, username, display_name, password_hash, password_salt)
	 VALUES (1, 'alice', 'Alice', 'hash', 'salt'), (2, 'bob', 'Bob', 'hash', 'salt')`);
	database.run("INSERT INTO channels (id, name, kind, dm_key) VALUES (10, 'Test', ?, ?)", [kind, kind === "dm" ? "1:2" : null]);
	database.run("INSERT INTO channel_members (channel_id, user_id, role) VALUES (10, 1, 'owner'), (10, 2, 'member')");
	const adapter = createD1Adapter(database);
	const calls = [];
	let afterBatch = () => {};
	const env = {
		DB: {
			prepare(sql) {
				function statement(binds = []) {
					const native = adapter.prepare(sql).bind(...binds);
					return {
						native, sql,
						bind(...values) { return statement(values); },
						async all() { calls.push({ sql, binds }); return native.all(); },
						async run() { calls.push({ sql, binds }); return native.run(); },
					};
				}
				return statement();
			},
			async batch(statements) {
				calls.push({ batch: statements.map(({ sql }) => sql) });
				const results = await adapter.batch(statements.map(({ native }) => native));
				await afterBatch();
				return results;
			},
		},
		SESSIONS: createKvAdapter(),
		EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({ activeKeyId: "test", keys: { test: Buffer.alloc(32, 7).toString("base64") } }),
	};
	let kvReads = 0;
	const get = env.SESSIONS.get;
	env.SESSIONS.get = async token => { kvReads++; return get(token); };
	const room = new ChannelRoom({ getWebSockets: () => [] }, env);
	const projections = [];
	room.runMessageProjections = (...args) => projections.push(args);
	async function session(userId = 1, device = false) {
		const user = (await adapter.prepare("SELECT * FROM users WHERE id = ?").bind(userId).all()).results[0];
		const value = await createSession(env, user);
		if (device) {
			value.deviceSessionId = crypto.randomUUID();
			database.run(`INSERT INTO device_sessions (id, user_id, installation_id, device_name, refresh_token_hash, session_version, expires_at)
			 VALUES (?, ?, 'installation', 'device', ?, 0, datetime('now', '+1 day'))`,
			[value.deviceSessionId, userId, crypto.randomUUID()]);
			await putSession(env, value);
		}
		return value;
	}
	function socket(value) {
		const frames = [];
		const closed = [];
		const meta = { token: value.token, principal: { userId: value.userId }, room: { id: 10, kind } };
		const ws = { frames, closed, send: packet => frames.push(JSON.parse(packet)), close: (...args) => closed.push(args),
			serializeAttachment(next) { this.attachment = next; }, deserializeAttachment() { return this.attachment || meta; } };
		room.connections.set(ws, meta);
		return ws;
	}
	t.after(() => database.close());
	return {
		database, env, calls, room, projections, session, socket,
		kvReads: () => kvReads,
		setAfterBatch(fn) { afterBatch = fn; },
		send(ws, payload = {}) {
			return room.webSocketMessage(ws, JSON.stringify({ type: "send", content: "hello", clientMessageId: crypto.randomUUID(), ...payload }));
		},
	};
}

for (const device of [false, true]) {
	test(`单连接发送 ${device ? "设备" : "网页"} 消息：两次实时鉴权、4 次 D1 往返`, async t => {
		const h = fixture(t);
		const ws = h.socket(await h.session(1, device));
		await h.send(ws);
		assert.equal(ws.frames.length, 1);
		assert.equal(ws.frames[0].message.content, "hello");
		assert.equal(h.kvReads(), 2, "入站与广播分别读取 KV，不复用发送前的授权");
		assert.equal(h.calls.length, 4);
		assert.equal(h.calls.filter(call => call.batch).length, 1);
		assert.equal(h.calls.filter(({ sql }) => sql?.includes("FROM users u")).length, 2);
		assert.equal(h.projections.length, 1);
		assert.equal(ws.attachment.room.name, "Test");
	});
}

const mutations = {
	"永久封禁": "UPDATE users SET is_disabled = 1 WHERE id = 1",
	"临时封禁": "UPDATE users SET disabled_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour') WHERE id = 1",
	"软删除": "UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = 1",
	"会话版本撤销": "UPDATE users SET session_version = session_version + 1 WHERE id = 1",
	"退出登录": null,
	"退群": "DELETE FROM channel_members WHERE channel_id = 10 AND user_id = 1",
	"房间删除": "UPDATE channels SET deleted_at = CURRENT_TIMESTAMP WHERE id = 10",
};
for (const [name, sql] of Object.entries(mutations)) {
	for (const action of ["send", "broadcast"]) {
		test(`${name} 后下一次 ${action} 拒绝旧休眠连接`, async t => {
			const h = fixture(t);
			const value = await h.session();
			const ws = h.socket(value);
			const meta = h.room.connections.get(ws);
			// 用休眠附件重新构建 DO，确保不能依赖实例内授权缓存。
			h.room.connections.clear();
			h.room.connections = new ChannelRoom({ getWebSockets: () => [ws] }, h.env).connections;
			assert.deepEqual(h.room.connections.get(ws), meta);
			if (sql) h.database.run(sql);
			else await h.env.SESSIONS.delete(value.token);
			if (action === "send") await h.send(ws);
			else await h.room.broadcast(JSON.stringify({ type: "message", message: { content: "secret" } }));
			assert.equal(ws.frames.length, 0);
			assert.equal(ws.closed[0][0], 1008);
			assert.equal(h.room.connections.has(ws), false);
			assert.equal(h.database.exec("SELECT COUNT(*) FROM messages")[0].values[0][0], 0);
			if (name === "退群" || name === "房间删除") assert.ok(await h.env.SESSIONS.get(value.token), "房间撤权不删除登录");
		});
	}
}

for (const change of [
	"revoked_at = CURRENT_TIMESTAMP", "expires_at = datetime('now', '-1 second')",
	"session_version = 5", "user_id = 2",
]) {
	test(`设备失效 ${change}：会话、发送和广播均拒绝`, async t => {
		const h = fixture(t);
		const value = await h.session(1, true);
		h.database.run(`UPDATE device_sessions SET ${change} WHERE id = ?`, [value.deviceSessionId]);
		assert.equal((await validateSession(h.env, value.token)).ok, false);
		assert.equal(h.calls.length, 1);
		for (const action of ["send", "broadcast"]) {
			await putSession(h.env, value);
			const ws = h.socket(value);
			if (action === "send") await h.send(ws);
			else await h.room.broadcast("{}");
			assert.equal(ws.frames.length, 0);
			assert.equal(ws.closed[0][0], 1008);
		}
	});
}

test("广播内同 token 去重，不同 token 隔离，下一轮重新校验", async t => {
	const h = fixture(t);
	const value = await h.session();
	const first = h.socket(value);
	const second = h.socket(value);
	const other = await h.session();
	const third = h.socket(other);
	await h.env.SESSIONS.delete(other.token);
	await h.room.broadcast("{}");
	assert.equal(h.kvReads(), 2);
	assert.equal(h.calls.length, 1);
	assert.equal(first.frames.length, 1);
	assert.equal(second.frames.length, 1);
	assert.equal(third.frames.length, 0);
	assert.equal(third.closed[0][0], 1008);
	await h.env.SESSIONS.delete(value.token);
	await h.room.broadcast("{}");
	assert.equal(h.kvReads(), 3);
	assert.equal(first.frames.length, 1);
	assert.equal(second.frames.length, 1);
	assert.equal(first.closed[0][0], 1008);
	assert.equal(second.closed[0][0], 1008);
});

test("相同 token 不同房间不共享成员授权", async t => {
	const h = fixture(t);
	const value = await h.session();
	const allowed = h.socket(value);
	const forbidden = h.socket(value);
	h.room.connections.get(forbidden).room.id = 999;
	await h.room.broadcast("{}");
	assert.equal(allowed.frames.length, 1);
	assert.equal(forbidden.frames.length, 0);
	assert.equal(forbidden.closed[0][0], 1008);
	assert.equal(h.calls.length, 2);
});

test("已过期的临时封禁可访问，错误房间类型与管理员非成员均不可访问", async t => {
	const h = fixture(t);
	const value = await h.session();
	h.database.run("UPDATE users SET disabled_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') WHERE id = 1");
	assert.equal((await validateSession(h.env, value.token, { room: { id: 10, kind: "private" } })).ok, true);
	assert.equal((await validateSession(h.env, value.token, { room: { id: 10, kind: "dm" } })).ok, false);
	h.database.run("UPDATE users SET is_super_admin = 1 WHERE id = 1");
	h.database.run("DELETE FROM channel_members WHERE channel_id = 10 AND user_id = 1");
	assert.equal((await validateSession(h.env, value.token, { room: { id: 10, kind: "private" } })).ok, false);
});

for (const change of ["logout", "membership", "ban"]) {
	test(`写入后 ${change} 仍由广播复验拒绝发送者，不阻塞合法收件人`, async t => {
		const h = fixture(t);
		const value = await h.session();
		const sender = h.socket(value);
		const recipient = h.socket(await h.session(2));
		h.setAfterBatch(async () => {
			if (change === "logout") await h.env.SESSIONS.delete(value.token);
			if (change === "membership") h.database.run("DELETE FROM channel_members WHERE channel_id = 10 AND user_id = 1");
			if (change === "ban") h.database.run("UPDATE users SET is_disabled = 1 WHERE id = 1");
		});
		await h.send(sender);
		assert.equal(sender.frames.length, 0);
		assert.equal(sender.closed[0][0], 1008);
		assert.equal(recipient.frames.length, 1);
		assert.equal(h.projections.length, 1);
	});
}

test("慢连接校验不延迟其他连接收到广播", { timeout: 3000 }, async t => {
	const h = fixture(t);
	const fast = h.socket(await h.session());
	const slowValue = await h.session(2);
	const slow = h.socket(slowValue);
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	t.after(() => release());
	const get = h.env.SESSIONS.get;
	h.env.SESSIONS.get = async token => { if (token === slowValue.token) await gate; return get(token); };
	let delivered;
	const received = new Promise(resolve => { delivered = resolve; });
	const send = fast.send;
	fast.send = packet => { send(packet); delivered(); };
	const pending = h.room.broadcast("{}");
	await received;
	assert.equal(fast.frames.length, 1);
	assert.equal(slow.frames.length, 0);
	release();
	await pending;
	assert.equal(slow.frames.length, 1);
});

test("单个收件人 KV 失败不泄露正文、不影响其他连接及消息投影", async t => {
	const h = fixture(t);
	const sender = h.socket(await h.session());
	const failedValue = await h.session(2);
	const failed = h.socket(failedValue);
	const get = h.env.SESSIONS.get;
	h.env.SESSIONS.get = async token => {
		if (token === failedValue.token) throw new Error("private KV failure");
		return get(token);
	};
	await h.send(sender);
	assert.equal(sender.frames.length, 1);
	assert.equal(sender.frames[0].type, "message");
	assert.equal(failed.frames.length, 0);
	assert.equal(h.projections.length, 1);
});

for (const change of ["logout", "membership", "ban", "device"]) {
	test(`幂等补确认的读取期间 ${change}，仍不能返回旧正文`, async t => {
		const h = fixture(t);
		const value = await h.session(1, change === "device");
		const sender = h.socket(value);
		const clientMessageId = crypto.randomUUID();
		await h.send(sender, { clientMessageId });
		const prepare = h.env.DB.prepare;
		h.env.DB.prepare = sql => {
			const query = prepare(sql);
			if (!sql.includes("m.client_message_id = ?")) return query;
			const bind = query.bind;
			query.bind = (...values) => {
				const bound = bind(...values);
				const all = bound.all;
				bound.all = async () => {
					const result = await all();
					if (change === "logout") await h.env.SESSIONS.delete(value.token);
					if (change === "membership") h.database.run("DELETE FROM channel_members WHERE channel_id = 10 AND user_id = 1");
					if (change === "ban") h.database.run("UPDATE users SET is_disabled = 1 WHERE id = 1");
					if (change === "device") h.database.run("UPDATE device_sessions SET revoked_at = CURRENT_TIMESTAMP");
					return result;
				};
				return bound;
			};
			return query;
		};
		await h.send(sender, { clientMessageId });
		assert.equal(sender.frames.length, 1, "只收到第一次发送，撤权后没有补确认");
		assert.equal(sender.closed[0][0], 1008);
		assert.equal(h.projections.length, 1);
	});
}

test("批次回读保留加密正文、提及、回复、语音附件和规范发送者投影", async t => {
	const h = fixture(t);
	const meta = { room: { id: 10, kind: "private" }, principal: { userId: 1 } };
	const original = await submitRoomMessageIdempotent(h.env, meta, { clientMessageId: crypto.randomUUID(), content: "original" });
	const key = "1/voice.webm";
	h.database.run("INSERT INTO uploaded_files (object_key, owner_user_id, created_at) VALUES (?, 1, CURRENT_TIMESTAMP)", [key]);
	const result = await submitRoomMessageIdempotent(h.env, meta, {
		clientMessageId: crypto.randomUUID(), content: "@bob hello", mentionUserIds: [2], replyMessageId: original.message.id,
		attachment: { key, name: "voice.webm", type: "audio/webm", size: 123, kind: "voice", durationMs: 1000, waveform: [0.2, 0.8] },
	});
	assert.equal(result.message.content, "@bob hello");
	assert.equal(result.message.sender.displayName, "Alice");
	assert.equal(result.message.replyTo.content, "original");
	assert.deepEqual(result.message.mentionUserIds, [2]);
	assert.equal(result.message.mentions[0].username, "bob");
	assert.equal(result.message.attachment.kind, "voice");
	assert.deepEqual(result.message, await getMessageById(h.env, result.message.id));
	assert.match(h.database.exec(`SELECT content FROM messages WHERE id = ${result.message.id}`)[0].values[0][0], /^edgechat:enc:/);
});

test("批次回读失败回滚消息和事件，原 ID 可重试", async t => {
	const h = fixture(t);
	const batch = h.env.DB.batch;
	h.env.DB.batch = statements => batch([statements[0], h.env.DB.prepare("SELECT * FROM missing_table")]);
	const payload = { channelId: 10, senderId: 1, content: "hello", clientMessageId: crypto.randomUUID() };
	await assert.rejects(insertMessageIdempotent(h.env, payload), /missing_table/);
	assert.equal(h.database.exec("SELECT COUNT(*) FROM messages")[0].values[0][0], 0);
	assert.equal(h.database.exec("SELECT COUNT(*) FROM message_events")[0].values[0][0], 0);
	h.env.DB.batch = batch;
	assert.equal((await insertMessageIdempotent(h.env, payload)).created, true);
});

test("DM 门禁与幂等查询并行启动，命中旧消息也不能绕过拉黑", async () => {
	const started = [];
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const submit = createMessageSubmission({
		async resolveDmBlockStatus() { started.push("block"); await gate; return { blockedByPeer: true }; },
		async findMessage() { started.push("find"); return { id: 1 }; },
		async persistMessage() { assert.fail("被拉黑不能写入"); },
	});
	const pending = submit({}, { room: { id: 10, kind: "dm" }, principal: { userId: 1 } }, { clientMessageId: "id" });
	assert.deepEqual(started, ["block", "find"]);
	release();
	await assert.rejects(pending, error => error.code === "blocked_by_recipient");
});
