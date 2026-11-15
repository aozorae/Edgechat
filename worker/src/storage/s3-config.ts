export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  forcePathStyle: boolean;
  sessionToken?: string;
}

/** 单个 Secret 即可启用；显式写 r2 可在下一次部署切回原生绑定。 */
export function usesCustomS3(value?: string): boolean {
  return Boolean(value?.trim() && value.trim() !== 'r2');
}

export function parseS3Config(value: string): S3Config {
  // 不回传 JSON 解析异常：异常内容可能包含管理员填写的凭据。
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(value);
  } catch {
    throw new Error('EDGECHAT_S3 必须是 JSON 配置，或填写 r2 使用原生 R2');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('EDGECHAT_S3 必须是 JSON 对象');
  }
  for (const key of ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new Error(`EDGECHAT_S3 缺少 ${key}`);
    }
  }
  let endpoint: URL;
  try {
    endpoint = new URL((config.endpoint as string).trim());
  } catch {
    throw new Error('S3 endpoint 必须是完整的 HTTPS 地址');
  }
  // 只保留传输安全底线，不引入服务商白名单、DNS 探测或预先连接测试。
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('S3 endpoint 请使用不含凭据、查询参数或片段的 HTTPS 地址');
  }
  const bucket = (config.bucket as string).trim();
  if (bucket === '.' || bucket === '..' || /[/\\]/.test(bucket)) {
    throw new Error('S3 bucket 请只填写桶名，不要填写路径');
  }
  if (config.forcePathStyle !== undefined && typeof config.forcePathStyle !== 'boolean') {
    throw new Error('S3 forcePathStyle 必须是 true 或 false');
  }
  for (const key of ['region', 'sessionToken']) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      throw new Error(`S3 ${key} 必须是字符串`);
    }
  }
  return {
    endpoint: endpoint.toString().replace(/\/+$/, ''),
    bucket,
    accessKeyId: (config.accessKeyId as string).trim(),
    secretAccessKey: (config.secretAccessKey as string).trim(),
    region: (config.region as string | undefined)?.trim() || 'us-east-1',
    forcePathStyle: config.forcePathStyle !== false,
    sessionToken: (config.sessionToken as string | undefined)?.trim() || undefined,
  };
}
