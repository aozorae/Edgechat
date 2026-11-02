import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import { ChannelRoom } from "../worker/src/do/ChannelRoom.js";
import { createD1Adapter } from "./support/d1.js";

const SQL = await initSqlJs();

function fixture(t) {
	const database = new SQL.Database();
	database.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
	database.run("INSERT INTO users (id, username, display_name, password_hash, password_salt) VALUES (1, 'alice', 'Alice', 'hash', 'salt')");
	const roomId = Number(database.exec("SELECT id FROM channels WHERE name = 'general'")[0].values[0][0]);
	const room = new ChannelRoom({ getWebSockets: () => [] }, {
		DB: createD1Adapter(database),
		EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({ activeKeyId: "test", keys: { test: Buffer.alloc(32, 1).toString("base64") } }),
	});
	const meta = { room: { id: roomId, kind: "public" }, principal: { userId: 1 } };
	const frames = [];
	const broadcasts = [];
	const projections = [];
	const socket = { send: packet => frames.push(JSON.parse(packet)) };
	room.connections.set(socket, meta);
	room.revalidateConnection = async () => meta;
	room.broadcast = async packet => { broadcasts.push(JSON.parse(packet)); };
	room.runMessageProjections = (...args) => projections.push(args);
	t.after(() => database.close());
	const send = fields => room.webSocketMessage(socket, JSON.stringify({ type: "send", content: "hello", ...fields }));
	return { database, room, meta, socket, frames, broadcasts, projections, send };
}

test("WebSocket 重试只补发原消息确认，不重复落库、广播或投影", async t => {
	const h = fixture(t);
	const clientMessageId = crypto.randomUUID();
	await h.send({ clientMessageId });
	await h.send({ clientMessageId, content: "changed payload ignored" });
	assert.equal(h.database.exec("SELECT COUNT(*) FROM messages")[0].values[0][0], 1);
	assert.equal(h.broadcasts.length, 1);
	assert.equal(h.projections.length, 1);
	assert.equal(h.frames.length, 1);
	assert.deepEqual(h.frames[0], h.broadcasts[0]);
	assert.equal(h.frames[0].message.clientMessageId, clientMessageId);
	assert.equal(h.frames[0].message.content, "hello");
});

test("回复目标已删除时重试仍确认既有回复，已删除消息不会复活", async t => {
	const h = fixture(t);
	await h.send({});
	const originalId = h.broadcasts[0].message.id;
	const clientMessageId = crypto.randomUUID();
	await h.send({ clientMessageId, replyMessageId: originalId });
	h.database.run("UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", [originalId]);
	await h.send({ clientMessageId, replyMessageId: originalId });
	assert.equal(h.frames.at(-1).type, "message");
	assert.equal(h.frames.at(-1).message.replyTo.deleted, true);
	h.database.run("UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE client_message_id = ?", [clientMessageId]);
	await h.send({ clientMessageId });
	assert.equal(h.frames.at(-1).type, "error");
	assert.equal(h.frames.at(-1).clientMessageId, clientMessageId);
	assert.equal(h.projections.length, 2);
});

test("WebSocket 错误关联 clientMessageId，旧客户端不带 ID 仍可发送", async t => {
	const h = fixture(t);
	const clientMessageId = crypto.randomUUID();
	await h.send({ clientMessageId, content: "" });
	assert.deepEqual(h.frames.at(-1), { protocolVersion: 1, type: "error", error: "消息内容不能为空", clientMessageId });
	await h.send({ clientMessageId: "invalid" });
	assert.equal(h.frames.at(-1).error, "clientMessageId 必须是 UUID");
	await h.send({});
	await h.send({});
	assert.equal(h.broadcasts.length, 2);
	assert.equal(h.projections.length, 2);
});

test("并发重试由数据库唯一约束收敛为一条消息", async t => {
	const h = fixture(t);
	const clientMessageId = crypto.randomUUID();
	await Promise.all([h.send({ clientMessageId }), h.send({ clientMessageId })]);
	assert.equal(h.database.exec("SELECT COUNT(*) FROM messages")[0].values[0][0], 1);
	assert.equal(h.broadcasts.length, 1);
	assert.equal(h.projections.length, 1);
	assert.equal(h.frames[0].message.id, h.broadcasts[0].message.id);
});
