import { AwsClient } from 'aws4fetch';
import { usesCustomS3 } from './s3-config.ts';

export const MIB = 1024 * 1024;
export const DIRECT_MAX_MIB = 1024;
export const proxyCeiling = env => Number(env.MAX_FILE_SIZE || 20 * MIB);
export const directEnabled = env => Boolean(env.FILES && env.EDGECHAT_R2_DIRECT && env.EDGECHAT_FILE_WRAPPING && !usesCustomS3(env.EDGECHAT_S3));

export async function uploadLimits(env) {
  const row = await env.DB.prepare("SELECT setting_value FROM site_settings WHERE setting_key = 'max_upload_bytes'").first();
  const proxy = proxyCeiling(env);
  const maximum = directEnabled(env) ? Math.max(proxy, DIRECT_MAX_MIB * MIB) : proxy;
  const bytes = Math.min(Number(row?.setting_value || proxy), maximum);
  return { bytes, proxyBytes: Math.min(proxy, bytes), maximum };
}

export function directSigner(env) {
  const { accountId, bucket, accessKeyId, secretAccessKey } = JSON.parse(env.EDGECHAT_R2_DIRECT);
  if (!/^[a-f\d]{32}$/.test(accountId) || !/^[a-z0-9-]+$/.test(bucket) || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 直传配置无效');
  }
  const client = new AwsClient({ service: 's3', region: 'auto', accessKeyId, secretAccessKey });
  return async (key, part?: { uploadId: string; number: number; bytes: number }) => {
    const url = new URL('https://' + accountId + '.r2.cloudflarestorage.com/' + bucket + '/' + key);
    url.searchParams.set('X-Amz-Expires', part ? '3600' : '300');
    if (part) {
      url.searchParams.set('partNumber', String(part.number));
      url.searchParams.set('uploadId', part.uploadId);
    }
    // 浏览器按 ArrayBuffer 长度自动发送 Content-Length；签入它可阻止放大临时分片。
    const signed = await client.sign(url, {
      method: part ? 'PUT' : 'GET', headers: part ? { 'content-length': String(part.bytes) } : {},
      aws: { signQuery: true, allHeaders: true },
    });
    return signed.url;
  };
}
