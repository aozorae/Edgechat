import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import worker from '../worker/src/index.js';
import { createSession, hashPassword } from '../worker/src/auth.js';
import { getUserByUsername } from '../worker/src/data/users.js';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const SQL = await initSqlJs();
const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../worker/migrations/2026-10-26-distribution.sql', import.meta.url),
  'utf8'
);
const password = await hashPassword('test-password');

async function createEnv() {
  const database = new SQL.Database();
  database.exec(schema);
  const env = { DB: createD1Adapter(database), SESSIONS: createKvAdapter() };
  return { database, env };
}

async function seedAdmin(env, username = 'root') {
  await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt, is_super_admin, management_protected)
     VALUES (?, ?, ?, ?, 1, 1)`
  )
    .bind(username, username, password.hash, password.salt)
    .run();
  const user = await getUserByUsername(env.DB, username);
  return createSession(env, user);
}

async function seedInvite(env, { token, maxUses = 1, createdBy = null }) {
  await env.DB.prepare(
    `INSERT INTO registration_invites (token, note, max_uses, created_by) VALUES (?, ?, ?, ?)`
  )
    .bind(token, 'test', maxUses, createdBy)
    .run();
}

function post(env, path, body, token = '') {
  return worker.fetch(
    new Request(`https://distribution.test${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    }),
    env
  );
}

function get(env, path, token = '') {
  return worker.fetch(
    new Request(`https://distribution.test${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }),
    env
  );
}

test('迁移：users 新增 invited_by/invited_at 并回填邀请人', async () => {
  const database = new SQL.Database();
  // 模拟迁移前库：去掉本迁移新增的列与索引（先统一换行，兼容 CRLF）
  const oldSchema = schema
    .replaceAll('\r\n', '\n')
    .replace('  invited_by INTEGER REFERENCES users(id),\n  invited_at TEXT,\n', '')
    .replace('CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by);\n\n', '');
  database.exec(oldSchema);
  database.run(
    `INSERT INTO users (username, display_name, password_hash, password_salt)
     VALUES ('inviter', 'inviter', 'h', 's'), ('invitee', 'invitee', 'h', 's')`
  );
  database.run(
    `INSERT INTO registration_invites (id, token, note, max_uses, created_by)
     VALUES (1, 'token-backfill', 'n', 1, 1)`
  );
  database.run('UPDATE users SET registration_invite_id = 1 WHERE id = 2');
  database.exec(migration);
  const row = database.exec(
    'SELECT invited_by, invited_at IS NOT NULL AS has_time FROM users WHERE id = 2'
  )[0].values[0];
  assert.equal(row[0], 1);
  assert.equal(row[1], 1);
  // 幂等性来自迁移清单（只执行一次），此处只校验迁移本身可执行且回填正确
  assert.deepEqual(database.exec('PRAGMA foreign_key_check'), []);
});

test('自动建号：设备幂等、同设备不重复开户、一次性码第二设备被拒', async () => {
  const { env } = await createEnv();
  await seedAdmin(env);
  const adminRow = await getUserByUsername(env.DB, 'root');
  await seedInvite(env, { token: 'qa-token-1', createdBy: adminRow.id });

  const first = await post(env, '/api/v1/distribution/auto-register', {
    token: 'qa-token-1',
    installationId: 'install-a',
    deviceName: '测试机'
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.created, true);
  assert.equal(firstBody.initialRoom.kind, 'dm');
  assert.equal(firstBody.initialRoom.name, '笨笨');
  assert.ok(firstBody.accessToken);
  assert.ok(firstBody.refreshToken);

  const usersAfterFirst = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
  const inviteAfterFirst = await env.DB.prepare(
    `SELECT used_count FROM registration_invites WHERE token = 'qa-token-1'`
  ).first();
  assert.equal(inviteAfterFirst.used_count, 1);

  // 同设备重试：幂等命中，不建号、不消耗额度
  const second = await post(env, '/api/v1/distribution/auto-register', {
    token: 'qa-token-1',
    installationId: 'install-a',
    deviceName: '测试机'
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.user.id, firstBody.user.id);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n, usersAfterFirst);
  assert.equal(
    (await env.DB.prepare(`SELECT used_count FROM registration_invites WHERE token = 'qa-token-1'`).first())
      .used_count,
    1
  );

  // 不同设备抢同一个一次性码：409
  const third = await post(env, '/api/v1/distribution/auto-register', {
    token: 'qa-token-1',
    installationId: 'install-b',
    deviceName: '另一台'
  });
  assert.equal(third.status, 409);
  assert.equal((await third.json()).error.code, 'invite_unavailable');

  // 邀请人落库
  const invited = await env.DB.prepare(
    'SELECT invited_by, invited_at IS NOT NULL AS has_time FROM users WHERE id = ?'
  )
    .bind(firstBody.user.id)
    .first();
  assert.equal(invited.invited_by, adminRow.id);
  assert.equal(invited.has_time, 1);
});

test('总开关关闭：auto-register 403；开启后恢复', async () => {
  const { env } = await createEnv();
  await seedAdmin(env);
  await seedInvite(env, { token: 'qa-token-2' });
  await env.DB.prepare(
    `INSERT INTO site_settings (setting_key, setting_value) VALUES ('distribution.gateEnabled', '0')
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = '0'`
  ).run();

  const disabled = await post(env, '/api/v1/distribution/auto-register', {
    token: 'qa-token-2',
    installationId: 'install-c'
  });
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json()).error.code, 'distribution_disabled');

  const config = await get(env, '/api/distribution/config');
  assert.equal((await config.json()).gateEnabled, false);

  await env.DB.prepare(
    `UPDATE site_settings SET setting_value = '1' WHERE setting_key = 'distribution.gateEnabled'`
  ).run();
  const enabled = await post(env, '/api/v1/distribution/auto-register', {
    token: 'qa-token-2',
    installationId: 'install-c'
  });
  assert.equal(enabled.status, 200);
});

test('关系树：管理员可见一级邀请关系，普通用户 403', async () => {
  const { env } = await createEnv();
  const admin = await seedAdmin(env);
  const adminRow = await getUserByUsername(env.DB, 'root');
  await seedInvite(env, { token: 'qa-token-3', createdBy: adminRow.id });
  const registered = await post(env, '/api/v1/distribution/auto-register', {
    token: 'qa-token-3',
    installationId: 'install-d'
  });
  assert.equal(registered.status, 200);

  const tree = await get(env, '/api/admin/distribution/tree', admin.token);
  assert.equal(tree.status, 200);
  const treeBody = await tree.json();
  assert.equal(treeBody.depth, 1);
  assert.equal(treeBody.roots.length, 1);
  assert.equal(treeBody.roots[0].userId, adminRow.id);
  assert.equal(treeBody.roots[0].children.length, 1);
  assert.equal(treeBody.roots[0].children[0].userId, (await registered.json()).user.id);

  // 普通用户（无 invites.read）不能看
  await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt) VALUES ('plain', 'plain', ?, ?)`
  )
    .bind(password.hash, password.salt)
    .run();
  const plainUser = await getUserByUsername(env.DB, 'plain');
  const plainSession = await createSession(env, plainUser);
  const denied = await get(env, '/api/admin/distribution/tree', plainSession.token);
  assert.equal(denied.status, 403);
});
