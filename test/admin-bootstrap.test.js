import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { generateBootstrapSql, verifyAdminBootstrap } from '../.github/scripts/generate-admin-bootstrap-sql.mjs';
import { syncAdminCredentials } from '../.github/scripts/sync-admin-credentials.ts';
import worker from '../worker/src/index.js';
import { hashPassword, verifyPassword } from '../worker/src/auth.js';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const SQL = await initSqlJs();
const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');

function harness() {
  const database = new SQL.Database();
  database.exec(schema);
  const env = { DB: createD1Adapter(database), SESSIONS: createKvAdapter() };
  const query = async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all()).results;
  async function request(path, body, token = '') {
    return worker.fetch(new Request(`https://bootstrap.test/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env, { waitUntil(promise) { promise.catch(() => {}); } });
  }
  return { database, env, query, request };
}

test('首次安装：只有 schema 无法登录，初始化后能登录、访问后台并创建注册邀请', async () => {
  const h = harness();
  const credentials = { username: 'admin', password: 'operator-chosen-password' };
  assert.equal((await h.request('/auth/login', credentials)).status, 401);
  await assert.rejects(verifyAdminBootstrap(h.query), /No active super administrator/);
  h.database.exec(await generateBootstrapSql(credentials));
  await verifyAdminBootstrap(h.query);
  const login = await h.request('/auth/login', credentials);
  assert.equal(login.status, 200);
  const { token, session } = await login.json();
  assert.equal(session.isSuperAdmin, true);
  assert.equal(session.canAccessAdmin, true);
  assert.equal((await h.request('/admin/overview', null, token)).status, 200);
  assert.equal((await h.request('/admin/register-links', { maxUses: 1 }, token)).status, 200);
  assert.equal((await h.env.DB.prepare('SELECT role_id FROM rbac_user_roles WHERE user_id = ?').bind(session.userId).first()).role_id, 1);
  assert.equal((await h.env.DB.prepare('SELECT role FROM channel_members WHERE user_id = ?').bind(session.userId).first()).role, 'member');
  assert.equal((await h.request('/auth/login', { ...credentials, password: 'wrong' })).status, 401);
});

test('初始化 SQL 转义用户名和显示名，密码只保留随机盐和哈希', async () => {
  const h = harness();
  const credentials = { username: "root'one", displayName: "Owner's site", password: 'secret-not-in-generated-sql' };
  const sql = await generateBootstrapSql(credentials);
  assert.ok(!sql.includes(credentials.password));
  h.database.exec(sql);
  const user = await h.env.DB.prepare('SELECT * FROM users').first();
  assert.equal(user.username, credentials.username);
  assert.equal(user.display_name, credentials.displayName);
  assert.equal(await verifyPassword(credentials.password, user.password_hash, user.password_salt), true);
});

test('重复初始化保留现有密码及身份，不会创建重复账号', async () => {
  const h = harness();
  h.database.exec(await generateBootstrapSql({ username: 'admin', password: 'original' }));
  const before = await h.query('SELECT * FROM users');
  h.database.exec(await generateBootstrapSql({ username: 'admin', password: 'replacement', displayName: 'changed' }));
  assert.deepEqual(await h.query('SELECT * FROM users'), before);
  await verifyAdminBootstrap(h.query);
});

test('同名普通账号不能经初始化被提权或重置密码', async () => {
  const h = harness();
  const hashed = await hashPassword('existing-password');
  h.database.run('INSERT INTO users (username, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)', ['admin', 'existing', hashed.hash, hashed.salt]);
  const before = await h.query('SELECT * FROM users');
  h.database.exec(await generateBootstrapSql({ username: 'admin', password: 'replacement' }));
  assert.deepEqual(await h.query('SELECT * FROM users'), before);
  await assert.rejects(verifyAdminBootstrap(h.query), /explicit recovery/);
});

test('Actions 首次同步创建超管，同密码部署不改资料或失效会话', async () => {
  const h = harness();
  const credentials = { username: "root'one", password: 'actions-password' };
  assert.equal(await syncAdminCredentials(credentials, h.query), 'created');
  const login = await h.request('/auth/login', credentials);
  const { token } = await login.json();
  const before = await h.query('SELECT * FROM users');
  assert.equal(await syncAdminCredentials({ ...credentials, displayName: 'not applied' }, h.query), 'unchanged');
  assert.deepEqual(await h.query('SELECT * FROM users'), before);
  assert.equal((await h.request('/admin/overview', null, token)).status, 200);
});

test('Actions 以部署密码为准，更新 Secret 后新密码能登录且旧密码与会话失效', async () => {
  const h = harness();
  const credentials = { username: 'admin', password: 'old-password' };
  await syncAdminCredentials(credentials, h.query);
  const { token } = await (await h.request('/auth/login', credentials)).json();
  const [before] = await h.query('SELECT * FROM users');
  const password = "new'password-not-logged";
  const queries = [];
  assert.equal(await syncAdminCredentials({ ...credentials, password }, async (sql, params) => {
    queries.push(sql, params);
    return h.query(sql, params);
  }), 'updated');
  assert.ok(!JSON.stringify(queries).includes(password));
  const [after] = await h.query('SELECT * FROM users');
  assert.equal(after.session_version, before.session_version + 1);
  assert.deepEqual({ ...after, password_hash: before.password_hash, password_salt: before.password_salt,
    session_version: before.session_version }, before);
  assert.equal((await h.request('/auth/login', credentials)).status, 401);
  assert.equal((await h.request('/auth/session', null, token)).status, 401);
  const login = await h.request('/auth/login', { ...credentials, password });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).session.isSuperAdmin, true);
});

for (const state of ['ordinary', 'banned', 'temporary', 'deleted']) {
  test(`Actions 不改变同名账号的身份或封禁：${state}`, async () => {
    const h = harness();
    await syncAdminCredentials({ username: 'other-admin', password: 'other' }, h.query);
    await syncAdminCredentials({ username: 'admin', password: 'original' }, h.query);
    const field = { ordinary: 'is_super_admin = 0', banned: 'is_disabled = 1',
      temporary: "disabled_until = datetime('now', '+1 hour')", deleted: 'deleted_at = CURRENT_TIMESTAMP' }[state];
    h.database.run(`UPDATE users SET ${field} WHERE username = 'admin'`);
    const before = await h.query('SELECT * FROM users');
    await assert.rejects(syncAdminCredentials({ username: 'admin', password: 'replacement' }, h.query), /explicit recovery/);
    assert.deepEqual(await h.query('SELECT * FROM users'), before);
  });
}

test('Actions 同步拒绝缺失凭据并传播 D1 失败，不会误报成功', async () => {
  const h = harness();
  await assert.rejects(syncAdminCredentials({ username: '', password: 'x' }, h.query), /EDGECHAT_ADMIN_USERNAME/);
  await assert.rejects(syncAdminCredentials({ username: 'admin', password: '' }, h.query), /EDGECHAT_ADMIN_PASSWORD/);
  await assert.rejects(syncAdminCredentials({ username: 'admin', password: 'x' }, async () => { throw new Error('D1 unavailable'); }), /D1 unavailable/);
  await syncAdminCredentials({ username: 'admin', password: 'original' }, h.query);
  await assert.rejects(syncAdminCredentials({ username: 'admin', password: 'replacement' }, async (sql, params) => {
    if (sql.startsWith('UPDATE')) throw new Error('D1 write failed');
    return h.query(sql, params);
  }), /D1 write failed/);
});

for (const [state, fields, valid] of [
  ['普通账号', '0, 0, NULL, NULL', false],
  ['永久封禁超管', '1, 1, NULL, NULL', false],
  ['临时封禁超管', "1, 0, datetime('now', '+1 hour'), NULL", false],
  ['软删除超管', "1, 0, NULL, CURRENT_TIMESTAMP", false],
  ['封禁到期超管', "1, 0, datetime('now', '-1 hour'), NULL", true],
]) {
  test(`部署校验：${state}`, async () => {
    const h = harness();
    h.database.run(`INSERT INTO users (username, display_name, password_hash, password_salt, is_super_admin, is_disabled, disabled_until, deleted_at)
      VALUES ('operator', 'operator', 'hash', 'salt', ${fields})`);
    if (valid) await verifyAdminBootstrap(h.query);
    else await assert.rejects(verifyAdminBootstrap(h.query), /No active super administrator/);
  });
}

test('初始化缺少任一凭据时给出明确配置名，数据库查询失败不会被当作已初始化', async () => {
  await assert.rejects(generateBootstrapSql({ username: '', password: 'provided' }), /EDGECHAT_ADMIN_USERNAME/);
  await assert.rejects(generateBootstrapSql({ username: 'admin', password: '' }), /EDGECHAT_ADMIN_PASSWORD/);
  await assert.rejects(verifyAdminBootstrap(async () => { throw new Error('D1 unavailable'); }), /D1 unavailable/);
});
