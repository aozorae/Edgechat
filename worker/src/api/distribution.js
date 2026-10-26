import { hashPassword } from '../auth.js';
import {
  BENBEN_BOT_DISPLAY_NAME,
  ensureBenbenBot,
  findActiveDeviceUser,
  getDistributionConfig,
  getInvitationTreeOneLevel,
  updateDistributionConfig
} from '../data/distribution.js';
import { ensureDmChannel } from '../data/dm-provisioning.js';
import { ensureGeneralChannelMembership } from '../data/general-channel.js';
import {
  createUserWithRegistrationInvite,
  getAvailableRegistrationInvite
} from '../data/registration-invites.js';
import { createMobileDeviceSession } from '../mobile-session.js';
import { ApiError } from '../errors.js';
import { errorResponse, parseJsonRequest, randomToken } from '../utils.js';
import { hasPermission } from '../../../shared/admin-permissions.ts';

function distributionError(c, status, code, message) {
  return c.json({ error: { code, message } }, status);
}

function pickString(value) {
  return String(value ?? '').trim();
}

function generateUsername() {
  const raw = randomToken(8).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return `u_${raw.slice(0, 10) || 'member'}`;
}

/**
 * 期一公开接口：
 * - GET  /api/distribution/config            客户端进前台读取开关
 * - POST /api/v1/distribution/auto-register  首聊自动建号（设备幂等，同设备只开一个号）
 */
export function registerDistributionPublicRoutes(app) {
  app.get('/api/distribution/config', async (c) => {
    const config = await getDistributionConfig(c.env.DB);
    return c.json({
      gateEnabled: config.gateEnabled,
      // 期二能力先占位返回 false，客户端按此隐藏入口
      qrEnabled: false,
      clientInviteEnabled: false
    });
  });

  app.post('/api/v1/distribution/auto-register', async (c) => {
    const payload = await parseJsonRequest(c.req.raw);
    const unknownKeys = Object.keys(payload).filter(
      (key) => !['token', 'installationId', 'deviceName'].includes(key)
    );
    if (unknownKeys.length) {
      return distributionError(c, 400, 'invalid_payload', '请求包含不允许修改的字段');
    }

    const token = pickString(payload.token);
    const installationId = pickString(payload.installationId);
    const deviceName = pickString(payload.deviceName) || 'Android';
    if (!token) return distributionError(c, 400, 'invite_required', '请输入验证码');
    if (!installationId) return distributionError(c, 400, 'device_required', '缺少设备标识');

    const config = await getDistributionConfig(c.env.DB);
    if (!config.gateEnabled) {
      return distributionError(c, 403, 'distribution_disabled', '分发已关闭');
    }

    // ① 设备幂等：同设备已有活跃会话 → 不建新号，直接签发新会话
    let user = await findActiveDeviceUser(c.env.DB, installationId);
    let created = false;

    if (!user) {
      // ② 校验邀请码（原子额度消费在 createUserWithRegistrationInvite 内由数据库触发器保证）
      const invite = await getAvailableRegistrationInvite(c.env.DB, token);
      if (!invite) {
        return distributionError(c, 409, 'invite_unavailable', '验证码已失效');
      }

      const password = randomToken(24);
      const hashed = await hashPassword(password);
      let userId = null;
      let username = '';
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !userId; attempt += 1) {
        username = generateUsername();
        try {
          userId = await createUserWithRegistrationInvite(c.env.DB, {
            inviteId: invite.id,
            username,
            displayName: '朋友',
            passwordHash: hashed.hash,
            passwordSalt: hashed.salt,
            invitedBy: invite.createdBy
          });
        } catch (error) {
          lastError = error;
          const message = String(error?.message || error);
          if (!message.includes('用户名已存在')) break;
        }
      }
      if (!userId) {
        if (lastError instanceof ApiError && String(lastError.message).includes('注册链接已失效')) {
          return distributionError(c, 409, 'invite_unavailable', '验证码已失效');
        }
        return distributionError(c, 500, 'register_failed', '自动建号失败，请重试');
      }

      await ensureGeneralChannelMembership(c.env.DB, userId);
      user = {
        id: userId,
        username,
        display_name: '朋友',
        session_version: 0,
        avatar_key: null
      };
      created = true;
    }

    // ③ 与笨笨的 DM：幂等 ensure（首聊即落在这里）
    const bot = await ensureBenbenBot(c.env.DB);
    const dm = await ensureDmChannel(c.env.DB, bot.id, Number(user.id));

    // ④ 签发移动端设备会话（沿用 v1 登录同款，refresh 可续）
    const sessionResult = await createMobileDeviceSession(c.env, user, {
      installationId,
      name: deviceName
    });

    return c.json({
      ok: true,
      created,
      user: {
        id: Number(user.id),
        username: user.username,
        displayName: user.display_name
      },
      initialRoom: {
        kind: 'dm',
        id: Number(dm.id),
        name: BENBEN_BOT_DISPLAY_NAME,
        otherUserId: Number(bot.id)
      },
      ...sessionResult
    });
  });
}

/** 期一后台接口（仅管理员；管理端「分发关系」页 + 开关） */
export function registerDistributionAdminRoutes(app) {
  app.get('/api/admin/distribution/config', async (c) => {
    if (!hasPermission(c.get('session'), 'invites.create')) {
      return errorResponse('无权限', 403);
    }
    return c.json(await getDistributionConfig(c.env.DB));
  });

  app.put('/api/admin/distribution/config', async (c) => {
    if (!hasPermission(c.get('session'), 'invites.create')) {
      return errorResponse('无权限', 403);
    }
    const payload = await parseJsonRequest(c.req.raw);
    const unknownKeys = Object.keys(payload).filter(
      (key) => !['gateEnabled', 'treeVisible'].includes(key)
    );
    if (unknownKeys.length) {
      return errorResponse('请求包含不允许修改的字段', 400);
    }
    const patch = {};
    if (typeof payload.gateEnabled === 'boolean') patch.gateEnabled = payload.gateEnabled;
    if (typeof payload.treeVisible === 'boolean') patch.treeVisible = payload.treeVisible;
    if (!Object.keys(patch).length) {
      return errorResponse('没有需要修改的开关', 400);
    }
    return c.json(await updateDistributionConfig(c.env.DB, patch));
  });

  app.get('/api/admin/distribution/tree', async (c) => {
    if (!hasPermission(c.get('session'), 'invites.create')) {
      return errorResponse('无权限', 403);
    }
    const roots = await getInvitationTreeOneLevel(c.env.DB);
    return c.json({
      depth: 1,
      roots,
      totalInvitees: roots.reduce((sum, root) => sum + root.children.length, 0)
    });
  });
}
