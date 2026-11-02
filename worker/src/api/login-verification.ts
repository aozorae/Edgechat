import { getLoginVerification, saveLoginVerification } from '../data/login-verification.ts';
import { errorResponse, parseJsonRequest } from '../utils.js';

export function registerLoginVerificationPublicRoutes(app) {
  app.get('/api/auth/verification', async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await getLoginVerification(c.env.DB));
  });
}

export function registerLoginVerificationRoutes(app) {
  app.get('/api/admin/login-verification', async (c) => c.json({
    ...await getLoginVerification(c.env.DB),
    secretConfigured: Boolean(c.env.EDGECHAT_TURNSTILE_SECRET_KEY),
  }));
  app.put('/api/admin/login-verification', async (c) => {
    const payload = await parseJsonRequest(c.req.raw);
    if (typeof payload.enabled !== 'boolean' || typeof payload.siteKey !== 'string') return errorResponse('设置无效');
    const settings = { enabled: payload.enabled, siteKey: payload.siteKey.trim() };
    if (settings.enabled && (!settings.siteKey || !c.env.EDGECHAT_TURNSTILE_SECRET_KEY)) {
      return errorResponse('请先配置 Turnstile Site Key 和 Secret Key');
    }
    return c.json({ ...await saveLoginVerification(c.env.DB, settings),
      secretConfigured: Boolean(c.env.EDGECHAT_TURNSTILE_SECRET_KEY) });
  });
}
