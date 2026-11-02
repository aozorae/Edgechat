import assert from 'node:assert/strict';
import test from 'node:test';
import { createD1Query } from '../.github/scripts/cloudflare-d1.ts';

const env = { CLOUDFLARE_API_TOKEN: 'test-only-token', CLOUDFLARE_ACCOUNT_ID: 'account', EDGECHAT_D1_DATABASE_ID: 'database' };

test('D1 API 使用目标账户数据库和绑定参数，不在 SQL 中拼接密码哈希', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query');
    assert.equal(options.headers.Authorization, 'Bearer test-only-token');
    assert.deepEqual(JSON.parse(options.body), { sql: 'SELECT id FROM users WHERE username = ?', params: ["root'one"] });
    return Response.json({ success: true, result: [{ results: [{ id: 1 }] }] });
  });
  assert.deepEqual(await createD1Query(env)('SELECT id FROM users WHERE username = ?', ["root'one"]), [{ id: 1 }]);
});

test('D1 API 校验配置且错误不暴露上游 SQL 或敏感内容', async (t) => {
  for (const key of Object.keys(env)) {
    assert.throws(() => createD1Query({ ...env, [key]: '' }), new RegExp(key));
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    success: false, errors: [{ message: 'sensitive-query-content' }],
  }));
  await assert.rejects(createD1Query(env)('UPDATE users SET password_hash = ?', ['sensitive-hash']), (error) => {
    assert.equal(error.message, 'Cloudflare D1 query failed with 200');
    return true;
  });
});
