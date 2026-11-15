import { ApiError } from '../errors.js';
import { parseS3Config, usesCustomS3 } from './s3-config.ts';
import { S3Storage } from './s3.ts';

const clients = new WeakMap<object, { value: string; storage: S3Storage }>();

export function hasFileStorage(env: { FILES?: unknown; EDGECHAT_S3?: string }): boolean {
  return usesCustomS3(env.EDGECHAT_S3) || Boolean(env.FILES);
}

export function getFileStorage<T>(env: { FILES?: T; EDGECHAT_S3?: string }): T | S3Storage | undefined {
  // 默认直接返回原生 binding，旧部署不增加配置、探测或网络跳转。
  if (!usesCustomS3(env.EDGECHAT_S3)) return env.FILES;
  const value = env.EDGECHAT_S3 as string;
  const cached = clients.get(env);
  if (cached?.value === value) return cached.storage;
  let storage: S3Storage;
  try {
    storage = new S3Storage(parseS3Config(value));
  } catch {
    // 配错时不能悄悄写回 R2，否则数据会散落两处，统计与清理也会失真。
    throw new ApiError('自定义 S3 配置无效，请联系管理员检查 EDGECHAT_S3', 503, 'storage_unavailable');
  }
  clients.set(env, { value, storage });
  return storage;
}
