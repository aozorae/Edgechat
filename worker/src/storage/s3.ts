import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';
import { ApiError } from '../errors.js';
import type { S3Config } from './s3-config.ts';

interface PutOptions {
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
}

interface ListOptions {
  limit?: number;
  cursor?: string;
  include?: string[];
}

const METADATA_HEADER = 'x-amz-meta-edgechat-json';
const HTTP_METADATA = ['content-type', 'cache-control', 'content-disposition', 'content-language', 'content-encoding', 'expires'];
const xml = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === 'Contents',
});

function storageError(): ApiError {
  // 上游响应、URL、签名及异常 cause 都不流入 API、日志或 GC 的 last_error。
  return new ApiError('对象存储请求失败，请检查 S3 配置或稍后重试', 502, 'storage_unavailable');
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function readMetadata(headers: Headers): Record<string, string> {
  const encoded = headers.get(METADATA_HEADER);
  if (encoded) {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))));
  }
  // 兼容从 R2/S3 原样复制的旧元数据；新对象使用单个 ASCII 头保存中文文件名。
  return Object.fromEntries([...headers]
    .filter(([name]) => name.startsWith('x-amz-meta-'))
    .map(([name, value]) => [name.slice('x-amz-meta-'.length), value]));
}

/** 只实现业务实际使用的 R2 子集，签名交给 aws4fetch，不维护第二套业务存储逻辑。 */
export class S3Storage {
  private readonly client: AwsClient;
  private readonly config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      service: 's3',
      region: config.region,
      // GC 已有持久化重试预算，适配器不额外放大网络调用次数。
      retries: 0,
    });
  }

  private url(key?: string): URL {
    const url = new URL(this.config.endpoint);
    const base = url.pathname.replace(/\/+$/, '');
    if (this.config.forcePathStyle) {
      url.pathname = `${base}/${encodeSegment(this.config.bucket)}`;
    } else {
      url.hostname = `${this.config.bucket}.${url.hostname}`;
      url.pathname = base || '/';
    }
    if (key !== undefined) {
      // WHATWG URL 会折叠点路径；拒绝它以免一次删除误指向另一对象。
      if (!key || key.split('/').some((segment) => segment === '.' || segment === '..')) throw storageError();
      url.pathname = `${url.pathname.replace(/\/$/, '')}/${key.split('/').map(encodeSegment).join('/')}`;
    }
    return url;
  }

  private async request(url: URL, method: string, options: { body?: ArrayBuffer | Uint8Array; headers?: Headers } = {}): Promise<Response> {
    try {
      const request = await this.client.sign(url, {
        method,
        ...options,
        // 凭据只发往配置的地址，不跟随服务商重定向到其他主机。
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      return await fetch(request);
    } catch {
      throw storageError();
    }
  }

  async put(key: string, body: ArrayBuffer | Uint8Array, options: PutOptions = {}): Promise<void> {
    const headers = new Headers();
    if (options.httpMetadata?.contentType) headers.set('content-type', options.httpMetadata.contentType);
    if (options.httpMetadata?.cacheControl) headers.set('cache-control', options.httpMetadata.cacheControl);
    if (options.customMetadata) {
      headers.set(METADATA_HEADER, btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(options.customMetadata)))));
    }
    const response = await this.request(this.url(key), 'PUT', { body, headers });
    await response.body?.cancel();
    if (!response.ok) throw storageError();
  }

  async get(key: string) {
    const response = await this.request(this.url(key), 'GET');
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return null;
      throw storageError();
    }
    let customMetadata: Record<string, string>;
    try {
      customMetadata = readMetadata(response.headers);
    } catch {
      await response.body?.cancel();
      throw storageError();
    }
    return {
      customMetadata,
      uploaded: response.headers.has('last-modified') ? new Date(response.headers.get('last-modified') as string) : undefined,
      async arrayBuffer(): Promise<ArrayBuffer> {
        try {
          return await response.arrayBuffer();
        } catch {
          throw storageError();
        }
      },
      writeHttpMetadata(headers: Headers) {
        for (const name of HTTP_METADATA) {
          const value = response.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
      },
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.request(this.url(key), 'DELETE');
    await response.body?.cancel();
    // S3 删除不存在的 key 本来就是成功；404 可能是桶不存在，不能当作清理成功。
    if (!response.ok) throw storageError();
  }

  async list({ limit = 1000, cursor }: ListOptions = {}) {
    const url = this.url();
    url.searchParams.set('list-type', '2');
    url.searchParams.set('encoding-type', 'url');
    url.searchParams.set('max-keys', String(Math.min(Math.max(Math.floor(limit), 1), 1000)));
    if (cursor) url.searchParams.set('continuation-token', cursor);
    const response = await this.request(url, 'GET');
    if (!response.ok) {
      await response.body?.cancel();
      throw storageError();
    }
    try {
      const text = await response.text();
      // ListObjectsV2 不需要 DTD，拒绝实体声明以避免 XML 实体扩展。
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw storageError();
      const result = xml.parse(text, true).ListBucketResult;
      if (!result || !['true', 'false'].includes(result.IsTruncated)) throw storageError();
      const truncated = result.IsTruncated === 'true';
      if (truncated && (!result.NextContinuationToken || result.NextContinuationToken === cursor)) throw storageError();
      const objects = (result.Contents || []).map((item: { Key: string; Size: string; LastModified: string }) => {
        const key = result.EncodingType === 'url' ? decodeURIComponent(item.Key) : item.Key;
        const size = Number(item.Size);
        const uploaded = new Date(item.LastModified);
        if (typeof key !== 'string' || !Number.isFinite(size) || size < 0 || !Number.isFinite(uploaded.getTime())) throw storageError();
        return { key, size, uploaded };
      });
      return { objects, truncated, cursor: truncated ? result.NextContinuationToken as string : undefined };
    } catch {
      throw storageError();
    }
  }
}
