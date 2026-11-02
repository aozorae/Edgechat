import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import worker from '../worker/src/index.js';
import { createSession, hashPassword } from '../worker/src/auth.js';
import { getLoginVerification, saveLoginVerification } from '../worker/src/data/login-verification.ts';
import { verifyLoginSecurity } from '../worker/src/login-security.ts';
import { saveStealthSettings } from '../worker/src/data/stealth-settings.ts';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const SQL = await initSqlJs();
const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
const hashed = await hashPassword('test-password');
const origin = 'https://example.test';

function fixture() {
  const database = new SQL.Database();
  database.exec(schema);
  database.run(`INSERT INTO users (id, username, display_name, password_hash, password_salt, is_super_admin)
    VALUES (1, 'admin', 'Admin', ?, ?, 1), (2, 'member', 'Member', ?, ?, 0)`,
  [hashed.hash, hashed.salt, hashed.hash, hashed.salt]);
  const queries = [];
  const db = createD1Adapter(database);
  const env = { DB: { ...db, prepare(sql) { queries.push(sql); return db.prepare(sql); } }, SESSIONS: createKvAdapter(),
    EDGECHAT_TURNSTILE_SECRET_KEY: 'test-secret',
    LOGIN_RATE_LIMITER: { async limit() { return { success: true }; } },
    API_RATE_LIMITER: { async limit() { return { success: true }; } },
  };
  const request = (path, body, headers = {}, method = body ? 'POST' : 'GET') => worker.fetch(new Request(origin + path, {
    method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { waitUntil(promise) { promise.catch(() => {}); } });
  const changes = () => database.exec('SELECT total_changes()')[0].values[0][0];
  return { env, database, queries, request, changes };
}
const credentials = { username: 'admin', password: 'test-password' };

test('登录验证默认关闭，正常登录不请求 Turnstile，公开配置不包含 Secret', async (t) => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', () => assert.fail('disabled verification must not call Siteverify'));
  assert.deepEqual(await getLoginVerification(f.env.DB), { enabled: false, siteKey: '' });
  assert.deepEqual(await (await f.request('/api/auth/verification')).json(), { enabled: false, siteKey: '' });
  assert.equal((await f.request('/api/auth/login', credentials)).status, 200);
});

test('每次密码提交均重新验证：缺少、无效和复用 token 不查账号、不写 D1/KV', async (t) => {
  const f = fixture();
  await saveLoginVerification(f.env.DB, { enabled: true, siteKey: 'test-site' });
  const tokens = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const payload = JSON.parse(options.body);
    assert.equal(payload.secret, 'test-secret');
    assert.equal(payload.remoteip, '192.0.2.1');
    const reused = tokens.includes(payload.response);
    tokens.push(payload.response);
    return Response.json({ success: payload.response === 'valid' && !reused, action: 'login' });
  });
  const before = f.changes();
  for (const token of [undefined, 'invalid', 'invalid']) {
    f.queries.length = 0;
    assert.equal((await f.request('/api/auth/login', { ...credentials, turnstileToken: token })).status, 403);
    assert.ok(!f.queries.some((sql) => /FROM users/.test(sql)));
  }
  assert.equal(f.changes(), before);
  assert.equal(f.env.SESSIONS.values.size, 0);
  // 第一次验证通过但密码错误，第二次复用仍必须交给 Siteverify 拒绝。
  assert.equal((await f.request('/api/auth/login', { ...credentials, password: 'wrong', turnstileToken: 'valid' })).status, 401);
  assert.equal((await f.request('/api/auth/login', { ...credentials, turnstileToken: 'valid' })).status, 403);
  assert.equal(f.changes(), before);
  assert.deepEqual(tokens, ['invalid', 'invalid', 'valid', 'valid']);
});

test('验证通过才登录，v1 同样要求 token 且保持统一错误结构', async (t) => {
  const f = fixture();
  await saveLoginVerification(f.env.DB, { enabled: true, siteKey: 'test-site' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, action: 'login' }));
  assert.equal((await f.request('/api/auth/login', { ...credentials, turnstileToken: 'valid' })).status, 200);
  const denied = await f.request('/api/v1/auth/login', credentials);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'verification_required');
  const accepted = await f.request('/api/v1/auth/login', { ...credentials, turnstileToken: 'valid',
    device: { installationId: 'test-installation', name: 'Test device', appVersion: 'test' } });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await (await f.request('/api/v1/capabilities')).json()).loginVerification, { enabled: true, siteKey: 'test-site' });
});

test('错误 action、上游故障和缺失 Secret 不放行，也不写尝试计数', async (t) => {
  const f = fixture();
  await saveLoginVerification(f.env.DB, { enabled: true, siteKey: 'test-site' });
  const req = new Request(origin);
  const before = f.changes();
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, action: 'other' }));
  await assert.rejects(verifyLoginSecurity(f.env, req, 'token'), { code: 'verification_failed' });
  mock.mock.mockImplementation(async () => { throw new Error('sensitive upstream error'); });
  await assert.rejects(verifyLoginSecurity(f.env, req, 'token'), { code: 'verification_unavailable' });
  delete f.env.EDGECHAT_TURNSTILE_SECRET_KEY;
  await assert.rejects(verifyLoginSecurity(f.env, req, 'token'), { code: 'verification_unavailable' });
  assert.equal(f.changes(), before);
});

test('原生登录限流先于验证设置和密码读取，API 限流先于业务数据访问', async () => {
  const f = fixture();
  const keys = [];
  f.env.LOGIN_RATE_LIMITER.limit = async ({ key }) => { keys.push(key); return { success: false }; };
  const before = f.changes();
  const limited = await f.request('/api/auth/login', credentials);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  assert.deepEqual(keys, ['192.0.2.1']);
  assert.ok(!f.queries.some((sql) => /login_verification|FROM users/.test(sql)));
  f.env.API_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await f.request('/api/site')).status, 429);
  const v1 = await f.request('/api/v1/auth/login', credentials);
  assert.equal(v1.status, 429);
  assert.equal((await v1.json()).error.code, 'rate_limited');
  assert.equal(f.changes(), before);
});

test('后台仅超管可配置，启用前必须有两种 Key，关闭保留配置', async () => {
  const f = fixture();
  const user = await f.env.DB.prepare('SELECT * FROM users WHERE id = 1').first();
  const admin = await createSession(f.env, user);
  const headers = { Authorization: `Bearer ${admin.token}` };
  const initial = await f.request('/api/admin/login-verification', null, headers);
  assert.deepEqual(await initial.json(), { enabled: false, siteKey: '', secretConfigured: true });
  assert.equal((await f.request('/api/admin/login-verification', { enabled: true, siteKey: '' }, headers, 'PUT')).status, 400);
  assert.equal((await f.request('/api/admin/login-verification', { enabled: true, siteKey: 'test-site' }, headers, 'PUT')).status, 200);
  assert.equal((await f.request('/api/admin/login-verification', { enabled: false, siteKey: 'test-site' }, headers, 'PUT')).status, 200);
  assert.deepEqual(await getLoginVerification(f.env.DB), { enabled: false, siteKey: 'test-site' });
  const member = await createSession(f.env, await f.env.DB.prepare('SELECT * FROM users WHERE id = 2').first());
  assert.equal((await f.request('/api/admin/login-verification', null, { Authorization: `Bearer ${member.token}` })).status, 403);
});

test('隐身入口仅启用时渲染带 nonce 的验证脚本，表单不绕过验证与限流', async (t) => {
  const f = fixture();
  const settings = await saveStealthSettings(f.env.DB, true);
  assert.doesNotMatch(await (await f.request('/')).text(), /turnstile|<script/);
  await saveLoginVerification(f.env.DB, { enabled: true, siteKey: 'test-site' });
  const page = await f.request('/');
  assert.match(await page.text(), /execution: 'execute'/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);
  const submit = (token = '') => worker.fetch(new Request(origin + settings.loginPath, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...credentials, 'cf-turnstile-response': token }),
  }), f.env, { waitUntil() {} });
  const before = f.changes();
  assert.equal((await submit()).status, 403);
  assert.equal(f.changes(), before);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, action: 'login' }));
  assert.equal((await submit('valid')).status, 303);
  f.env.LOGIN_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await submit('valid')).status, 429);
});

test('Actions 模板默认带原生限流，Secret 使用 secret put，前端逐次提交才执行挑战', () => {
  const config = readFileSync(new URL('../wrangler.example.toml', import.meta.url), 'utf8');
  assert.match(config, /name = "LOGIN_RATE_LIMITER"[\s\S]*?limit = 10, period = 60/);
  assert.match(config, /name = "API_RATE_LIMITER"[\s\S]*?limit = 120, period = 60/);
  const workflow = readFileSync(new URL('../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8');
  assert.match(workflow, /wrangler secret put EDGECHAT_TURNSTILE_SECRET_KEY --config wrangler.ci.toml/);
  const component = readFileSync(new URL('../frontend/src/components/LoginVerification.vue', import.meta.url), 'utf8');
  assert.match(component, /execution: 'execute'/);
  assert.match(component, /onBeforeUnmount/);
  assert.match(component, /turnstile\?\.remove/);
});
