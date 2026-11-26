import { decryptedResponse } from '../../../frontend/public/attachment-crypto.js';
import { getFileStorage } from './index.ts';
import { directEnabled, directSigner } from './direct-config.ts';
import { openFileKey } from './file-keys.ts';

export const isDirectFile = key => /^\d+\/direct-v2\/[a-f0-9-]{36}$/.test(key);

export async function serveDirectFile(env, key, meta, request: Request, disposition: string) {
  const storage = getFileStorage(env);
  const object = await storage.head(key);
  if (!object) return new Response('Not Found', { status: 404 });
  const secret = await openFileKey(env, object.customMetadata?.filekey, key);
  const headers = {
    'content-type': meta.contentType || 'application/octet-stream', 'content-disposition': disposition,
    'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
  };
  const info = { key, size: meta.size, secret, headers };
  if (request.headers.get('x-edgechat-file') === 'descriptor' && directEnabled(env)) {
    return Response.json({ ...info, url: await directSigner(env)(key) }, {
      headers: { 'cache-control': 'private, no-store', 'x-edgechat-descriptor': 'v2', 'x-content-type-options': 'nosniff', 'vary': 'X-EdgeChat-File' },
    });
  }
  // 无 Service Worker 的浏览器、旧客户端和 Telegram 都能按块读取同一份历史密文。
  return decryptedResponse(info, request.headers.get('range'), async (offset, length) => {
    const ranged = await storage.get(key, { range: { offset, length } });
    if (!ranged?.body) throw new Error('附件读取失败');
    return ranged.body;
  });
}
