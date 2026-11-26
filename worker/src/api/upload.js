import {
  canAccessFile,
  getUploadedFileByClientId,
  getUploadedFileMetadata,
  recordUploadedFile
} from '../data/uploaded-files.js';
import { decryptAttachment, encryptAttachment } from '../encryption.js';
import { normalizeContentType, sanitizeFilename } from '../attachment-metadata.js';
import { validateSession } from '../session.js';
import { errorResponse, requestBodyTooLarge } from '../utils.js';
import { getFileStorage, hasFileStorage } from '../storage/index.ts';
import { proxyCeiling, uploadLimits } from '../storage/direct-config.ts';
import { isDirectFile, serveDirectFile } from '../storage/direct-read.ts';
import { ApiError } from '../errors.js';

const FILE_RESPONSE_CACHE_CONTROL = 'private, no-store';
const UPLOAD_BODY_OVERHEAD_BYTES = 1024 * 1024;
const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'text/xml',
  'application/xml'
]);

function isInlineContentType(contentType) {
  if (!contentType) {
    return false;
  }
  if (contentType === 'application/pdf') {
    return true;
  }
  if (contentType.startsWith('image/')) {
    return contentType !== 'image/svg+xml';
  }
	if (contentType.startsWith('video/')) {
		return true;
	}
	if (contentType.startsWith('audio/')) {
		return true;
	}
	return false;
}

function contentDispositionValue(kind, filename) {
  const safeUtf8 = sanitizeFilename(filename);
  const safeAscii = safeUtf8
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/"/g, '')
    .trim()
    .slice(0, 150) || 'file';
  return `${kind}; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(safeUtf8)}`;
}

export function validateUpload(env, file, maxFileSize) {
  if (file.size > maxFileSize) {
    throw new ApiError(`文件大小不能超过 ${Math.round(maxFileSize / 1024 / 1024)}MB`, 413);
  }

  const contentType = normalizeContentType(file.type);
  if (BLOCKED_MIME_TYPES.has(contentType)) {
    throw new ApiError('该文件类型不允许上传');
  }

  const allowed = String(env.ALLOWED_FILE_TYPES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (allowed.length && !allowed.some((prefix) => contentType.startsWith(prefix))) {
    throw new ApiError('该文件类型不允许上传');
  }
}

export function registerUploadRoutes(app) {
  app.post('/api/upload', async (c) => {
    if (!hasFileStorage(c.env)) {
      return errorResponse('当前部署没有绑定 R2，无法上传附件', 503);
    }

    const session = c.get('session');
    const maxFileSize = (await uploadLimits(c.env)).proxyBytes;
    if (requestBodyTooLarge(c.req.raw, maxFileSize + UPLOAD_BODY_OVERHEAD_BYTES)) {
      return errorResponse(`文件大小不能超过 ${Math.round(maxFileSize / 1024 / 1024)}MB`, 413);
    }
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return errorResponse('请选择文件');
    }

    try {
      const result = await saveUploadedFile(c.env, session, file, { maxFileSize });
      return c.json({ file: result.file });
    } catch (error) {
      const message = String(error?.message || '');
      if (message.startsWith('文件大小不能超过') || message === '该文件类型不允许上传') {
        return errorResponse(message, error.status || 400);
      }
      throw error;
    }
  });

  app.get('/files/:key{.+}', async (c) => {
    const key = decodeURIComponent(c.req.param('key'));
    const authorization = c.req.header('authorization') || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : new URL(c.req.url).searchParams.get('token') || '';
    const auth = token ? await validateSession(c.env, token) : null;
    const canRead = await canAccessFile(c.env.DB, key, auth?.ok ? auth.session.userId : null, [new URL(c.req.url).origin]);
    if (!canRead) {
      return new Response('Forbidden', { status: 403 });
    }
    const storage = getFileStorage(c.env);
    if (!storage) {
      return errorResponse('当前部署没有绑定 R2，无法读取附件', 503);
    }

    if (isDirectFile(key)) {
      const metadata = await getUploadedFileMetadata(c.env.DB, key);
      if (!metadata) return new Response('Not Found', { status: 404 });
      const type = metadata.contentType;
      const disposition = contentDispositionValue(isInlineContentType(type) ? 'inline' : 'attachment', metadata.filename);
      return serveDirectFile(c.env, key, metadata, c.req.raw, disposition);
    }
    const [object, fileMetadata] = await Promise.all([
      storage.get(key),
      getUploadedFileMetadata(c.env.DB, key)
    ]);
    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    let decrypted;
    try {
      decrypted = await decryptAttachment(c.env, await object.arrayBuffer(), key);
    } catch (error) {
      console.error('Failed to decrypt attachment', { key, error });
      throw error;
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('cache-control', FILE_RESPONSE_CACHE_CONTROL);
    if (object.uploaded) {
      headers.set('last-modified', object.uploaded.toUTCString());
    }

    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    headers.set(
      'content-security-policy',
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'"
    );

    const contentType =
      normalizeContentType(fileMetadata?.contentType) ||
      normalizeContentType(headers.get('content-type')) ||
      'application/octet-stream';
    headers.set('content-type', contentType);
    const inlineAllowed = isInlineContentType(contentType);
    const dispositionKind =
      inlineAllowed && !contentType.startsWith('text/') ? 'inline' : 'attachment';
    const filename =
      fileMetadata?.filename || object.customMetadata?.filename || key.split('/').pop() || 'file';
    headers.set('content-disposition', contentDispositionValue(dispositionKind, filename));

    return new Response(decrypted.bytes, { headers });
  });
}

export async function saveUploadedFile(env, session, file, { clientUploadId = null, maxFileSize = proxyCeiling(env) } = {}) {
  validateUpload(env, file, maxFileSize);
  const storage = getFileStorage(env);
  if (clientUploadId) {
    const existing = await getUploadedFileByClientId(env.DB, session.userId, clientUploadId);
    if (existing) return { file: existing, created: false };
  }

  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
  const key = `${session.userId}/${Date.now()}-${crypto.randomUUID()}${extension}`;
  const filename = sanitizeFilename(file.name);
  const contentType = normalizeContentType(file.type) || 'application/octet-stream';
  const encryptedFile = await encryptAttachment(env, await file.arrayBuffer(), key);
  await storage.put(key, encryptedFile, {
    httpMetadata: { contentType, cacheControl: FILE_RESPONSE_CACHE_CONTROL },
    customMetadata: { filename, edgechatEncryption: 'v1' }
  });

  try {
    await recordUploadedFile(env.DB, {
      key,
      ownerUserId: session.userId,
      filename,
      contentType,
      size: file.size,
      clientUploadId
    });
  } catch (error) {
    // 元数据失败或幂等键竞争时移除本次新对象，避免存储后端留下没有稳定引用的副本。
    try {
      await storage.delete(key);
    } catch (deleteError) {
      console.warn('Failed to delete orphaned upload after metadata error', deleteError);
    }
    if (clientUploadId && String(error?.message || error).includes('UNIQUE')) {
      const existing = await getUploadedFileByClientId(env.DB, session.userId, clientUploadId);
      if (existing) return { file: existing, created: false };
    }
    throw error;
  }

  return {
    created: true,
    file: {
      key,
      name: filename,
      type: contentType,
      size: file.size,
      url: `/files/${encodeURIComponent(key)}`
    }
  };
}
