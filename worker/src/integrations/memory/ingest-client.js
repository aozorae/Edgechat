/**
 * 采集事件摄取客户端（Chat 版 B 案：worker 持密文令牌代调 SAG `POST /ingest`）。
 * 对照《Chat版-完整形态-第一批施工方案-草案-20261031.md》乙案第 1 条：
 * - body 一律 `{ events: [...] }` 批量透传；采集开关 / 白名单判定在端上，本模块不做。
 * - 超时照 pi-client 的两档写法（默认 8 秒，最多放宽到 15 秒）。
 * - 失败只回 reason 对象、不抛异常；任何分支都不把令牌写进返回值或日志。
 *
 * 幂等去重键（端上离线攒批补发：不丢不重）：
 * - 单条 `event_id`：端上传 `eventId` 就用它（[A-Za-z0-9_-]{1,64}）；没传就按
 *   `type | ts | content | meta` 派生 sha256 前 32 位 —— 同一条事件重发必得同键。
 * - 整批 `batch_id`：端上传 `batchId` 就用它；没传就按本批 event_id 的原始顺序派生。
 * - 两个键随请求体一起透传给 SAG（`{ batch_id, events:[{ event_id, ... }] }`）。
 *   本模块只做「同一请求内」去重；跨批次去重依赖 SAG 按这两个键落库去重
 *   （worker 侧不新增表、不占 SESSIONS 的用例，避免动到既有部署面）。
 */

import { piBase } from "./pi-client.js";

/** 一批上限：方案硬口径 50 条/批，超出让端上拆批。 */
export const MAX_INGEST_EVENTS = 50;
/** 单条正文上限（字符）：超出直接 400 让端上改，不做静默截断（截断会改变去重键）。 */
export const MAX_INGEST_CONTENT_CHARS = 8000;
/** meta 序列化后上限（字符）：防止端上把音频等大对象塞进这条链路。 */
export const MAX_INGEST_META_CHARS = 2000;
/** 默认超时（与 pi-client 的 8 秒档一致）。 */
export const INGEST_TIMEOUT_MS = 8000;
/** 超时上限（与 pi-client 的 15 秒档一致）：调用方可显式放宽。 */
export const INGEST_TIMEOUT_MAX_MS = 15000;
/**
 * 首批启用的事件类型（端上 IngestQueue 口径）。
 * outgoing 属第二批启用，这里先收着不拒，避免端上先上后 400。
 */
export const INGEST_EVENT_TYPES = ["notification", "location_sample", "app_session", "outgoing"];

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function safeDetail(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 160);
}

/** 摄取地址：默认挂在 MEMORY_PI_BASE 下；MEMORY_INGEST_URL 可整条覆盖（不新增绑定）。 */
export function ingestUrl(env) {
  const override = String(env?.MEMORY_INGEST_URL || "").trim();
  if (override) return override.replace(/\/+$/, "");
  return `${piBase(env)}/ingest`;
}

/** 稳定序列化：meta 的键排序后输出，保证同一条事件在重发时得到同一个键。 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

/** sha256 前 32 位十六进制：够用且不把正文原文带进键里。 */
export async function fingerprintOf(...parts) {
  const data = new TextEncoder().encode(parts.join("\u0001"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 32);
}

/**
 * 归一化一批事件 + 生成幂等键。
 * 返回 { ok: true, events, batchId, skipped } 或 { ok: false, reason }（reason 直接给端上看的 400 文案）。
 * - content 只收字符串（音频等非文字内容在这一层就被挡掉，本链路不新增任何音频字段）。
 * - ts 必填且必须是毫秒时间戳：没有它就无法派生稳定去重键（拿 Date.now() 兜底会变成每截一次一个新键）。
 * - 同一请求内 event_id 重复的条目丢弃并计入 skipped（重发同批不会写出重复条目）。
 */
export async function normalizeIngestBatch(rawEvents, rawBatchId) {
  if (!Array.isArray(rawEvents)) return { ok: false, reason: "events 必须是数组" };
  if (!rawEvents.length) return { ok: false, reason: "events 不能为空" };
  if (rawEvents.length > MAX_INGEST_EVENTS) {
    return { ok: false, reason: `events 单批最多 ${MAX_INGEST_EVENTS} 条，请端上拆批` };
  }

  const events = [];
  const allIds = [];
  const seen = new Set();
  let skipped = 0;

  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "events 的每一项必须是对象" };
    }
    const type = String(raw.type || "").trim();
    if (!INGEST_EVENT_TYPES.includes(type)) {
      return { ok: false, reason: `type 只收 ${INGEST_EVENT_TYPES.join(" / ")}` };
    }
    if (typeof raw.content !== "string") {
      // 音频等非文字内容不进这条链路：本链路不接收 audio 字段，也不做转写
      return { ok: false, reason: "content 只收文字（字符串）" };
    }
    const content = raw.content.trim();
    if (!content) return { ok: false, reason: "content 不能为空" };
    if (raw.content.length > MAX_INGEST_CONTENT_CHARS) {
      return { ok: false, reason: `content 最长 ${MAX_INGEST_CONTENT_CHARS} 字` };
    }
    const ts = Number(raw.ts);
    if (!Number.isFinite(ts) || ts <= 0) {
      return { ok: false, reason: "ts 必须是毫秒时间戳" };
    }
    const meta = raw.meta === undefined || raw.meta === null ? {} : raw.meta;
    if (typeof meta !== "object" || Array.isArray(meta)) {
      return { ok: false, reason: "meta 必须是对象" };
    }
    const metaJson = stableJson(meta);
    if (metaJson.length > MAX_INGEST_META_CHARS) {
      return { ok: false, reason: `meta 最长 ${MAX_INGEST_META_CHARS} 字符` };
    }

    const providedId = raw.eventId ?? raw.event_id;
    let eventId = "";
    if (providedId !== undefined && providedId !== null && providedId !== "") {
      const text = String(providedId).trim();
      if (!KEY_PATTERN.test(text)) {
        return { ok: false, reason: "eventId 只允许字母/数字/-/_，最长 64" };
      }
      eventId = text;
    } else {
      eventId = await fingerprintOf(type, String(Math.floor(ts)), content, metaJson);
    }

    allIds.push(eventId);
    if (seen.has(eventId)) {
      skipped += 1;
      continue;
    }
    seen.add(eventId);
    events.push({ event_id: eventId, type, content, ts: Math.floor(ts), meta });
  }

  let batchId = "";
  const providedBatchId = rawBatchId ?? null;
  if (providedBatchId !== undefined && providedBatchId !== null && providedBatchId !== "") {
    const text = String(providedBatchId).trim();
    if (!KEY_PATTERN.test(text)) {
      return { ok: false, reason: "batchId 只允许字母/数字/-/_，最长 64" };
    }
    batchId = text;
  } else {
    batchId = await fingerprintOf("batch", allIds.join(","));
  }

  return { ok: true, events, batchId, skipped };
}

/**
 * 代调 SAG `POST /ingest`。
 * 返回 { ok, accepted, reason, status }；失败不抛异常（端上据此把整批留在 outbox 里补发）。
 * accepted 取 SAG 回包里的 accepted（认不出就按本批条数算）。
 */
export async function postIngest(env, token, events, { batchId = "", fetchImpl = fetch, timeoutMs = INGEST_TIMEOUT_MS } = {}) {
  const list = Array.isArray(events) ? events : [];
  if (!token) return { ok: false, accepted: 0, reason: "no_token", status: 0 };
  if (!list.length) return { ok: true, accepted: 0, reason: "", status: 0 };

  const wait = Math.min(Math.max(Number(timeoutMs) || INGEST_TIMEOUT_MS, 1000), INGEST_TIMEOUT_MAX_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), wait);
  try {
    const response = await fetchImpl(ingestUrl(env), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SAG-Token": token },
      body: JSON.stringify({ batch_id: batchId, events: list }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return { ok: false, accepted: 0, reason: `http_${response.status}`, status: response.status };
    }
    if (payload !== null && typeof payload !== "object") {
      return { ok: false, accepted: 0, reason: "bad_payload", status: response.status };
    }
    const accepted = Number.isFinite(Number(payload?.accepted)) ? Number(payload.accepted) : list.length;
    return { ok: true, accepted, reason: "", status: response.status };
  } catch (error) {
    const name = String(error?.name || "");
    return {
      ok: false,
      accepted: 0,
      reason: name === "AbortError" ? "timeout" : `network: ${safeDetail(error?.message || error)}`,
      status: 0
    };
  } finally {
    clearTimeout(timer);
  }
}