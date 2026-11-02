/**
 * 甲（2026-10-30 老板拍板）：记忆库查询由服务端代调 V2。
 *
 * 背景：客户不再手填 SAG 令牌，令牌密文存在台账里，只在本模块作为请求头使用，
 * 不写日志、不返回客户端。V2 侧认 `Authorization: Bearer <sagk_ 或 v2dev_>`。
 *
 * 端点：GET {base}/v2/query/context?q=<可选>
 * 响应原样透传（facts / zhengju_bao / zhengju_bao_v2 / sheng_lve / xinxiandu），
 * 端上解析逻辑不变，只是不再自带令牌。
 */

const DEFAULT_V2_BASE = "https://qm.lanxingbei.cn";

export function v2Base(env) {
  return String(env.MEMORY_V2_BASE || DEFAULT_V2_BASE).replace(/\/+$/, "");
}

/**
 * 取记忆库上下文。
 * customerId：该用户的 SAG customer_id（台账里有）——V2 按它隔离各户的记忆池；
 * 不传时 V2 落到默认池 CUST-0001（旧行为），多户会串池，所以调用方必须传。
 * 返回 { ok, status, payload } 或 { ok:false, status, reason }；任何失败都不抛。
 */
export async function fetchMemoryContext(env, token, { customerId = "", q = "", timeoutMs = 5000, fetchImpl = fetch } = {}) {
  if (!token) return { ok: false, status: 0, reason: "no_token" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${v2Base(env)}/v2/query/context`);
    const uid = String(customerId || "").trim();
    if (uid) url.searchParams.set("user_id", uid);
    const text = String(q || "").trim();
    if (text) url.searchParams.set("q", text.slice(0, 200));
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, reason: `http_${response.status}` };
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, status: response.status, reason: "bad_json" };
    }
    return { ok: true, status: response.status, payload };
  } catch (error) {
    const name = String(error?.name || "");
    return { ok: false, status: 0, reason: name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}