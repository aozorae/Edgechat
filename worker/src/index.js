import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  consumeLoginRateLimit,
  createSession,
  deleteSession,
  hashPassword,
  isConfiguredAdminUsername,
  putSession,
  verifyPassword
} from './auth.js';
import { listVisibleChannels } from './data/channels.js';
import { listUserDms } from './data/dm-queries.js';
import { ensureGeneralChannelMembership } from './data/general-channel.js';
import {
  createUserWithRegistrationInvite,
  getAvailableRegistrationInvite
} from './data/registration-invites.js';
import { getSiteSettings } from './data/site-settings.js';
import { getUserByUsername, listActiveUsers } from './data/users.js';
import { ApiError } from './errors.js';
import { adminMiddleware, authMiddleware } from './middleware.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerMaintenanceRoutes } from './api/maintenance.ts';
import { registerInstanceBridgePublicRoutes, registerInstanceBridgeRoutes } from './api/instance-bridge.ts';
import { InstanceBridge } from './do/InstanceBridge.ts';
import { rescueBridgeDeliveries } from './integrations/instance-bridge/delivery.ts';
import { registerChannelRoutes } from './api/channels.js';
import { registerContactRoutes } from './api/contacts.ts';
import { registerDmRoutes } from './api/dm.js';
import { registerMessageRoutes } from './api/messages.js';
import { registerUploadRoutes } from './api/upload.js';
import { registerUserBlockRoutes } from './api/user-blocks.ts';
import { registerUserProfileRoutes } from './api/user-profile.ts';
import { registerV1Routes } from './api/v1.js';
import {
  registerTelegramAdminRoutes,
  registerTelegramPublicRoutes
} from './api/telegram.js';
import { ChannelRoom } from './do/ChannelRoom.js';
import { Scheduler } from './do/Scheduler.js';
import { UserInbox } from './do/UserInbox.js';
import { forwardInboxConnection, forwardRoomConnection } from './do-bridge.js';
import { runScheduledGc } from './gc.js';
import { isUserDisabled } from './user-status.js';
import { updateCurrentDeviceSessionVersion } from './mobile-session.js';
import {
  errorCodeForStatus,
  errorResponse,
  parseJsonRequest,
  requestBodyTooLarge,
  v1ErrorResponse
} from './utils.js';

const app = new Hono();

app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const uploadLimit = Number(c.env.MAX_FILE_SIZE || 20971520) + 1024 * 1024;
  const maxBytes = ['/api/upload', '/api/v1/uploads'].includes(path) ? uploadLimit : undefined;
  if (requestBodyTooLarge(c.req.raw, maxBytes)) {
    // 提前拒绝超大请求体，避免 Worker 在 JSON 解析前消耗过多内存。
    return errorResponse('请求体过大', 413);
  }

  await next();
});

app.use('/api/*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/site', async (c) => {
  const site = await getSiteSettings(c.env.DB);
  return c.json({ site });
});

registerTelegramPublicRoutes(app);
registerInstanceBridgePublicRoutes(app);

app.get('/api/register-links/:token', async (c) => {
  const token = String(c.req.param('token') || '').trim();
  if (!token) {
    return errorResponse('注册链接不存在', 404);
  }

  const site = await getSiteSettings(c.env.DB);
  const invite = await getAvailableRegistrationInvite(c.env.DB, token);
  if (!invite) {
    return errorResponse('注册链接已失效', 404);
  }

  return c.json({
    site,
    invite: {
      note: invite.note,
      createdAt: invite.createdAt,
      remainingUses: invite.remainingUses
    }
  });
});

app.post('/api/register-links/:token/register', async (c) => {
  const token = String(c.req.param('token') || '').trim();
  const payload = await parseJsonRequest(c.req.raw);
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  const displayName = String(payload.displayName || username).trim();

  if (!token) {
    return errorResponse('注册链接不存在', 404);
  }
  if (!username || !password) {
    return errorResponse('用户名和密码不能为空');
  }
  if (isConfiguredAdminUsername(c.env, username)) {
    return errorResponse('该用户名不可用于邀请注册');
  }

  const invite = await getAvailableRegistrationInvite(c.env.DB, token);
  if (!invite) {
    return errorResponse('注册链接已失效', 400);
  }

  const hashed = await hashPassword(password);
  const userId = await createUserWithRegistrationInvite(c.env.DB, {
    inviteId: invite.id,
    username,
    displayName,
    passwordHash: hashed.hash,
    passwordSalt: hashed.salt
  });

  await ensureGeneralChannelMembership(c.env.DB, userId);

  return c.json({ ok: true });
});

app.post('/api/auth/login', async (c) => {
  const clientIp = c.req.header('CF-Connecting-IP') || 'unknown';
  const withinLimit = await consumeLoginRateLimit(c.env, clientIp);
  if (!withinLimit) {
    return errorResponse('尝试次数过多，请稍后再试', 429);
  }

  const payload = await parseJsonRequest(c.req.raw);
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  if (!username || !password) {
    return errorResponse('请输入用户名和密码');
  }

  const user = await getUserByUsername(c.env.DB, username);
  if (!user || isUserDisabled(user)) {
    return errorResponse('账号或密码错误', 401);
  }

  const valid = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!valid) {
    return errorResponse('账号或密码错误', 401);
  }

  const session = await createSession(c.env, user);
  return c.json({
    token: session.token,
    session
  });
});

registerV1Routes(app);

app.use('/api/*', authMiddleware);

app.get('/api/auth/session', async (c) => {
  const session = c.get('session');
  const user = await c.env.DB.prepare(
    `SELECT display_name, avatar_key, bio, is_disabled, disabled_until
     FROM users
     WHERE id = ?
       AND deleted_at IS NULL
     LIMIT 1`
  )
    .bind(session.userId)
    .all();

  if (!user.results[0] || isUserDisabled(user.results[0])) {
    await deleteSession(c.env, session.token);
    return errorResponse('账号已不可用', 401);
  }

  const freshSession = {
    ...session,
    displayName: user.results[0].display_name,
    bio: user.results[0].bio,
    avatarUrl: user.results[0].avatar_key ? `/files/${encodeURIComponent(user.results[0].avatar_key)}` : ''
  };
  await putSession(c.env, freshSession);

  return c.json({ session: freshSession });
});

app.post('/api/auth/logout', async (c) => {
  const session = c.get('session');
  await deleteSession(c.env, session.token);
  return c.json({ ok: true });
});

app.post('/api/auth/change-password', async (c) => {
  const session = c.get('session');
  const payload = await parseJsonRequest(c.req.raw);
  const currentPassword = String(payload.currentPassword || '');
  const newPassword = String(payload.newPassword || '');
  if (!currentPassword || !newPassword) {
    return errorResponse('请填写完整密码');
  }

  const user = await c.env.DB.prepare(
    `SELECT password_hash, password_salt
     FROM users
     WHERE id = ?
       AND deleted_at IS NULL
     LIMIT 1`
  )
    .bind(session.userId)
    .all();

  if (!user.results[0]) {
    return errorResponse('用户不存在', 404);
  }

  const valid = await verifyPassword(
    currentPassword,
    user.results[0].password_hash,
    user.results[0].password_salt
  );
  if (!valid) {
    return errorResponse('当前密码不正确', 400);
  }

  const hashed = await hashPassword(newPassword);
  await c.env.DB.prepare(
    `UPDATE users
     SET password_hash = ?,
          password_salt = ?,
          session_version = session_version + 1,
          updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND deleted_at IS NULL`
  )
    .bind(hashed.hash, hashed.salt, session.userId)
    .run();

  const nextSession = {
    ...session,
    sessionVersion: Number(session.sessionVersion || 0) + 1
  };
  await updateCurrentDeviceSessionVersion(c.env, session, nextSession.sessionVersion);
  await putSession(c.env, nextSession);

  return c.json({ ok: true });
});

app.get('/api/users', async (c) => {
  const session = c.get('session');
  const users = await listActiveUsers(c.env.DB, session.userId);
  return c.json({ users });
});

app.get('/api/bootstrap', async (c) => {
  const session = c.get('session');
  await ensureGeneralChannelMembership(c.env.DB, session.userId);
  const [users, channels, dms] = await Promise.all([
    listActiveUsers(c.env.DB, session.userId),
    listVisibleChannels(c.env.DB, session.userId),
    listUserDms(c.env.DB, session.userId)
  ]);

  return c.json({ users, channels, dms });
});

app.use('/api/admin/*', adminMiddleware);

registerMessageRoutes(app);
registerContactRoutes(app);
registerDmRoutes(app);
registerUserBlockRoutes(app);
registerUserProfileRoutes(app);
registerUploadRoutes(app);
registerChannelRoutes(app);
registerAdminRoutes(app);
registerMaintenanceRoutes(app);
registerTelegramAdminRoutes(app);
registerInstanceBridgeRoutes(app);

app.get('/api/ws/:kind/:id', async (c) => {
  const session = c.get('session');
  const kind = c.req.param('kind');
  const id = c.req.param('id');
  if (!['public', 'private', 'dm'].includes(kind)) {
    return errorResponse('无效的会话类型');
  }

  return forwardRoomConnection({
    env: c.env,
    request: c.req.raw,
    kind,
    roomId: id,
    principal: session
  });
});

app.get('/api/inbox/ws', async (c) => {
  const session = c.get('session');
  return forwardInboxConnection({
    env: c.env,
    request: c.req.raw,
    principal: session
  });
});

app.notFound(async (c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return errorResponse('接口不存在', 404);
  }
  return new Response('Not Found', { status: 404 });
});

app.onError((error, c) => {
  console.error(error);
  const isV1 = new URL(c.req.url).pathname.startsWith('/api/v1/');
  if (error instanceof ApiError) {
    if (isV1) {
      return v1ErrorResponse(error.code, error.message, error.status);
    }
    return errorResponse(error.message, error.status);
  }
  if (isV1) {
    return v1ErrorResponse(errorCodeForStatus(500), '服务器开小差了', 500);
  }
  return errorResponse('服务器开小差了', 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === '*/15 * * * *') {
      ctx.waitUntil(rescueBridgeDeliveries(env));
    } else {
      ctx.waitUntil(Promise.all([runScheduledGc(env), rescueBridgeDeliveries(env)]));
    }
  }
};
export { ChannelRoom, Scheduler, UserInbox, InstanceBridge };
