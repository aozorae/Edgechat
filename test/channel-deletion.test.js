import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Hono } from "hono";
import initSqlJs from "sql.js";

import { registerChannelRoutes } from "../worker/src/api/channels.js";
import { hardDeleteChannel } from "../worker/src/data/channel-deletion.ts";
import { ApiError } from "../worker/src/errors.js";
import { runScheduledGc } from "../worker/src/gc.js";
import { createD1Adapter } from "./support/d1.js";

const SQL = await initSqlJs();

function createHarness(isAdmin = false) {
	const database = new SQL.Database();
	database.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
	database.run(
		`INSERT INTO users (id, username, display_name, password_hash, password_salt)
		 VALUES (1, 'owner', 'Owner', 'hash', 'salt'), (2, 'member', 'Member', 'hash', 'salt')`,
	);
	// [打招呼制 2026-11-01] 新契约：建群拉人须互认（1↔2 预置为联系人）
	database.exec("INSERT INTO greet_contacts (a, b) VALUES (1, 2)");
	const deletedFiles = [];
	const env = {
		DB: createD1Adapter(database),
		FILES: { async delete(key) { deletedFiles.push(key); } },
	};
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("session", { userId: 1, displayName: "Owner", isAdmin });
		await next();
	});
	app.onError((error, c) => c.json(
		{ error: error instanceof ApiError ? error.message : "服务器开小差了" },
		error instanceof ApiError ? error.status : 500,
	));
	registerChannelRoutes(app);
	return {
		database, env, deletedFiles,
		async request(path, method, payload) {
			return app.fetch(new Request(`https://example.com${path}`, {
				method,
				headers: { "content-type": "application/json" },
				...(payload ? { body: JSON.stringify(payload) } : {}),
			}), env);
		},
	};
}

function count(database, table, where = "1") {
	return database.exec(`SELECT COUNT(*) FROM ${table} WHERE ${where}`)[0].values[0][0];
}

async function createGroup(harness, name = "重建群", kind = "private") {
	const response = await harness.request("/api/channels", "POST", {
		name, kind, memberUserIds: [2],
	});
	assert.equal(response.status, 200);
	return (await response.json()).channel.id;
}

function addRelatedRecords(database, id) {
	database.run(
		`INSERT INTO uploaded_files (object_key, owner_user_id)
		 VALUES ('group-avatar', 1), ('group-file', 1)`,
	);
	database.run("UPDATE channels SET avatar_key = 'group-avatar' WHERE id = ?", [id]);
	database.run(
		`INSERT INTO messages (channel_id, sender_id, content, attachment_key)
		 VALUES (?, 1, 'private history', 'group-file')`, [id],
	);
	const messageId = database.exec("SELECT last_insert_rowid()")[0].values[0][0];
	database.run("INSERT INTO message_reads (channel_id, user_id, last_read_message_id) VALUES (?, 2, ?)", [id, messageId]);
	database.run("INSERT INTO channel_pins (channel_id, message_id, pinned_by) VALUES (?, ?, 1)", [id, messageId]);
	database.run("INSERT INTO message_event_compaction (channel_id, compacted_through) VALUES (?, 1)", [id]);
	database.run("INSERT INTO telegram_mappings (channel_id, telegram_chat_id) VALUES (?, '-123')", [id]);
}

for (const kind of ["public", "private"]) {
	for (const admin of [false, true]) {
		test(`${kind} 群组经${admin ? "管理员" : "群主"}硬删除后可同名创建且没有旧群数据`, async () => {
			const harness = createHarness(admin);
			const { database, env } = harness;
			const id = await createGroup(harness, "重建群", kind);
			addRelatedRecords(database, id);
			const duplicate = await harness.request("/api/channels", "POST", { name: "重建群", kind });
			assert.equal(duplicate.status, 400);
			assert.deepEqual(await duplicate.json(), { error: "群组名称已存在" });

			const path = admin ? `/api/admin/channels/${id}` : `/api/channels/${id}`;
			assert.equal((await harness.request(path, "DELETE")).status, 200);
			assert.equal(count(database, "channels", `id = ${id}`), 0);
			for (const table of ["messages", "channel_members", "message_reads", "channel_pins", "message_events", "message_event_compaction", "telegram_mappings"]) {
				assert.equal(count(database, table, `channel_id = ${id}`), 0, table);
			}
			assert.equal(count(database, "pending_r2_delete"), 2);
			assert.deepEqual(database.exec("PRAGMA foreign_key_check"), []);
			const recreated = await createGroup(harness, "重建群", kind);
			assert.ok(recreated > id);
			assert.equal(count(database, "messages", `channel_id = ${recreated}`), 0);
			assert.equal(count(database, "channel_members", `channel_id = ${recreated}`), 2);
			assert.equal((await harness.request(`/api/channels/${id}/members`, "GET")).status, 404);
			assert.equal((await hardDeleteChannel(env.DB, id)).channelsDeleted, 0);
		});
	}
}

test("硬删除事务失败会同时回滚文件队列、消息及成员", async () => {
	const harness = createHarness();
	const id = await createGroup(harness);
	addRelatedRecords(harness.database, id);
	harness.database.run(
		`CREATE TRIGGER simulate_delete_failure BEFORE DELETE ON channels
		 BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
	);
	await assert.rejects(hardDeleteChannel(harness.env.DB, id), /test failure/);
	assert.equal(count(harness.database, "channels", `id = ${id}`), 1);
	assert.equal(count(harness.database, "messages", `channel_id = ${id}`), 1);
	assert.equal(count(harness.database, "channel_members", `channel_id = ${id}`), 2);
	assert.equal(count(harness.database, "message_reads", `channel_id = ${id}`), 1);
	assert.equal(count(harness.database, "pending_r2_delete"), 0);
	assert.deepEqual(harness.database.exec("PRAGMA foreign_key_check"), []);
});

test("删除入口拒绝普通成员，底层不会删除 general 或私聊", async () => {
	const harness = createHarness();
	const id = await createGroup(harness);
	harness.database.run("UPDATE channel_members SET role = 'member' WHERE channel_id = ?", [id]);
	assert.equal((await harness.request(`/api/channels/${id}`, "DELETE")).status, 403);
	assert.equal(count(harness.database, "channels", `id = ${id}`), 1);
	harness.database.run("INSERT INTO channels (name, kind, dm_key) VALUES ('dm:1:2', 'dm', '1:2')");
	const dmId = harness.database.exec("SELECT last_insert_rowid()")[0].values[0][0];
	for (const channelId of [1, dmId]) {
		assert.equal((await hardDeleteChannel(harness.env.DB, channelId)).channelsDeleted, 0);
		assert.equal(count(harness.database, "channels", `id = ${channelId}`), 1);
	}
});

test("GC 复用硬删除清理历史群组，文件失败重试且保留共享引用", async () => {
	const harness = createHarness();
	const { database, env, deletedFiles } = harness;
	const id = await createGroup(harness);
	addRelatedRecords(database, id);
	database.run("UPDATE channels SET deleted_at = datetime('now', '-61 day') WHERE id = ?", [id]);
	database.run(
		"UPDATE uploaded_files SET owner_user_id = 2 WHERE object_key = 'group-avatar'",
	);
	database.run("UPDATE users SET avatar_key = 'group-avatar' WHERE id = 2");
	const deleteFile = env.FILES.delete;
	env.FILES.delete = async () => { throw new Error("R2 unavailable"); };
	const summary = await runScheduledGc(env);
	assert.equal(summary.channelsDeleted, 1);
	assert.equal(count(database, "channels", `id = ${id}`), 0);
	assert.equal(count(database, "message_reads", `channel_id = ${id}`), 0);
	assert.equal(count(database, "pending_r2_delete"), 1);
	assert.equal(count(database, "pending_r2_delete", "object_key = 'group-file' AND retry_count = 1"), 1);
	assert.equal(count(database, "uploaded_files"), 2);
	env.FILES.delete = deleteFile;
	database.run("UPDATE pending_r2_delete SET next_retry_at = CURRENT_TIMESTAMP");
	await runScheduledGc(env);
	assert.deepEqual(deletedFiles, ["group-file"]);
	assert.equal(count(database, "pending_r2_delete"), 0);
	assert.equal(count(database, "uploaded_files", "object_key = 'group-file'"), 0);
	assert.equal(count(database, "uploaded_files", "object_key = 'group-avatar'"), 1);
	assert.deepEqual(database.exec("PRAGMA foreign_key_check"), []);
});
