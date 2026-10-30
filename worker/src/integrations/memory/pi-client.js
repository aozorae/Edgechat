/**
 * TASK-133：派师傅记忆接口客户端（worker 侧代调，每用户自己的 X-SAG-Token）。
 * 契约：TASK-114\契约-跨对话记忆接口-简版.md（字段不变）
 * - GET  /api/session/opening   只透传 session_recap_prompt
 * - POST /api/session/ended     ended_at 毫秒必填，202 即成功
 *
 * 安全：令牌只在本模块作为请求头使用，不写日志、不返回客户端。
 */

const DEFAULT_PI_BASE = "https://sag.lanxingbei.cn/pi";

export function piBase(env) {
  return String(env.MEMORY_PI_BASE || DEFAULT_PI_BASE).replace(/\/+$/, "");
}

function safeDetail(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 160);
}

/**
 * 取开场摘要。
 * 返回 { available: boolean, prompt: string, reason: string, status: number }
 * 任何失败都返回 available=false（上层退化为现状，不报错、不硬塞）。
 */
export async function fetchSessionOpening(env, token, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!token) return { available: false, prompt: "", reason: "no_token", status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${piBase(env)}/api/session/opening`, {
      method: "GET",
      headers: { "X-SAG-Token": token },
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return { available: false, prompt: "", reason: `http_${response.status}`, status: response.status };
    }
    const available = Boolean(payload?.available);
    const prompt = String(payload?.session_recap_prompt || "").trim();
    if (!available || !prompt) {
      return {
        available: false,
        prompt: "",
        reason: String(payload?.reason || "none"),
        status: response.status
      };
    }
    return { available: true, prompt, reason: "", status: response.status };
  } catch (error) {
    const name = String(error?.name || "");
    return {
      available: false,
      prompt: "",
      reason: name === "AbortError" ? "timeout" : `network: ${safeDetail(error?.message || error)}`,
      status: 0
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TASK-167：提交派师傅任务。
 * POST /api/task {kind, params} → {ok, id}；kind = ask / search / patrol。
 * 返回 { ok: boolean, id: string, reason: string, status: number }；失败不抛异常、不携带令牌。
 */
export async function submitPiTask(env, token, kind, params = {}, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!token) return { ok: false, id: "", reason: "no_token", status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${piBase(env)}/api/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SAG-Token": token },
      body: JSON.stringify({ kind: String(kind || "ask"), params: params || {} }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return { ok: false, id: "", reason: `http_${response.status}`, status: response.status };
    }
    if (!payload?.ok || !payload?.id) {
      return { ok: false, id: "", reason: "bad_payload", status: response.status };
    }
    return { ok: true, id: String(payload.id), reason: "", status: response.status };
  } catch (error) {
    const name = String(error?.name || "");
    return {
      ok: false,
      id: "",
      reason: name === "AbortError" ? "timeout" : `network: ${safeDetail(error?.message || error)}`,
      status: 0
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TASK-167：拉取派师傅任务列表。
 * GET /api/tasks → {tasks:[{id,status,result}]}，status = queued/running/done/error。
 * 返回 { ok: boolean, tasks: Array, reason: string, status: number }。
 */
export async function fetchPiTasks(env, token, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!token) return { ok: false, tasks: [], reason: "no_token", status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${piBase(env)}/api/tasks`, {
      method: "GET",
      headers: { "X-SAG-Token": token },
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return { ok: false, tasks: [], reason: `http_${response.status}`, status: response.status };
    }
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    return { ok: true, tasks, reason: "", status: response.status };
  } catch (error) {
    const name = String(error?.name || "");
    return {
      ok: false,
      tasks: [],
      reason: name === "AbortError" ? "timeout" : `network: ${safeDetail(error?.message || error)}`,
      status: 0
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TASK-167：取主动问候判定。
 * POST /api/proactive {lastInteractAt[, force]} → {due,dormant,question,nextDueAt}。
 * 生成可能较慢，超时放宽到 15 秒。
 * 返回 { ok: boolean, payload: Object|null, reason: string, status: number }。
 */
export async function fetchPiProactive(
  env,
  token,
  lastInteractAt,
  force = false,
  { fetchImpl = fetch, timeoutMs = 15000 } = {}
) {
  if (!token) return { ok: false, payload: null, reason: "no_token", status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = { lastInteractAt: Number(lastInteractAt) || Date.now() };
    if (force) body.force = true;
    const response = await fetchImpl(`${piBase(env)}/api/proactive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SAG-Token": token },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return { ok: false, payload: null, reason: `http_${response.status}`, status: response.status };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, payload: null, reason: "bad_payload", status: response.status };
    }
    return { ok: true, payload, reason: "", status: response.status };
  } catch (error) {
    const name = String(error?.name || "");
    return {
      ok: false,
      payload: null,
      reason: name === "AbortError" ? "timeout" : `network: ${safeDetail(error?.message || error)}`,
      status: 0
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 上报会话结束（异步生成，202 即成功）。
 * 返回 HTTP 状态码；0 表示网络失败/超时。
 */
export async function reportSessionEnded(
  env,
  token,
  { sessionId, startedAt, endedAt, turnCount = 0, lastUserText = "" },
  { fetchImpl = fetch, timeoutMs = 4000 } = {}
) {
  if (!token) return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      session_id: String(sessionId || "").slice(0, 128),
      started_at: Number(startedAt) || Number(endedAt) || Date.now(),
      ended_at: Number(endedAt) || Date.now(),
      turn_count: Math.max(Number(turnCount) || 0, 0),
      last_user_text: String(lastUserText || "").slice(0, 200)
    };
    const response = await fetchImpl(`${piBase(env)}/api/session/ended`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SAG-Token": token },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return response.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}
