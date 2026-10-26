import {
  getMemoryAccount,
  markMemoryAccountFailed,
  memoryDeviceId,
  saveMemoryAccount
} from "./accounts.js";

/**
 * TASK-133：Chat 用户 → SAG 试用号开户。
 * - `POST https://sag.lanxingbei.cn/api/trial-register`，body `{device_id}`（合法字符 [0-9a-fA-F-]，8-64）
 * - 幂等靠 device_id（同号重复调返回原户原令牌）；本函数额外落 D1 省网络调用
 * - 失败不阻塞主流程：标记 status=failed + last_error，回复链照常（无记忆）
 */

const DEFAULT_TRIAL_REGISTER_URL = "https://sag.lanxingbei.cn/api/trial-register";
const TIMEOUT_MS = 15000;

function trialRegisterUrl(env) {
  return String(env.MEMORY_TRIAL_REGISTER_URL || DEFAULT_TRIAL_REGISTER_URL);
}

/**
 * 确保该 Chat 用户有可用的记忆台账。返回台账行或 null（失败）。
 * @param {object} env Worker env（DB + keyring + 可选覆盖 URL）
 * @param {number} userId EdgeChat 用户 id
 * @param {{ fetchImpl?: Function, force?: boolean }} options force=true 时无视现有 active 台账重开
 */
export async function ensureMemoryAccount(env, userId, { fetchImpl = fetch, force = false } = {}) {
  const existing = await getMemoryAccount(env.DB, userId);
  if (!force && existing && existing.status === "active" && existing.sag_token_cipher) {
    return existing;
  }

  const deviceId = memoryDeviceId(userId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(trialRegisterUrl(env), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId }),
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
      const detail = String(payload?.error || payload?.message || "").slice(0, 160);
      throw new Error(`http_${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const config = payload?.config || {};
    const token = String(config.sag_api_token || "").trim();
    const customerId = String(payload?.customer_id || config.customer_id || "").trim();
    if (!token) throw new Error("empty_token");

    const account = await saveMemoryAccount(env, userId, { customerId, token, deviceId });
    console.log(
      JSON.stringify({
        message: "memory_account opened",
        userId: Number(userId),
        customerId,
        deviceId
      })
    );
    return account;
  } catch (error) {
    const name = String(error?.name || "");
    const message = name === "AbortError" ? "timeout" : String(error?.message || error).slice(0, 200);
    console.warn(
      JSON.stringify({ message: "memory_account open failed", userId: Number(userId), error: message })
    );
    await markMemoryAccountFailed(env.DB, userId, message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
