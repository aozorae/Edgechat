// 与 Service Worker 从同源静态资源加载同一协议实现，避免分块或 nonce 规则分叉。
export async function uploadDirect(file: File, options, request) {
  const modulePath = '/attachment-crypto.js';
  const { CHUNK_BYTES, chunkCount, chunkAlgorithm, decode64, encode64 } = await import(/* @vite-ignore */ modulePath);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const pub = await crypto.subtle.importKey('spki', decode64(options.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const wrapped = encode64(await crypto.subtle.encrypt({
    name: 'RSA-OAEP', label: new TextEncoder().encode(options.keyLabel),
  }, pub, raw));
  const post = (path, body) => request('/uploads/direct/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  const { key, ticket } = await post('start', { name: file.name, size: file.size, type: file.type, wrapped });
  const etags = [];
  const count = chunkCount(file.size);
  while (etags.length < count) {
    const { urls } = await post('parts', { ticket, first: etags.length });
    for (const url of urls) {
      const i = etags.length;
      const plain = await file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer();
      const body = await crypto.subtle.encrypt(chunkAlgorithm(key, file.size, i), aes, plain);
      const response = await fetch(url, { method: 'PUT', body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      const etag = response.headers.get('etag')?.replace(/^"|"$/g, '');
      if (!response.ok || !etag) throw new Error('R2 上传失败，请检查网络或存储桶 CORS 配置');
      etags.push(etag);
    }
  }
  return post('finish', { ticket, etags });
}
