import { decryptSecretValue, encryptSecretValue } from '../encryption.js';
import { encode64, decode64 } from '../../../frontend/public/attachment-crypto.js';
import { ApiError } from '../errors.js';

const algorithm = { name: 'RSA-OAEP', hash: 'SHA-256' };
export function uploadPublicKey(env) {
  return JSON.parse(env.EDGECHAT_FILE_WRAPPING).publicKey;
}

export async function sealFileKey(env, wrapped: string, objectKey: string, owner: number) {
  const keys = JSON.parse(env.EDGECHAT_FILE_WRAPPING);
  const privateKey = await crypto.subtle.importKey('pkcs8', decode64(keys.privateKey), algorithm, false, ['decrypt']);
  let raw;
  try {
    raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode('edgechat-upload:' + owner) }, privateKey, decode64(wrapped));
    if (raw.byteLength !== 32) throw new Error();
  } catch { throw new ApiError('附件密钥格式无效'); }
  return encryptSecretValue(env, encode64(raw), 'file-key:' + objectKey);
}

export const openFileKey = (env, sealed, key) => decryptSecretValue(env, sealed, 'file-key:' + key);
