import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";

import { insertMessage } from "../worker/src/data/messages.js";
import { canAccessFile } from "../worker/src/data/uploaded-files.js";
import { ORPHAN_UPLOAD_QUERY, runScheduledGc } from "../worker/src/gc.js";
import { createMessageSubmission } from "../worker/src/message-submission.js";
import { createD1Adapter } from "./support/d1.js";

const SQL = await initSqlJs();
const schemaSql = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");

function createDatabase() {
	const database = new SQL.Database();
	database.exec(schemaSql);
	return database;
}

function insertUser(database, username, { deleted = false } = {}) {
	database.run(
		`INSERT INTO users (
		   username, display_name, password_hash, password_salt, deleted_at
		 ) VALUES (?, ?, 'hash', 'salt', ${deleted ? "datetime('now', '-61 day')" : "NULL"})`,
		[username, username],
	);
	return Number(database.exec("SELECT last_insert_rowid()")[0].values[0][0]);
}

function scalar(database, sql) {
	return Number(database.exec(sql)[0]?.values?.[0]?.[0] || 0);
}

function createMeasuredD1(database) {
	const base = createD1Adapter(database);
	const metrics = { apiCalls: 0, statements: 0, maxBindings: 0 };
	return {
		metrics,
		db: {
			prepare(sql) {
				let inner = base.prepare(sql);
				const wrapped = {
					get inner() { return inner; },
					sql: String(sql),
					bind(...values) {
						metrics.maxBindings = Math.max(metrics.maxBindings, values.length);
						inner = inner.bind(...values);
						return this;
					},
					async all() {
						metrics.apiCalls += 1;
						metrics.statements += 1;
						return inner.all();
					},
					async run() {
						metrics.apiCalls += 1;
						metrics.statements += 1;
						return inner.run();
					},
				};
				return wrapped;
			},
			async batch(statements) {
				metrics.apiCalls += 1;
				metrics.statements += statements.length;
				return base.batch(statements.map((statement) => statement.inner));
			},
		},
	};
}

test("消息保留期默认三十天，支持自定义天数，非法值不会误清新消息", async () => {
	for (const [value, deleted] of [[undefined, 1], ["30", 1], ["60", 0], ["15", 3], ["7", 4], ["1", 5], ["0", 1], ["-1", 1], ["invalid", 1], ["0.5", 1]]) {
		const database = createDatabase();
		try {
			const userId = insertUser(database, "retention-owner");
			const channelId = scalar(database, "SELECT id FROM channels WHERE name = 'general'");
			for (const age of ["-31 day", "-29 day", "-16 day", "-14 day", "-2 day", "-1 hour"]) {
				database.run("INSERT INTO messages (channel_id, sender_id, content, created_at) VALUES (?, ?, 'message', datetime('now', ?))", [channelId, userId, age]);
			}
			const summary = await runScheduledGc({ DB: createD1Adapter(database), MESSAGE_RETENTION_DAYS: value });
			assert.equal(summary.expiredMessagesDeleted, deleted, String(value));
			assert.equal(scalar(database, "SELECT COUNT(*) FROM messages"), 6 - deleted);
		} finally {
			database.close();
		}
	}
});

test("孤儿扫描使用匹配索引，失败对象进入退避且不阻塞后续批次", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "gc-owner");
	const plan = database.prepare(`EXPLAIN QUERY PLAN ${ORPHAN_UPLOAD_QUERY}`);
	plan.bind(["-1 day", "", 90]);
	const details = [];
	while (plan.step()) {
		details.push(String(plan.getAsObject().detail || ""));
	}
	plan.free();
	assert.equal(
		details.some((detail) => /SCAN (uploaded_files|messages|users|channels)/.test(detail)),
		false,
		details.join("\n"),
	);

	database.run(
		`INSERT INTO uploaded_files (object_key, owner_user_id, created_at) VALUES
		 (?, ?, datetime('now', '-4 day')),
		 (?, ?, datetime('now', '-3 day')),
		 (?, ?, datetime('now', '-2 day'))`,
		["1/a", userId, "1/b", userId, "1/c", userId],
	);
	const attempts = [];
	await runScheduledGc({
		DB: createD1Adapter(database),
		FILES: {
			async delete(key) {
				attempts.push(key);
				throw new Error("simulated R2 outage");
			},
		},
		GC_BATCH_SIZE: 2,
		GC_MAX_BATCHES_PER_RUN: 3,
		ORPHAN_UPLOAD_RETENTION_DAYS: 1,
	});

	assert.deepEqual(attempts, ["1/a", "1/b", "1/c"]);
	assert.equal(scalar(database, "SELECT COUNT(*) FROM pending_r2_delete"), 3);
	assert.equal(
		scalar(
			database,
			"SELECT COUNT(*) FROM pending_r2_delete WHERE retry_count = 1 AND next_retry_at > CURRENT_TIMESTAMP",
		),
		3,
	);
});

test("R2 删除后 D1 完成批次失败时保留任务并写入退避", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "completion-failure");
	database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id, created_at) VALUES ('1/completion-failure', ?, datetime('now', '-2 day'))",
		[userId],
	);
	database.run(
		"INSERT INTO pending_r2_delete (object_key) VALUES ('1/completion-failure')",
	);
	const measured = createMeasuredD1(database);
	const regularBatch = measured.db.batch.bind(measured.db);
	let failCompletion = true;
	measured.db.batch = async (statements) => {
		if (
			failCompletion &&
			statements.some((statement) =>
				statement.sql.includes("DELETE FROM uploaded_files WHERE object_key = ?"),
			)
		) {
			failCompletion = false;
			measured.metrics.apiCalls += 1;
			measured.metrics.statements += statements.length;
			throw new Error("simulated D1 completion failure");
		}
		return regularBatch(statements);
	};

	const deleted = [];
	const summary = await runScheduledGc({
		DB: measured.db,
		FILES: { async delete(key) { deleted.push(key); } },
		GC_BATCH_SIZE: 1,
		GC_MAX_BATCHES_PER_RUN: 1,
	});

	assert.deepEqual(deleted, ["1/completion-failure"]);
	assert.equal(summary.r2Deleted, 0);
	assert.equal(summary.r2DeleteFailed, 1);
	assert.equal(summary.budget.d1ApiCalls, measured.metrics.apiCalls);
	assert.equal(summary.budget.d1Statements, measured.metrics.statements);
	assert.equal(
		scalar(
			database,
			`SELECT COUNT(*) FROM pending_r2_delete
			 WHERE object_key = '1/completion-failure'
			   AND retry_count = 1
			   AND next_retry_at > CURRENT_TIMESTAMP`,
		),
		1,
	);
	assert.equal(
		scalar(
			database,
			"SELECT COUNT(*) FROM uploaded_files WHERE object_key = '1/completion-failure'",
		),
		1,
	);
});

test("待删除占位原子阻止消息附件与头像重新引用", () => {
	const database = createDatabase();
	const userId = insertUser(database, "claim-owner");
	const channelId = scalar(database, "SELECT id FROM channels WHERE name = 'general'");
	database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id) VALUES ('1/race', ?)",
		[userId],
	);
	assert.equal(
		scalar(
			database,
			"SELECT COUNT(*) FROM uploaded_files WHERE object_key = '1/race' AND owner_user_id = " +
				userId,
		),
		1,
	);
	database.run("INSERT INTO pending_r2_delete (object_key) VALUES ('1/race')");

	assert.throws(
		() =>
			database.run(
				"INSERT INTO messages (channel_id, sender_id, content, attachment_key) VALUES (?, ?, 'x', '1/race')",
				[channelId, userId],
			),
		/r2_local_object_unavailable/,
	);
	assert.throws(
		() => database.run("UPDATE users SET avatar_key = '1/race' WHERE id = ?", [userId]),
		/r2_local_object_unavailable/,
	);
	assert.throws(
		() => database.run("UPDATE channels SET avatar_key = '1/race' WHERE id = ?", [channelId]),
		/r2_local_object_unavailable/,
	);
});

test("待删除对象不会继续通过文件读取授权", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "pending-download");
	database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id) VALUES ('1/pending-download', ?)",
		[userId],
	);
	database.run("UPDATE users SET avatar_key = '1/pending-download' WHERE id = ?", [userId]);
	const db = createD1Adapter(database);
	assert.equal(await canAccessFile(db, "1/pending-download", null), true);
	assert.equal(await canAccessFile(db, "1/pending-download", userId), true);

	database.run("INSERT INTO pending_r2_delete (object_key) VALUES ('1/pending-download')");
	assert.equal(await canAccessFile(db, "1/pending-download", null), false);
	assert.equal(await canAccessFile(db, "1/pending-download", userId), false);
});

test("GC 完成删除并移除占位后，旧请求不能写入失效的本地引用", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "stale-request");
	const channelId = scalar(database, "SELECT id FROM channels WHERE name = 'general'");
	database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id, created_at) VALUES ('1/stale', ?, datetime('now', '-2 day'))",
		[userId],
	);
	assert.equal(
		scalar(database, `SELECT COUNT(*) FROM uploaded_files WHERE object_key = '1/stale'`),
		1,
	);

	const deleted = [];
	await runScheduledGc({
		DB: createD1Adapter(database),
		FILES: { async delete(key) { deleted.push(key); } },
		GC_BATCH_SIZE: 1,
		GC_MAX_BATCHES_PER_RUN: 2,
	});
	assert.deepEqual(deleted, ["1/stale"]);
	assert.equal(scalar(database, "SELECT COUNT(*) FROM uploaded_files"), 0);
	assert.equal(scalar(database, "SELECT COUNT(*) FROM pending_r2_delete"), 0);

	assert.throws(
		() => database.run(
			"INSERT INTO messages (channel_id, sender_id, content, attachment_key) VALUES (?, ?, 'late', '1/stale')",
			[channelId, userId],
		),
		/r2_local_object_unavailable/,
	);
	assert.throws(
		() => database.run("UPDATE users SET avatar_key = '1/stale' WHERE id = ?", [userId]),
		/r2_local_object_unavailable/,
	);
	assert.throws(
		() => database.run("UPDATE channels SET avatar_key = '1/stale' WHERE id = ?", [channelId]),
		/r2_local_object_unavailable/,
	);
});

test("消息预检查后发生完整 GC，实际提交路径返回附件不可用业务错误", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "submission-race");
	const channelId = scalar(database, "SELECT id FROM channels WHERE name = 'general'");
	database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id) VALUES ('1/request-race', ?)",
		[userId],
	);
	const base = createD1Adapter(database);
	const racingDb = {
		prepare(sql) {
			let statement = base.prepare(sql);
			const isMessageInsert = String(sql).includes("INSERT INTO messages");
			return {
				bind(...values) {
					statement = statement.bind(...values);
					return this;
				},
				all() {
					return statement.all();
				},
				run() {
					if (isMessageInsert) {
						database.run(
							"INSERT INTO pending_r2_delete (object_key) VALUES ('1/request-race')",
						);
						database.run("DELETE FROM uploaded_files WHERE object_key = '1/request-race'");
						database.run("DELETE FROM pending_r2_delete WHERE object_key = '1/request-race'");
					}
					return statement.run();
				},
			};
		},
		batch(statements) {
			return base.batch(statements);
		},
	};
	const submit = createMessageSubmission({
		persistMessage: insertMessage,
		async resolveMentions() { return []; },
		async resolveReply() { return { messageId: null, senderId: null }; },
	});
	await assert.rejects(
		submit(
			{
				DB: racingDb,
				EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({
					activeKeyId: "test",
					keys: { test: Buffer.alloc(32, 7).toString("base64") },
				}),
			},
			{
				room: { id: channelId, kind: "public" },
				principal: { userId },
			},
			{
				content: "late request",
				attachment: {
					key: "1/request-race",
					name: "race.txt",
					type: "text/plain",
					size: 4,
				},
			},
		),
		(error) => {
			assert.equal(error.code, "attachment_unavailable");
			assert.match(error.message, /附件不存在、无权使用或正在清理/);
			return true;
		},
	);
	assert.equal(scalar(database, "SELECT COUNT(*) FROM messages"), 0);
});

test("有效本地文件、文本消息、头像清空与可信外部附件保持可用", () => {
	const database = createDatabase();
	const ownerId = insertUser(database, "valid-owner");
	const otherId = insertUser(database, "other-owner");
	const channelId = scalar(database, "SELECT id FROM channels WHERE name = 'general'");
	database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id) VALUES ('1/valid', ?)",
		[ownerId],
	);
	database.run(
		"INSERT INTO messages (channel_id, sender_id, content) VALUES (?, ?, 'text only')",
		[channelId, ownerId],
	);
	database.run(
		"INSERT INTO messages (channel_id, sender_id, content, attachment_key) VALUES (?, ?, 'valid', '1/valid')",
		[channelId, ownerId],
	);
	database.run("UPDATE users SET avatar_key = '1/valid' WHERE id = ?", [ownerId]);
	database.run("UPDATE channels SET avatar_key = '1/valid' WHERE id = ?", [channelId]);
	database.run("UPDATE users SET avatar_key = NULL WHERE id = ?", [ownerId]);
	assert.throws(
		() => database.run(
			"INSERT INTO messages (channel_id, sender_id, content, attachment_key) VALUES (?, ?, 'wrong owner', '1/valid')",
			[channelId, otherId],
		),
		/r2_local_object_unavailable/,
	);
	database.run(
		`INSERT INTO messages (
		   channel_id, sender_id, content, attachment_key, sender_kind,
		   external_sender_id, external_sender_name, source, source_message_id
		 ) VALUES (?, NULL, 'telegram', 'telegram/-1/external.bin', 'external', '7', 'Alice', 'telegram', '-1:1')`,
		[channelId],
	);
	assert.equal(scalar(database, "SELECT COUNT(*) FROM messages"), 3);
});

test("GC 在共享预算内轮转多个步骤，失败后保留任务并可在下次续跑", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "budget-owner");
	const channelId = scalar(database, "SELECT id FROM channels WHERE name = 'general'");
	for (let index = 0; index < 120; index += 1) {
		database.run(
			"INSERT INTO uploaded_files (object_key, owner_user_id, created_at) VALUES (?, ?, datetime('now', '-2 day'))",
			[`budget/${String(index).padStart(3, "0")}`, userId],
		);
		database.run(
			"INSERT INTO messages (channel_id, sender_id, content, created_at) VALUES (?, ?, 'old', datetime('now', '-31 day'))",
			[channelId, userId],
		);
		database.run(
			"INSERT INTO registration_invites (token, deleted_at) VALUES (?, datetime('now', '-61 day'))",
			[`budget-token-${index}`],
		);
	}

	const measured = createMeasuredD1(database);
	const env = {
		DB: measured.db,
		FILES: { async delete() { throw new Error("R2 unavailable"); } },
		GC_BATCH_SIZE: 500,
		GC_MAX_BATCHES_PER_RUN: 20,
		GC_INTERNAL_OPERATION_BUDGET: 45,
		GC_D1_STATEMENT_BUDGET: 60,
		GC_R2_OPERATION_BUDGET: 8,
	};
	const first = await runScheduledGc(env);
	assert.ok(first.expiredMessagesDeleted > 0);
	assert.ok(first.invitesDeleted > 0);
	assert.ok(first.orphanUploadsQueued > 0);
	assert.equal(first.r2DeleteFailed, 8);
	assert.equal(first.budget.exhausted, true);
	assert.ok(first.budget.internalOperations <= 45);
	assert.ok(first.budget.d1Statements <= 60);
	assert.ok(first.budget.r2Operations <= 8);
	assert.equal(first.budget.d1ApiCalls, measured.metrics.apiCalls);
	assert.equal(first.budget.d1Statements, measured.metrics.statements);
	assert.ok(measured.metrics.maxBindings <= 90);

	const remainingBefore = scalar(database, "SELECT COUNT(*) FROM uploaded_files");
	const second = await runScheduledGc(env);
	assert.ok(
		second.expiredMessagesDeleted > 0 ||
			second.invitesDeleted > 0 ||
			second.orphanUploadsQueued > 0 ||
			second.retryQueueFailed > 0,
	);
	assert.ok(scalar(database, "SELECT COUNT(*) FROM uploaded_files") <= remainingBefore);
});

test("重复发现已经排队的对象不会重置未来重试时间", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "future-retry");
	database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id, created_at) VALUES ('1/future', ?, datetime('now', '-2 day'))",
		[userId],
	);
	database.run(
		`INSERT INTO pending_r2_delete (object_key, retry_count, next_retry_at)
		 VALUES ('1/future', 4, datetime('now', '+1 day'))`,
	);
	const before = database.exec(
		"SELECT retry_count, next_retry_at FROM pending_r2_delete WHERE object_key = '1/future'",
	)[0].values[0];
	await runScheduledGc({
		DB: createD1Adapter(database),
		FILES: { async delete() { throw new Error("must not run"); } },
	});
	const after = database.exec(
		"SELECT retry_count, next_retry_at FROM pending_r2_delete WHERE object_key = '1/future'",
	)[0].values[0];
	assert.deepEqual(after, before);
});

test("硬删除用户前先持久化其 R2 清理任务", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "deleted-owner", { deleted: true });
	database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id) VALUES ('1/durable', ?)",
		[userId],
	);
	const baseDb = createD1Adapter(database);
	const failingDb = {
		...baseDb,
		prepare(sql) {
			let statement = baseDb.prepare(sql);
			const failMetadataDelete =
				String(sql).includes("DELETE FROM uploaded_files") &&
				String(sql).includes("owner_user_id IN");
			return {
				bind(...values) {
					statement = statement.bind(...values);
					return this;
				},
				all() {
					return statement.all();
				},
				run() {
					if (failMetadataDelete) {
						throw new Error("simulated metadata delete failure");
					}
					return statement.run();
				},
			};
		},
	};

	await assert.rejects(
		runScheduledGc({ DB: failingDb, FILES: { async delete() {} } }),
		/simulated metadata delete failure/,
	);
	assert.equal(
		scalar(
			database,
			"SELECT COUNT(*) FROM pending_r2_delete WHERE object_key = '1/durable'",
		),
		1,
	);
});

test("GC 可以清理从正常建号流程进入 general 的软删用户", async () => {
	const database = createDatabase();
	const userId = insertUser(database, "deleted-general-member");
	assert.equal(
		scalar(database, `SELECT COUNT(*) FROM channel_members WHERE user_id = ${userId}`),
		1,
	);
	database.run(
		"UPDATE users SET deleted_at = datetime('now', '-61 day') WHERE id = ?",
		[userId],
	);
	const summary = await runScheduledGc({
		DB: createD1Adapter(database),
		FILES: { async delete() {} },
	});
	assert.equal(summary.usersDeleted, 1);
	assert.equal(scalar(database, `SELECT COUNT(*) FROM users WHERE id = ${userId}`), 0);
	assert.equal(scalar(database, `SELECT COUNT(*) FROM channel_members WHERE user_id = ${userId}`), 0);
});
