import { getLoginVerification } from './data/login-verification.ts';
import { ApiError } from './errors.js';

export async function enforceRateLimit(binding, request: Request) {
  // 原生计数留在 Cloudflare 边缘；未安装 binding 的本地测试不模拟数据库计数。
  if (!binding) return;
  const { success } = await binding.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
  if (!success) throw new ApiError('请求过于频繁，请稍后重试', 429, 'rate_limited');
}

export async function verifyLoginSecurity(env, request: Request, token: unknown) {
  await enforceRateLimit(env.LOGIN_RATE_LIMITER, request);
  const settings = await getLoginVerification(env.DB);
  if (!settings.enabled) return;
  if (!env.EDGECHAT_TURNSTILE_SECRET_KEY || !settings.siteKey) {
    throw new ApiError('登录验证暂不可用', 503, 'verification_unavailable');
  }
  if (typeof token !== 'string' || !token) {
    throw new ApiError('请完成登录验证', 403, 'verification_required');
  }
  let result: { success: boolean; action?: string };
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.EDGECHAT_TURNSTILE_SECRET_KEY, response: token,
        remoteip: request.headers.get('CF-Connecting-IP') || undefined }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Siteverify unavailable');
    result = await response.json();
  } catch {
    throw new ApiError('登录验证暂不可用', 503, 'verification_unavailable');
  }
  // 每次密码提交均消费一次短效 token；失败时不查询账号，也不写尝试次数。
  if (!result.success || result.action !== 'login') {
    throw new ApiError('登录验证失败，请重试', 403, 'verification_failed');
  }
}
