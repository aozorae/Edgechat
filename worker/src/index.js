import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
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
import { listActiveUsers } from './data/users.js';
import { ApiError } from './errors.js';
import { adminMiddleware, authMiddleware } from './middleware.js';
import { registerAdminRoutes } from './api/admin.js';
import {
  registerDistributionAdminRoutes,
  registerDistributionPublicRoutes
} from './api/distribution.js';
import { registerAiReplyAdminRoutes } from './api/ai-reply.js';
import { registerRbacRoutes } from './api/rbac.ts';
import { registerStorageRoutes } from './api/storage.ts';
import { registerMaintenanceRoutes } from './api/maintenance.ts';
import { registerStealthRoutes } from './api/stealth.ts';
import { createSiteEntry } from './stealth/entry.ts';
import { loginWithPassword } from './login.ts';
import { sessionCookie } from './session-cookie.ts';
import { registerInstanceBridgePublicRoutes, registerInstanceBridgeRoutes } from './api/instance-bridge.ts';
import { InstanceBridge } from './do/InstanceBridge.ts';
import { rescueBridgeDeliveries } from './integrations/instance-bridge/delivery.ts';
import { registerChannelRoutes } from './api/channels.js';
import { registerContactRoutes } from './api/contacts.ts';
import { registerGreetRoutes } from './api/greet.js';
import { listVisibleUsers } from './data/social.js';
import { registerLoginNetworkRoutes } from './api/login-network.ts';
import { registerDmRoutes } from './api/dm.js';
import { registerCallRoutes } from './api/calls.ts';
import { VoiceCall } from './do/VoiceCall.ts';
import { TelegramNotifications } from './do/TelegramNotifications.ts';
import { registerMessageRoutes } from './api/messages.js';
import { registerMemoryAdminRoutes, registerMemoryRoutes } from './api/memory.js';
import { backfillStaleSessions } from './integrations/memory/text-session.js';
import { ensureBenbenBot } from './data/distribution.js';
import { registerUploadRoutes } from './api/upload.js';
import { registerUserBlockRoutes } from './api/user-blocks.ts';
import { registerUserProfileRoutes } from './api/user-profile.ts';
import { registerV1Routes } from './api/v1.js';
import {
  registerTelegramAdminRoutes,
  registerTelegramPublicRoutes,
  registerTelegramNotificationRoutes
} from './api/telegram.js';
import { pruneTelegramNotifications, rescueTelegramNotifications } from './integrations/telegram/notifications.js';
import { ChannelRoom } from './do/ChannelRoom.js';
import { Scheduler } from './do/Scheduler.js';
import { UserInbox } from './do/UserInbox.js';
import { forwardInboxConnection, forwardRoomConnection } from './do-bridge.js';
import { runScheduledGc } from './gc.js';
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
  if (Object.keys(payload).some((key) => !['username', 'displayName', 'password'].includes(key))) return errorResponse('请求包含不允许修改的字段');
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
    passwordSalt: hashed.salt,
    invitedBy: invite.createdBy
  });

  await ensureGeneralChannelMembership(c.env.DB, userId);

  return c.json({ ok: true });
});

app.post('/api/auth/login', async (c) => {
  const payload = await parseJsonRequest(c.req.raw);
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  if (!username || !password) {
    return errorResponse('请输入用户名和密码');
  }

  const session = await loginWithPassword(c.env, username, password, c.req.raw);
  if (!session) {
    return errorResponse('账号或密码错误', 401);
  }

  c.header('Set-Cookie', sessionCookie(c.req.raw, session.token));
  return c.json({
    token: session.token,
    session
  });
});

// 期一：分发制公开接口（验证码校验沿用 /api/register-links；config 与 auto-register 公开）
// 注意：必须注册在 v1 路由之前，否则会命中 v1 的登录中间件链（401）
registerDistributionPublicRoutes(app);
// TASK-133：Chat 版记忆（客户端文本会话结算上报）。
// 必须注册在 v1 路由之前：v1 的 /api/v1/* legacy 代理兜底（api/v1.js app.all）注册更早时
// 会把 /api/v1/memory/* 吞掉转发到不存在的 legacy 路径（本地链路实测 404，2026-10-26）。
// 因此这里显式挂 authMiddleware，不依赖下方 /api/* 的全局中间件。
registerMemoryRoutes(app);
registerV1Routes(app);

app.use('/api/*', authMiddleware);
registerLoginNetworkRoutes(app);

app.get('/api/auth/session', async (c) => {
  const session = c.get('session');
  c.header('Set-Cookie', sessionCookie(c.req.raw, session.token));
  return c.json({ session });
});

app.post('/api/auth/logout', async (c) => {
  const session = c.get('session');
  await deleteSession(c.env, session.token);
  c.header('Set-Cookie', sessionCookie(c.req.raw, ''));
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
  // schema/迁移负责历史回填，建号路径与触发器负责新增成员；初始化不再重复写入。
  // [打招呼制 2026-11-01] 目录只回官方号+互认联系人（默认互不可见）；旧 /api/contacts 全量留给后台
  const [users, channels, dms] = await Promise.all([
    listVisibleUsers(c.env.DB, session.userId),
    listVisibleChannels(c.env.DB, session.userId),
    listUserDms(c.env.DB, session.userId)
  ]);

  return c.json({ users, channels, dms });
});

app.use('/api/admin/*', adminMiddleware);

registerMessageRoutes(app);
registerContactRoutes(app);
registerGreetRoutes(app);
registerDmRoutes(app);
registerCallRoutes(app);
registerUserBlockRoutes(app);
registerUserProfileRoutes(app);
registerUploadRoutes(app);
registerChannelRoutes(app);
registerAdminRoutes(app);
// 期一：分发制后台接口（分发总开关 + 一级邀请树，仅管理员）
registerDistributionAdminRoutes(app);
// 期一增项：文本回复链后台接口（开关 / 每日上限 / 用量统计，仅管理员）
registerAiReplyAdminRoutes(app);
// TASK-133：记忆台账只读后台接口（不含令牌）
registerMemoryAdminRoutes(app);
registerRbacRoutes(app);
registerStorageRoutes(app);
registerMaintenanceRoutes(app);
registerStealthRoutes(app);
registerTelegramAdminRoutes(app);
registerTelegramNotificationRoutes(app);
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
  fetch: createSiteEntry(app.fetch),
  async scheduled(controller, env, ctx) {
    const tasks = [rescueBridgeDeliveries(env), rescueTelegramNotifications(env)];
    // TASK-133：文本会话结算兜底（客户端漏报时按"静默 >30 分钟"补报）
    tasks.push(
      (async () => {
        try {
          const bot = await ensureBenbenBot(env.DB);
          const result = await backfillStaleSessions(env, { botId: Number(bot.id) });
          if (result.scanned) {
            console.log(JSON.stringify({ message: "text_session backfill", ...result }));
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              message: "text_session backfill failed",
              error: error instanceof Error ? error.message : String(error)
            })
          );
        }
      })()
    );
    // 免费账户的 cron 数量是账户级上限；复用 15 分钟触发器，在 UTC 19:00 的轮次追加每日 GC。
    if (shouldRunDailyGc(controller.scheduledTime)) tasks.push(runScheduledGc(env), pruneTelegramNotifications(env));
    ctx.waitUntil(Promise.all(tasks));
  }
};
export function shouldRunDailyGc(scheduledTime) {
  const time = new Date(scheduledTime);
  return time.getUTCHours() === 19 && time.getUTCMinutes() === 0;
}
export { ChannelRoom, Scheduler, UserInbox, InstanceBridge, VoiceCall, TelegramNotifications };
