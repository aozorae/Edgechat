// 每个附件使用独立的随机 AES-256 密钥。块号作为 nonce，AAD 绑定对象、总长度与顺序。
export const CHUNK_BYTES = 8 * 1024 * 1024;
export const TAG_BYTES = 16;
export const chunkCount = size => Math.max(1, Math.ceil(size / CHUNK_BYTES));
export const partBytes = (size, index) => Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES) + TAG_BYTES;
export const cipherSize = size => size + chunkCount(size) * TAG_BYTES;
export const encode64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const decode64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export function chunkAlgorithm(key, size, index) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(JSON.stringify(['edgechat-file-v2', key, size, index])) };
}

export function plaintextRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return start <= end && start < size ? { start, end, partial: true } : null;
}

// 浏览器和旧客户端的服务端兼容路径共享此读取器；每次最多保留一个密文块及其明文。
export async function decryptedResponse(info, rangeHeader, openCiphertext) {
  const { key, size, secret } = info;
  const range = plaintextRange(rangeHeader, size);
  const headers = new Headers(info.headers);
  headers.set('accept-ranges', 'bytes');
  if (!range) {
    headers.set('content-range', 'bytes */' + size);
    return new Response(null, { status: 416, headers });
  }
  const first = Math.floor(range.start / CHUNK_BYTES);
  const last = Math.max(0, Math.floor(range.end / CHUNK_BYTES));
  const offset = first * (CHUNK_BYTES + TAG_BYTES);
  const length = last * (CHUNK_BYTES + TAG_BYTES) + partBytes(size, last) - offset;
  const aes = await crypto.subtle.importKey('raw', decode64(secret), 'AES-GCM', false, ['decrypt']);
  const reader = (await openCiphertext(offset, length)).getReader();
  let index = first;
  let left = new Uint8Array();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const block = new Uint8Array(partBytes(size, index));
        let filled = 0;
        while (filled < block.length) {
          if (!left.length) {
            const { value, done } = await reader.read();
            if (done) throw new Error('附件数据不完整');
            left = value;
          }
          const take = Math.min(left.length, block.length - filled);
          block.set(left.subarray(0, take), filled);
          filled += take;
          left = left.subarray(take);
        }
        const plain = new Uint8Array(await crypto.subtle.decrypt(chunkAlgorithm(key, size, index), aes, block));
        const base = index * CHUNK_BYTES;
        if (plain.length) controller.enqueue(plain.subarray(Math.max(0, range.start - base), range.end - base + 1));
        if (index++ === last) {
          controller.close();
          await reader.cancel();
        }
      } catch (error) {
        controller.error(error);
        await reader.cancel().catch(() => {});
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  headers.set('content-length', String(range.end - range.start + 1));
  if (range.partial) headers.set('content-range', 'bytes ' + range.start + '-' + range.end + '/' + size);
  return new Response(stream, { status: range.partial ? 206 : 200, headers });
}
