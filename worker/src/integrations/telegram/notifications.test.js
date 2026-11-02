import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import { encryptMessageContent, encryptSecretValue } from "../../encryption.js";
import {
	consumeTelegramNotificationLink,
	createTelegramNotificationLink,
	disconnectTelegramNotifications,
	enqueueTelegramNotification,
	getTelegramNotificationState,
	deliverTelegramNotification,
	rescueTelegramNotifications,
	updateTelegramNotificationPreferences,
} from "./notifications.js";

const SQL = await initSqlJs();

function d1(db) {
	return {
		prepare(sql) {
			const makeBound = (values) => {
					const execute = () => {
						const statement = db.prepare(sql);
						try {
							statement.bind(values);
							const rows = [];
							while (statement.step()) rows.push(statement.getAsObject());
							return { rows, changes: db.getRowsModified() };
						} finally {
							statement.free();
						}
					};
					return {
						all: async () => ({ results: execute().rows }),
						first: async () => execute().rows[0] || null,
						run: async () => ({ meta: { changes: execute().changes } }),
					};
			};
			return { bind: (...values) => makeBound(values), ...makeBound([]) };
		},
	};
}

function start(chatId, token, type = "private") {
	return {
		chat: { id: chatId, type },
		from: { id: chatId, first_name: "Recipient" },
		text: `/start ${token}`,
	};
}

test("Telegram binding is private, single-use, and notification deliveries deduplicate and retry", async () => {
	const db = new SQL.Database();
	db.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
	db.exec(`INSERT INTO users (id, username, display_name, password_hash, password_salt)
	         VALUES (1, 'alice', 'Alice', 'hash', 'salt'), (2, 'bob', 'Bob', 'hash', 'salt')`);
	const env = {
		DB: d1(db),
		TELEGRAM_NOTIFICATIONS: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
		EDGECHAT_ENCRYPTION_KEYRING: JSON.stringify({
			activeKeyId: "v1",
			keys: { v1: Buffer.alloc(32, 7).toString("base64") },
		}),
	};
	const bot = await encryptSecretValue(env, "123456:example-token", "telegram:bot-token");
	const secret = await encryptSecretValue(env, "webhook-secret", "telegram:webhook-secret");
	db.run(`INSERT INTO telegram_bridge_config (id, bot_token_ciphertext, webhook_secret_ciphertext, bot_username)
	        VALUES (1, ?, ?, 'EdgeChatBot')`, [bot, secret]);
	const link = await createTelegramNotificationLink(env, 1);
	const token = new URL(link).searchParams.get("start");
	assert.equal(await consumeTelegramNotificationLink(env, start(100, token, "group")), false);
	assert.equal(await consumeTelegramNotificationLink(env, start(100, token)), true);
	assert.equal(await consumeTelegramNotificationLink(env, start(101, token)), false);
	assert.equal((await getTelegramNotificationState(env, 1)).connected, true);
	const secondLink = await createTelegramNotificationLink(env, 2);
	assert.equal(await consumeTelegramNotificationLink(env, start(100, new URL(secondLink).searchParams.get("start"))), false);

	const sent = [];
	const originalFetch = globalThis.fetch;
	let fail = true;
	globalThis.fetch = async (_url, init) => {
		sent.push(JSON.parse(init.body));
		if (fail) return Response.json({ ok: false, description: "temporary" }, { status: 503 });
		return Response.json({ ok: true, result: { message_id: 1 } });
	};
	try {
		const room = { id: 17, name: "Secret room", kind: "dm" };
		const message = { id: 21, content: "Readable <b>message</b> & https://example.com" };
		db.run("INSERT INTO channels (id, kind, name, dm_key) VALUES (17, 'dm', 'DM', '1:2')");
		db.run("INSERT INTO channel_members (channel_id, user_id) VALUES (17, 1), (17, 2)");
		db.run("INSERT INTO messages (id, channel_id, sender_id, content) VALUES (21, 17, 2, ?)",
			[await encryptMessageContent(env, message.content, { channelId: 17, senderId: 2 })]);
		await enqueueTelegramNotification(env, { userId: 1, senderId: 2, room, message, kind: "dm" });
		assert.equal(sent.length, 0);
		db.run("UPDATE telegram_notification_outbox SET next_attempt_at = datetime('now', '-1 minute')");
		await deliverTelegramNotification(env);
		assert.equal(sent.length, 1);
		assert.ok(sent[0].text.includes("Readable…"));
		assert.ok(!sent[0].text.includes(message.content));
		assert.equal(sent[0].parse_mode, undefined);
		assert.equal(sent[0].link_preview_options.is_disabled, true);
		assert.ok(sent[0].reply_markup.keyboard[0][0].text.includes("Bob"));
		await enqueueTelegramNotification(env, { userId: 1, senderId: 2, room, message, kind: "dm" });
		assert.equal(sent.length, 1);
		fail = false;
		db.run("UPDATE telegram_notification_outbox SET next_attempt_at = datetime('now', '-1 minute')");
		db.run("UPDATE telegram_notification_users SET next_notification_at = datetime('now', '-1 minute')");
		db.run("UPDATE telegram_notification_gate SET next_send_at = datetime('now', '-1 minute')");
		await rescueTelegramNotifications(env);
		assert.equal(sent.length, 1);
		await deliverTelegramNotification(env);
		assert.equal(sent.length, 2);
		assert.equal(db.exec("SELECT status FROM telegram_notification_outbox")[0].values[0][0], "sent");
		await updateTelegramNotificationPreferences(env.DB, 1, { dmEnabled: false, mentionEnabled: true });
		await enqueueTelegramNotification(env, { userId: 1, room, message: { id: 22 }, kind: "dm" });
		assert.equal(sent.length, 2);
		await disconnectTelegramNotifications(env.DB, 1);
		assert.equal((await getTelegramNotificationState(env, 1)).connected, false);
	} finally {
		globalThis.fetch = originalFetch;
		db.close();
	}
});
