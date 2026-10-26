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
