#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseS3Config, usesCustomS3 } from "../../worker/src/storage/s3-config.ts";

const API_BASE_URL = "https://api.cloudflare.com/client/v4";

const LEGACY_D1_DATABASE_NAME = "cfchat-db";
const LEGACY_KV_NAMESPACE_TITLE = "cfchat-sessions";
const LEGACY_R2_BUCKET_NAME = "cfchat-files";
const R2_NOT_ENABLED_ERROR_CODE = 10042;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readEnv(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (value) {
      return value;
    }
  }

  return undefined;
}

function resourceNames(env) {
  return {
    d1DatabaseName:
      readEnv(env, "EDGECHAT_D1_DATABASE_NAME", "CFCHAT_D1_DATABASE_NAME") ??
      LEGACY_D1_DATABASE_NAME,
    kvNamespaceTitle:
      readEnv(env, "EDGECHAT_KV_NAMESPACE_TITLE", "CFCHAT_KV_NAMESPACE_TITLE") ??
      LEGACY_KV_NAMESPACE_TITLE,
    r2BucketName:
      readEnv(env, "EDGECHAT_R2_BUCKET_NAME", "CFCHAT_R2_BUCKET_NAME") ??
      LEGACY_R2_BUCKET_NAME,
  };
}

function setOutput(name, value) {
  const stringValue = String(value);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${stringValue}\n`);
  }
  console.log(`[output] ${name}=${stringValue}`);
}

function extractApiError(payload, fallback) {
  if (!payload || !Array.isArray(payload.errors) || payload.errors.length === 0) {
    return fallback;
  }
  return payload.errors.map((error) => `${error.code}: ${error.message}`).join("; ");
}

class CloudflareApiError extends Error {
  constructor({ method, path, status, payload, fallback }) {
    super(
      `Cloudflare API request failed (${method} ${path}): ${extractApiError(payload, fallback)}`,
    );
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = Array.isArray(payload?.errors) ? payload.errors : [];
  }
}

async function cloudflareRequest(
  { apiToken, fetchImpl },
  method,
  path,
  { query, body } = {},
) {
  const url = new URL(`${API_BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) {
      throw new CloudflareApiError({
        method,
        path,
        status: response.status,
        payload: null,
        fallback: text || `HTTP ${response.status}`,
      });
    }
    throw new Error(`Unable to parse Cloudflare API response: ${text}`);
  }

  if (!response.ok || payload?.success === false) {
    throw new CloudflareApiError({
      method,
      path,
      status: response.status,
      payload,
      fallback: "Unknown Cloudflare API error",
    });
  }

  return payload;
}

function normalizeD1Record(item) {
  return {
    id: item.uuid ?? item.id ?? item.database_id ?? "",
    name: item.name ?? "",
  };
}

function normalizeKvRecord(item) {
  return {
    id: item.id ?? "",
    title: item.title ?? "",
  };
}

function normalizeR2Record(item) {
  return {
    name: item.name ?? item.bucket_name ?? "",
  };
}

async function listD1Databases(context) {
  const all = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const payload = await cloudflareRequest(
      context,
      "GET",
      `/accounts/${context.accountId}/d1/database`,
      { query: { page, per_page: perPage } },
    );
    const records = Array.isArray(payload.result) ? payload.result.map(normalizeD1Record) : [];
    all.push(...records);

    const resultInfo = payload.result_info;
    const reachedLastPage =
      !resultInfo?.total_pages || Number(page) >= Number(resultInfo.total_pages);
    if (reachedLastPage) {
      break;
    }
    page += 1;
  }

  return all;
}

async function listKvNamespaces(context) {
  const all = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const payload = await cloudflareRequest(
      context,
      "GET",
      `/accounts/${context.accountId}/storage/kv/namespaces`,
      { query: { page, per_page: perPage } },
    );
    const records = Array.isArray(payload.result) ? payload.result.map(normalizeKvRecord) : [];
    all.push(...records);

    const resultInfo = payload.result_info;
    const noMorePages = !resultInfo?.total_pages || page >= resultInfo.total_pages;
    if (noMorePages) {
      break;
    }
    page += 1;
  }

  return all;
}

async function listR2Buckets(context) {
  const payload = await cloudflareRequest(
    context,
    "GET",
    `/accounts/${context.accountId}/r2/buckets`,
  );
  const raw = payload.result;
  const buckets = Array.isArray(raw) ? raw : Array.isArray(raw?.buckets) ? raw.buckets : [];
  return buckets.map(normalizeR2Record);
}

function isR2NotEnabledError(error) {
  return (
    error instanceof CloudflareApiError &&
    error.errors.length === 1 &&
    Number(error.errors[0]?.code) === R2_NOT_ENABLED_ERROR_CODE
  );
}

async function hasR2Access(context) {
  try {
    await cloudflareRequest(
      context,
      "GET",
      `/accounts/${context.accountId}/r2/buckets`,
      { query: { per_page: 1 } },
    );
    return true;
  } catch (error) {
    if (!isR2NotEnabledError(error)) {
      throw error;
    }

    // 10042 明确表示账户尚未开通 R2；只有这种情况允许部署降级，权限或凭据错误仍应中止。
    console.warn("R2 is not enabled for this Cloudflare account; deploying without FILES binding.");
    return false;
  }
}

async function ensureD1Database(context, d1DatabaseName) {
  const databases = await listD1Databases(context);
  const existing = databases.find((database) => database.name === d1DatabaseName && database.id);
  if (existing) {
    console.log(`D1 database already exists: ${d1DatabaseName} (${existing.id})`);
    return { id: existing.id, created: false };
  }

  console.log(`Creating D1 database: ${d1DatabaseName}`);
  const payload = await cloudflareRequest(
    context,
    "POST",
    `/accounts/${context.accountId}/d1/database`,
    { body: { name: d1DatabaseName } },
  );
  const id = payload.result?.uuid ?? payload.result?.id ?? payload.result?.database_id;
  if (!id) {
    throw new Error("D1 create response is missing database id");
  }

  return { id, created: true };
}

export async function ensureKvNamespace(
  context,
  kvNamespaceTitle = LEGACY_KV_NAMESPACE_TITLE,
) {
  const namespaces = await listKvNamespaces(context);
  const existing = namespaces.find(
    (namespace) => namespace.title === kvNamespaceTitle && namespace.id,
  );
  if (existing) {
    console.log(`KV namespace already exists: ${existing.title} (${existing.id})`);
    return { id: existing.id, title: existing.title, created: false };
  }

  console.log(`Creating KV namespace: ${kvNamespaceTitle}`);
  const payload = await cloudflareRequest(
    context,
    "POST",
    `/accounts/${context.accountId}/storage/kv/namespaces`,
    { body: { title: kvNamespaceTitle } },
  );
  const id = payload.result?.id;
  if (!id) {
    throw new Error("KV create response is missing namespace id");
  }

  return { id, title: kvNamespaceTitle, created: true };
}

export async function ensureR2Bucket(context, r2BucketName = LEGACY_R2_BUCKET_NAME) {
  if (!(await hasR2Access(context))) {
    return { available: false, created: false };
  }

  const buckets = await listR2Buckets(context);
  const existing = buckets.find((bucket) => bucket.name === r2BucketName);
  if (existing) {
    console.log(`R2 bucket already exists: ${r2BucketName}`);
    return { available: true, created: false };
  }

  console.log(`Creating R2 bucket: ${r2BucketName}`);
  await cloudflareRequest(context, "POST", `/accounts/${context.accountId}/r2/buckets`, {
    body: { name: r2BucketName },
  });
  return { available: true, created: true };
}

export async function ensureCloudflareResources({
  accountId,
  apiToken,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const names = resourceNames(env);
  const context = { accountId, apiToken, fetchImpl };
  const customS3 = usesCustomS3(env.EDGECHAT_S3);
  // 在任何云端写操作之前检查必填项；不探测外部服务，也不输出配置或凭据。
  if (customS3) parseS3Config(env.EDGECHAT_S3);

  console.log("Ensuring Cloudflare resources for production deployment...");
  console.log(`Target account: ${accountId}`);
  console.log(
    "Using legacy Cloudflare resource names by default to avoid creating a second production stack.",
  );

  const d1 = await ensureD1Database(context, names.d1DatabaseName);
  const kv = await ensureKvNamespace(context, names.kvNamespaceTitle);
  const r2 = customS3
    ? { available: false, created: false }
    : await ensureR2Bucket(context, names.r2BucketName);
  if (customS3) console.log("Custom S3 selected; skipping R2 provisioning without deleting existing buckets.");

  setOutput("d1_database_name", names.d1DatabaseName);
  setOutput("d1_database_id", d1.id);
  setOutput("d1_created", d1.created);
  setOutput("kv_namespace_title", kv.title);
  setOutput("kv_namespace_id", kv.id);
  setOutput("kv_created", kv.created);
  setOutput("r2_available", r2.available);
  setOutput("r2_bucket_name", names.r2BucketName);
  setOutput("r2_created", r2.created);

  return { d1, kv, r2 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  ensureCloudflareResources({
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
