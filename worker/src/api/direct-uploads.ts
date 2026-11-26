import { chunkCount, partBytes, cipherSize } from '../../../frontend/public/attachment-crypto.js';
import { normalizeContentType, sanitizeFilename } from '../attachment-metadata.js';
import { decryptSecretValue, encryptSecretValue } from '../encryption.js';
import { ApiError } from '../errors.js';
import { parseJsonRequest } from '../utils.js';
import { directEnabled, directSigner, uploadLimits } from '../storage/direct-config.ts';
import { sealFileKey, uploadPublicKey } from '../storage/file-keys.ts';
import { validateUpload } from './upload.js';

const ticketContext = user => 'r2-multipart-v2:' + user;
const ticketLifetime = 4 * 60 * 60 * 1000;
const publishedFile = t => ({ key: t.key, name: t.name, type: t.type, size: t.size, url: '/files/' + encodeURIComponent(t.key) });

async function openTicket(env, owner, value) {
  let ticket;
  try { ticket = JSON.parse(await decryptSecretValue(env, value, ticketContext(owner))); }
  catch { throw new ApiError('上传凭据无效', 403); }
  if (Date.now() >= ticket.expires) throw new ApiError('上传已过期，请重新选择文件', 410);
  return ticket;
}

export function registerDirectUploads(app) {
  app.get('/api/uploads/options', async c => {
    const { bytes } = await uploadLimits(c.env);
    c.header('Cache-Control', 'private, no-store');
    const direct = directEnabled(c.env);
    return c.json({ maxBytes: bytes, publicKey: direct ? uploadPublicKey(c.env) : null,
      keyLabel: 'edgechat-upload:' + c.get('session').userId });
  });
  app.use('/api/uploads/direct/*', async (c, next) => {
    if (!directEnabled(c.env)) throw new ApiError('当前部署未启用 R2 直传', 503);
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.post('/api/uploads/direct/start', async c => {
    const env = c.env;
    const owner = c.get('session').userId;
    const { name, type, size, wrapped } = await parseJsonRequest(c.req.raw);
    if (!Number.isSafeInteger(size) || size < 0 || typeof wrapped !== 'string' || wrapped.length !== 344) {
      throw new ApiError('附件参数无效');
    }
    const contentType = normalizeContentType(type) || 'application/octet-stream';
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) throw new ApiError('该文件类型不允许上传');
    validateUpload(env, { size, type: contentType }, (await uploadLimits(env)).bytes);
    const key = owner + '/direct-v2/' + crypto.randomUUID();
    const filekey = await sealFileKey(env, wrapped, key, owner);
    const upload = await env.FILES.createMultipartUpload(key, {
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' },
      customMetadata: { filekey },
    });
    // 只有 Worker 可完成分片。预留延迟清理项，以便回收完成 R2 后、登记 D1 前中断的对象。
    await env.DB.prepare("INSERT INTO pending_r2_delete (object_key, next_retry_at, last_error) VALUES (?, datetime('now','+1 day'), 'direct_upload_pending')").bind(key).run();
    const data = { key, uploadId: upload.uploadId, name: sanitizeFilename(name), type: contentType, size, expires: Date.now() + ticketLifetime };
    return c.json({ key, ticket: await encryptSecretValue(env, JSON.stringify(data), ticketContext(owner)) });
  });
  app.post('/api/uploads/direct/parts', async c => {
    const { ticket, first } = await parseJsonRequest(c.req.raw);
    const data = await openTicket(c.env, c.get('session').userId, ticket);
    const count = chunkCount(data.size);
    if (!Number.isInteger(first) || first < 0 || first >= count) throw new ApiError('分片序号无效');
    const sign = directSigner(c.env);
    const urls = await Promise.all(Array.from({ length: Math.min(8, count - first) }, (_, n) => {
      const index = first + n;
      return sign(data.key, { uploadId: data.uploadId, number: index + 1, bytes: partBytes(data.size, index) });
    }));
    return c.json({ urls });
  });
  app.post('/api/uploads/direct/finish', async c => {
    const env = c.env;
    const owner = c.get('session').userId;
    const { ticket, etags } = await parseJsonRequest(c.req.raw);
    const data = await openTicket(env, owner, ticket);
    const { key, size } = data;
    if (!Array.isArray(etags) || etags.length !== chunkCount(size) ||
        etags.some(tag => typeof tag !== 'string' || !/^[a-f\d]{32}$/i.test(tag))) throw new ApiError('分片清单无效');
    const db = env.DB;
    const published = () => db.prepare('SELECT 1 AS ok FROM uploaded_files WHERE object_key = ? AND owner_user_id = ?').bind(key, owner).first();
    if (await published()) return c.json({ file: publishedFile(data) });
    validateUpload(env, data, (await uploadLimits(env)).bytes);
    let object = await env.FILES.head(key);
    if (!object) {
      const upload = env.FILES.resumeMultipartUpload(key, data.uploadId);
      try { object = await upload.complete(etags.map((etag, i) => ({ partNumber: i + 1, etag }))); }
      catch {
        // 并发完成或上次响应丢失时，R2 中已完成的对象仍可登记。
        object = await env.FILES.head(key);
        if (!object) throw new ApiError('附件分片未完成', 409);
      }
    }
    if (object.size !== cipherSize(size)) throw new ApiError('附件大小与申报不符', 413);
    // 分片 URL 在 complete 后失效；登记和解除删除预留同事务执行，重试不会复活已删附件。
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO uploaded_files (object_key, owner_user_id, filename, content_type, size)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pending_r2_delete
        WHERE object_key = ? AND last_error = 'direct_upload_pending' AND next_retry_at > CURRENT_TIMESTAMP)`)
        .bind(key, owner, data.name, data.type, size, key),
      db.prepare(`DELETE FROM pending_r2_delete WHERE object_key = ? AND last_error = 'direct_upload_pending'
        AND next_retry_at > CURRENT_TIMESTAMP AND EXISTS (SELECT 1 FROM uploaded_files WHERE object_key = ?)`).bind(key, key),
    ]);
    if (!await published()) throw new ApiError('上传已过期，请重新选择文件', 410);
    return c.json({ file: publishedFile(data) });
  });
}
