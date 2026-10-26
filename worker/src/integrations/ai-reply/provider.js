/**
 * 期一增项：大模型出话（百炼 DashScope，OpenAI 兼容接口）。
 * 选型理由见《任务包-期一-增项-文本回复链-20261026.md》§二：
 * 派师傅 pi-agent 的 X-SAG-Token 锁 SAG 台账客户，而 Chat 版自动建号用户不在台账里，
 * 期一先用与语音同一把百炼 key 直连（服务端持 key），期二有映射后再切回派师傅。
 *
 * 安全：apiKey 只在请求头里使用，不打印、不入库、不返回客户端。
 */
export const DASHSCOPE_CHAT_ENDPOINT =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

const DETAIL_MAX_CHARS = 160;

function sanitizeDetail(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, DETAIL_MAX_CHARS);
}

/**
 * 请求一次补全。
 * 返回 { ok:true, content } 或 { ok:false, error }（error 为可入库的短标记，不含凭据）。
 */
export async function requestDashScopeReply({
  apiKey,
  model,
  messages,
  maxTokens = 400,
  timeoutMs = 15000,
  fetchImpl = fetch
} = {}) {
  if (!apiKey) return { ok: false, error: "missing_api_key" };
  if (!model) return { ok: false, error: "missing_model" };
  if (!Array.isArray(messages) || !messages.length) return { ok: false, error: "empty_context" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 15000, 1000));
  try {
    const response = await fetchImpl(DASHSCOPE_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: Math.min(Math.max(Number(maxTokens) || 400, 16), 2000),
        temperature: 0.7
      }),
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
      const detail = sanitizeDetail(
        payload?.error?.message || payload?.message || payload?.code || ""
      );
      return { ok: false, error: `http_${response.status}${detail ? `: ${detail}` : ""}` };
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "empty_reply" };
    }
    return { ok: true, content: content.trim().slice(0, 2000) };
  } catch (error) {
    const name = String(error?.name || "");
    if (name === "AbortError" || name === "TimeoutError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: `network_error: ${sanitizeDetail(error?.message || error)}` };
  } finally {
    clearTimeout(timer);
  }
}
