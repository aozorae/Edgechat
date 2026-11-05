import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import worker from '../worker/src/index.js';
import { createSession } from '../worker/src/auth.js';
import { canAccessFile } from '../worker/src/data/uploaded-files.js';
import { encryptAttachment } from '../worker/src/encryption.js';
import { AUTHORIZATION_COLUMNS, AUTHORIZATION_JOIN } from '../worker/src/rbac/authorization.ts';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const SQL = await initSqlJs();
const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
const keyring = JSON.stringify({
	activeKeyId: 'test',
	keys: { test: Buffer.alloc(32, 7).toString('base64') },
});
const plaintext = new TextEncoder().encode('private attachment bytes');

async function fixture(t) {
	const database = new SQL.Database();
	t.after(() => database.close());
	database.exec(schema);
	database.run(`INSERT INTO users (id, username, display_name, password_hash, password_salt)
	 VALUES (1, 'uploader', 'Uploader', 'hash', 'salt'), (2, 'reader', 'Reader', 'hash', 'salt')`);
	const db = createD1Adapter(database);
	const objects = new Map();
	const reads = [];
	const env = {
		DB: db,
		SESSIONS: createKvAdapter(),
		EDGECHAT_ENCRYPTION_KEYRING: keyring,
		FILES: {
			async get(key) {
				reads.push(key);
				return {
					async arrayBuffer() { return objects.get(key); },
					writeHttpMetadata(headers) { headers.set('content-type', 'image/png'); },
				};
			},
		},
	};
	for (const kind of ['public', 'private', 'dm']) {
		database.run('INSERT INTO channels (kind, name, dm_key) VALUES (?, ?, ?)', [kind, kind, kind === 'dm' ? '1:2' : null]);
		const channelId = Number(database.exec('SELECT last_insert_rowid()')[0].values[0][0]);
		database.run("INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, 1, 'owner')", [channelId]);
		const key = `1/${kind}.png`;
		database.run("INSERT INTO uploaded_files (object_key, owner_user_id, content_type) VALUES (?, 1, 'image/png')", [key]);
		database.run('INSERT INTO messages (channel_id, sender_id, attachment_key) VALUES (?, 1, ?)', [channelId, key]);
		objects.set(key, await encryptAttachment(env, plaintext, key));
	}
	const user = await db.prepare(`SELECT u.*, ${AUTHORIZATION_COLUMNS} FROM users u ${AUTHORIZATION_JOIN} WHERE u.id = 2`).first();
	const session = await createSession(env, user);
	function request(key, options = {}) {
		return worker.fetch(new Request(`https://attachments.test/files/${encodeURIComponent(key)}${options.query || ''}`, {
			headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
		}), env, {});
	}
	return { database, db, env, reads, session, request };
}

test('message attachment authorization rejects absent and invalid user IDs', async (t) => {
	const h = await fixture(t);
	for (const userId of [null, undefined, '', ' ', 0, -1, 1.5, NaN, Infinity]) {
		assert.equal(await canAccessFile(h.db, '1/public.png', userId), false, `userId=${String(userId)}`);
	}
});

test('valid readers retain public access, private/DM membership and uploader preview rules', async (t) => {
	const h = await fixture(t);
	assert.equal(await canAccessFile(h.db, '1/public.png', 2), true);
	for (const kind of ['private', 'dm']) {
		const key = `1/${kind}.png`;
		assert.equal(await canAccessFile(h.db, key, 2), false);
		h.database.run("INSERT INTO channel_members (channel_id, user_id, role) SELECT id, 2, 'member' FROM channels WHERE kind = ?", [kind]);
		assert.equal(await canAccessFile(h.db, key, 2), true);
		h.database.run('DELETE FROM channel_members WHERE user_id = 2 AND channel_id IN (SELECT id FROM channels WHERE kind = ?)', [kind]);
		assert.equal(await canAccessFile(h.db, key, 2), false);
	}
	h.database.run("INSERT INTO uploaded_files (object_key, owner_user_id) VALUES ('1/draft.png', 1)");
	assert.equal(await canAccessFile(h.db, '1/draft.png', 1), true);
	assert.equal(await canAccessFile(h.db, '1/draft.png', 2), false);
	assert.equal(await canAccessFile(h.db, '1/draft.png'), false);
});

for (const tokenMode of ['anonymous', 'unknown', 'expired', 'disabled', 'temporarily-disabled', 'deleted', 'revoked']) {
	test(`${tokenMode} file request cannot read public attachment plaintext or touch R2`, async (t) => {
		const h = await fixture(t);
		let token = h.session.token;
		if (tokenMode === 'anonymous') token = '';
		if (tokenMode === 'unknown') token = 'unknown-token';
		if (tokenMode === 'expired') await h.env.SESSIONS.delete(token);
		if (tokenMode === 'disabled') h.database.run('UPDATE users SET is_disabled = 1 WHERE id = 2');
		if (tokenMode === 'temporarily-disabled') h.database.run("UPDATE users SET disabled_until = datetime('now', '+1 day') WHERE id = 2");
		if (tokenMode === 'deleted') h.database.run('UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = 2');
		if (tokenMode === 'revoked') h.database.run('UPDATE users SET session_version = session_version + 1 WHERE id = 2');
		// 浏览器媒体用 query token，API 客户端用 Bearer；两条入口必须共享撤销规则。
		for (const options of [{ token }, { query: `?token=${token}` }]) {
			const response = await h.request('1/public.png', options);
			assert.equal(response.status, 403);
			assert.equal(await response.text(), 'Forbidden');
		}
		assert.deepEqual(h.reads, []);
	});
}

test('authenticated public nonmember can still download decrypted bytes with private caching', async (t) => {
	const h = await fixture(t);
	for (const options of [{ token: h.session.token }, { query: `?token=${h.session.token}` }]) {
		const response = await h.request('1/public.png', options);
		assert.equal(response.status, 200);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), plaintext);
		assert.equal(response.headers.get('cache-control'), 'private, no-store');
	}
});

test('anonymous avatars and saved site icons remain public, pending files remain denied', async (t) => {
	const h = await fixture(t);
	for (const reference of [
		"UPDATE users SET avatar_key = '1/public.png' WHERE id = 1",
		"UPDATE channels SET avatar_key = '1/public.png' WHERE name = 'public'",
		"INSERT INTO site_settings (setting_key, setting_value) VALUES ('site_icon_url', 'r2:1/public.png')",
	]) {
		h.database.run(reference);
		const response = await h.request('1/public.png');
		assert.equal(response.status, 200);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), plaintext);
		h.database.run('UPDATE users SET avatar_key = NULL');
		h.database.run('UPDATE channels SET avatar_key = NULL');
		h.database.run("DELETE FROM site_settings WHERE setting_key = 'site_icon_url'");
	}
	h.database.run("INSERT INTO pending_r2_delete (object_key) VALUES ('1/public.png')");
	h.reads.length = 0;
	assert.equal((await h.request('1/public.png', { token: h.session.token })).status, 403);
	assert.deepEqual(h.reads, []);
});
