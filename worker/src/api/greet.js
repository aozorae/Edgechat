/**
 * [打招呼制社交·路由] 2026-11-01 老板拍板机制（见 data/social.js 头注）。
 * 新增面，不动旧接口语义（/api/contacts 全量仍供后台管理页用）。
 */
import { sendGreeting, listGreetings, respondGreeting } from '../data/social.js';
import { errorResponse, parseJsonRequest } from '../utils.js';

export function registerGreetRoutes(app) {
  app.post('/api/greet', async (c) => {
    const session = c.get('session');
    const payload = await parseJsonRequest(c.req.raw);
    const result = await sendGreeting(
      c.env.DB,
      session.userId,
      payload.to ?? payload.username,
      payload.message
    );
    if (!result.ok) return errorResponse(result.reason, result.code);
    return c.json({ ok: true });
  });

  app.get('/api/greet/requests', async (c) => {
    const session = c.get('session');
    const data = await listGreetings(c.env.DB, session.userId);
    return c.json(data);
  });

  app.post('/api/greet/respond', async (c) => {
    const session = c.get('session');
    const payload = await parseJsonRequest(c.req.raw);
    const result = await respondGreeting(
      c.env.DB,
      session.userId,
      Number(payload.id),
      Boolean(payload.accept)
    );
    if (!result.ok) return errorResponse(result.reason, result.code);
    return c.json({ ok: true, status: result.status });
  });
}
