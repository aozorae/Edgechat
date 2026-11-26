import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiBase = 'https://api.cloudflare.com/client/v4';
const ruleId = 'edgechat-direct-v2';

export async function configureR2Direct({ accountId, apiToken, bucket, origins = [], fetchImpl = fetch, installSecret, workerName = 'cfchat' }) {
  async function api(path, init = {}) {
    const response = await fetchImpl(apiBase + path, { ...init, headers: {
      Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json',
    } });
    const data = await response.json();
    return { status: response.status, data };
  }
  function required(result, operation) {
    if (!result.data.success) throw new Error(operation + ' failed (HTTP ' + result.status + ', codes ' +
      (result.data.errors || []).map(e => e.code).join(',') + ')');
    return result.data.result;
  }
  const base = '/accounts/' + encodeURIComponent(accountId);
  // 用户令牌和账户令牌的 verify 路径不同。签名用 ID 与哈希；Worker 不接收管理 API bearer。
  let verification = await api('/user/tokens/verify');
  if (!verification.data.success) verification = await api(base + '/tokens/verify');
  const token = required(verification, 'Verify Cloudflare token');
  if (token.status !== 'active' || !token.id) throw new Error('Cloudflare deployment token is inactive');
  // 浏览器只发送对象/操作限定的签名，不带 Cookie。默认支持 fork 的 workers.dev、
  // 未登记在仓库的 Zone Route 和自定义域，部署者也可选填精确 origin。
  const allowedOrigins = origins.length ? [...new Set(origins.map(origin => new URL(origin).origin))].sort() : ['*'];
  const path = base + '/r2/buckets/' + encodeURIComponent(bucket) + '/cors';
  const current = await api(path);
  const missing = current.status === 404 && current.data.errors?.some(e => e.code === 10059);
  const rules = missing ? [] : required(current, 'Read R2 CORS').rules;
  const next = { id: ruleId, allowed: { origins: allowedOrigins, methods: ['GET', 'PUT'], headers: ['Range', 'Content-Type'] },
    exposeHeaders: ['ETag', 'Content-Range'], maxAgeSeconds: 3600 };
  const existing = rules.find(rule => rule.id === ruleId);
  const sameList = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...b].sort());
  if (!existing || !sameList(existing.allowed.origins, next.allowed.origins) || !sameList(existing.allowed.methods, next.allowed.methods)
      || !sameList(existing.allowed.headers, next.allowed.headers) || !sameList(existing.exposeHeaders, next.exposeHeaders)
      || existing.maxAgeSeconds !== next.maxAgeSeconds) {
    required(await api(path, { method: 'PUT', body: JSON.stringify({ rules: [...rules.filter(rule => rule.id !== ruleId), next] }) }), 'Configure R2 CORS');
  }
  const names = required(await api(base + '/workers/scripts/' + encodeURIComponent(workerName) + '/secrets'), 'List Worker secrets');
  if (!names.some(item => item.name === 'EDGECHAT_FILE_WRAPPING')) {
    // RSA 首次生成交给部署机，避免消耗免费 Worker 的请求 CPU。后续部署复用原公私钥。
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
    await installSecret('EDGECHAT_FILE_WRAPPING', { publicKey: pair.publicKey.toString('base64'), privateKey: pair.privateKey.toString('base64') });
  }
  await installSecret('EDGECHAT_R2_DIRECT', { accountId, bucket, accessKeyId: token.id, secretAccessKey: createHash('sha256').update(apiToken).digest('hex') });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const env = process.env;
  const require = createRequire(import.meta.url);
  const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  await configureR2Direct({
    accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN,
    bucket: env.R2_BUCKET_NAME, workerName: env.EDGECHAT_WORKER_NAME || 'cfchat',
    origins: (env.EDGECHAT_R2_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
    installSecret(name, value) {
      const child = spawnSync(process.execPath, [wrangler, 'secret', 'put', name, '--config', process.argv[2] || 'wrangler.ci.toml'], {
        input: JSON.stringify(value), stdio: ['pipe', 'inherit', 'inherit'],
      });
      if (child.status !== 0) throw new Error('Failed to install ' + name);
    },
  });
}
