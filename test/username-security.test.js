import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import worker from '../worker/src/index.js';
import { hashPassword, createSession } from '../worker/src/auth.js';
import { getUserByUsername } from '../worker/src/data/users.js';
import { createRegistrationInvite } from '../worker/src/data/registration-invites.js';
import { generateBootstrapSql } from '../.github/scripts/generate-admin-bootstrap-sql.mjs';
import { syncAdminCredentials } from '../.github/scripts/sync-admin-credentials.ts';
import { isValidNewUsername, USERNAME_RULE_ERROR } from '../shared/username.ts';
import { buildVditorMentionHints } from '../frontend/src/vditor-mention-hints.ts';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const invalidNames = [
  '<b data-probe="username">name</b>', '&lt;b&gt;', 'a"b', "a'b",
  'two words', 'line\nbreak', 'tab\tname', 'a\u0000b', 'a\u202Eb',
  'a\u200Bb', '@alice', '=formula', '_first', 'a'.repeat(65), '',
];

test('新用户名采用有界 Unicode 白名单，不把输入改写为另一个账号标识', () => {
  for (const name of ['alice', '用户_1', 'ユーザー.2', 'Élodie', 'e\u0301', 'a-b', '1', 'a'.repeat(64)]) {
    assert.equal(isValidNewUsername(name), true, name);
  }
  for (const name of invalidNames) assert.equal(isValidNewUsername(name), false, name);
});

test('Vditor 展示和插入两个 HTML 出口均转义存量用户名及显示名', () => {
  const name = '<b data-probe="username">&\'marker</b>';
  const [hint] = buildVditorMentionHints([{ id: 1, username: name, displayName: name }], 'MARKER');
  const escaped = '&lt;b data-probe=&quot;username&quot;&gt;&amp;&#039;marker&lt;/b&gt;';
  assert.equal(hint.value, `@${escaped}`);
  assert.equal(hint.html, `<strong>@${escaped}</strong> <span>${escaped}</span>`);
  assert.equal(buildVditorMentionHints([{ id: 1, username: '&lt;b&gt;' }], '')[0].value, '@&amp;lt;b&amp;gt;');
  assert.equal(buildVditorMentionHints(Array.from({ length: 10 }, (_, id) => ({ id, username: `u${id}` })), '').length, 8);
  const source = readFileSync(new URL('../frontend/src/components/chat/VditorComposerEditor.vue', import.meta.url), 'utf8');
  assert.match(source, /parse:\s*true/);
  assert.match(source, /buildVditorMentionHints\(props\.mentionCandidates/);
});

test('邀请与管理员建号拒绝无效标识，不消耗邀请、不写账号；正常 Unicode 名仍可注册', async () => {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  try {
    database.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
    database.exec(await generateBootstrapSql({ username: 'root', password: 'local-test' }));
    const env = { DB: createD1Adapter(database), SESSIONS: createKvAdapter() };
    const root = await createSession(env, await getUserByUsername(env.DB, 'root'));
    await createRegistrationInvite(env.DB, { token: 'local-test', maxUses: 2, note: '', createdBy: null });
    const request = (path, username, token = '') => worker.fetch(new Request(`https://username.test/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ username, password: 'local-test', displayName: 'Display <b>text</b>' }),
    }), env, { waitUntil(promise) { promise.catch(() => {}); } });
    for (const name of invalidNames.filter(Boolean)) {
      for (const [path, token] of [['/register-links/local-test/register', ''], ['/admin/users', root.token]]) {
        const response = await request(path, name, token);
        assert.equal(response.status, 400, name);
        assert.deepEqual(await response.json(), { error: USERNAME_RULE_ERROR });
      }
    }
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 1);
    assert.equal((await env.DB.prepare('SELECT used_count FROM registration_invites').first()).used_count, 0);
    assert.equal((await request('/register-links/local-test/register', ' 用户_1 ')).status, 200);
    assert.equal((await request('/admin/users', 'Élodie', root.token)).status, 200);
    assert.equal((await env.DB.prepare('SELECT used_count FROM registration_invites').first()).used_count, 1);
  } finally { database.close(); }
});

test('初始化拒绝无效新用户名；旧用户名仍能登录和同步超管密码，不改名', async () => {
  for (const username of invalidNames.filter(Boolean)) {
    await assert.rejects(generateBootstrapSql({ username, password: 'local-test' }), { message: USERNAME_RULE_ERROR });
  }
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  try {
    database.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
    const username = "legacy'owner";
    const password = await hashPassword('old');
    database.run(`INSERT INTO users (username, display_name, password_hash, password_salt, is_super_admin)
      VALUES (?, ?, ?, ?, 1)`, [username, username, password.hash, password.salt]);
    const env = { DB: createD1Adapter(database), SESSIONS: createKvAdapter() };
    const query = async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all()).results;
    assert.equal(await syncAdminCredentials({ username, password: 'new' }, query), 'updated');
    const response = await worker.fetch(new Request('https://username.test/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'new' }),
    }), env, { waitUntil(promise) { promise.catch(() => {}); } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session.username, username);
  } finally { database.close(); }
});
