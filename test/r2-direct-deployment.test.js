import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { configureR2Direct } from '../.github/scripts/configure-r2-direct.mjs';

test('a fresh fork configures its provisioned bucket with just the existing deployment token', async () => {
  const accountId = 'f'.repeat(32);
  const bucket = 'new-install';
  let rules;
  let writes = 0;
  const secrets = new Map();
  let generatedPairs = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer example');
    if (url.endsWith('/user/tokens/verify')) return Response.json({ success: false }, { status: 403 });
    if (url.endsWith('/accounts/' + accountId + '/tokens/verify')) return Response.json({ success: true, result: { status: 'active', id: 'access-id' } });
    if (url.endsWith('/workers/scripts/cfchat/secrets')) return Response.json({ success: true, result: [...secrets.keys()].map(name => ({ name })) });
    assert.ok(url.endsWith('/accounts/' + accountId + '/r2/buckets/' + bucket + '/cors'));
    if (init.method === 'PUT') {
      rules = JSON.parse(init.body).rules;
      writes++;
    } else if (!rules) return Response.json({ success: false, errors: [{ code: 10059 }] }, { status: 404 });
    return Response.json({ success: true, result: { rules } });
  };
  const options = { accountId, apiToken: 'example', bucket, fetchImpl, installSecret(name, value) {
    if (name === 'EDGECHAT_FILE_WRAPPING') generatedPairs++;
    secrets.set(name, value);
  } };
  await configureR2Direct(options);
  const config = secrets.get('EDGECHAT_R2_DIRECT');
  assert.deepEqual(config, { accountId, bucket, accessKeyId: 'access-id', secretAccessKey: createHash('sha256').update('example').digest('hex') });
  assert.equal(rules[0].exposeHeaders.includes('ETag'), true);
  assert.deepEqual(rules[0].allowed.origins, ['*']);
  const other = { id: 'unrelated', allowed: { origins: ['https://other.example'], methods: ['GET'] } };
  rules.unshift(other);
  await configureR2Direct(options);
  assert.equal(writes, 1);
  await configureR2Direct({ ...options, origins: ['https://new.example'] });
  assert.equal(writes, 2);
  assert.equal(generatedPairs, 1);
  assert.deepEqual(rules[0], other);
  assert.deepEqual(rules[1].allowed.origins, ['https://new.example']);
  const workflow = readFileSync(new URL('../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Configure direct transfers'), workflow.indexOf('- name: Configure TURN secrets'));
  assert.match(step, /steps\.ensure_resources\.outputs\.r2_bucket_name/);
  assert.match(step, /steps\.ensure_resources\.outputs\.r2_available == 'true'/);
  assert.match(step, /node .github\/scripts\/configure-r2-direct.mjs wrangler.ci.toml/);
  assert.doesNotMatch(step, /secrets\.EDGECHAT_R2_DIRECT/);
});
