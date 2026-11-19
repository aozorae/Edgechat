import { hashPassword } from '../auth.js';
import { isValidNewUsername, USERNAME_RULE_ERROR } from '../../../shared/username.ts';
import { ensureGeneralChannelMembership } from '../data/general-channel.js';
import {
  createRegistrationInvite,
  listActiveRegistrationInvites,
  MAX_INVITE_USES,
  revokeRegistrationInvite
} from '../data/registration-invites.js';
import { getSiteSettings, updateSiteSettings } from '../data/site-settings.js';
import { isR2ObjectUnavailableError } from '../data/uploaded-files.js';
import { listAdminUsers } from '../data/users.js';
import { getAdminUserDetails } from '../data/user-login-info.ts';
import { ApiError } from '../errors.js';
import { errorResponse, parseJsonRequest, randomToken } from '../utils.js';
import { banExpiryFromMinutes } from '../user-status.js';
import { hasPermission } from '../../../shared/admin-permissions.ts';
import { runAuthorizedBatch } from '../rbac/authorization.ts';
import { isSiteColorTheme } from '../../../shared/site-theme.ts';

export function registerAdminRoutes(app) {
  app.get('/api/admin/overview', async (c) => {
    const stats = await c.env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS users,
      (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND is_disabled = 0 AND (disabled_until IS NULL OR disabled_until <= CURRENT_TIMESTAMP)) AS activeUsers,
      (SELECT COUNT(*) FROM channels WHERE deleted_at IS NULL AND kind = 'public') AS publicChannels,
      (SELECT COUNT(*) FROM channels WHERE deleted_at IS NULL AND kind = 'private') AS privateChannels,
      (SELECT COUNT(*) FROM channels WHERE deleted_at IS NULL AND kind = 'dm') AS dms,
      (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS messages`).first();
    return c.json({ stats, site: await getSiteSettings(c.env.DB) });
  });

  app.get('/api/admin/site-settings', async (c) => {
    const site = await getSiteSettings(c.env.DB);
    return c.json({ site });
  });

  app.patch('/api/admin/site-settings', async (c) => {
    const payload = await parseJsonRequest(c.req.raw);
    const siteName = payload.siteName === undefined ? undefined : String(payload.siteName || '').trim();
    const siteIconUrl = payload.siteIconUrl === undefined ? undefined : String(payload.siteIconUrl || '').trim();
    const colorTheme = payload.colorTheme;

    if (siteName === '') {
      return errorResponse('站点名称不能为空');
    }
    if (colorTheme !== undefined && !isSiteColorTheme(colorTheme)) {
      return errorResponse('不支持的站点配色');
    }

    try {
      const site = await updateSiteSettings(c.env.DB, {
        siteName,
        siteIconUrl,
        colorTheme,
        siteOrigin: new URL(c.req.url).origin
      });
      return c.json({ site });
    } catch (error) {
      if (isR2ObjectUnavailableError(error)) {
        return errorResponse('站点图标文件不存在或正在清理，请重新上传');
      }
      throw error;
    }
  });

  app.get('/api/admin/register-links', async (c) => {
    const invites = await listActiveRegistrationInvites(c.env.DB);
    return c.json({ invites: invites.slice(0, 100).map((invite) => {
      if (!hasPermission(c.get('session'), 'invites.create')) { const { token, ...summary } = invite; return summary; }
      return invite;
    }) });
  });

  app.post('/api/admin/register-links', async (c) => {
    const session = c.get('session');
    const payload = await parseJsonRequest(c.req.raw);
    const note = String(payload.note || '').trim();
    const maxUses = Number(payload.maxUses ?? 1);

    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_INVITE_USES) {
      return errorResponse(`可使用次数必须是 1 到 ${MAX_INVITE_USES} 之间的整数`);
    }

    const token = randomToken(24);
    const invite = await createRegistrationInvite(c.env.DB, {
      token,
      note,
      maxUses,
      createdBy: session.userId,
      creatorDisplayName: session.displayName
    });

    return c.json({
      invite
    });
  });

  app.delete('/api/admin/register-links/:inviteId', async (c) => {
    const inviteId = Number(c.req.param('inviteId'));
    if (!Number.isFinite(inviteId)) {
      return errorResponse('注册链接不存在', 404);
    }

    await revokeRegistrationInvite(c.env.DB, inviteId);

    return c.json({ ok: true });
  });

  app.get('/api/admin/users', async (c) => {
    const offset = Number(c.req.query('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return errorResponse('分页参数无效');
    const users = await listAdminUsers(c.env.DB, offset, c.get('session'));
    return c.json({ users });
  });

  app.get('/api/admin/users/:userId/details', async (c) => {
    const rawId = c.req.param('userId');
    const userId = Number(rawId);
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(userId)) {
      return errorResponse('用户不存在', 404);
    }
    const user = await getAdminUserDetails(c.env.DB, userId, c.get('session'));
    if (!user) return errorResponse('用户不存在', 404);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ user });
  });

  app.post('/api/admin/users', async (c) => {
    const payload = await parseJsonRequest(c.req.raw);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    const displayName = String(payload.displayName || username).trim();

    if (!username || !password) {
      return errorResponse('用户名和密码不能为空');
    }
    if (!isValidNewUsername(username)) return errorResponse(USERNAME_RULE_ERROR);

    const hashed = await hashPassword(password);
    const db = c.get('authorizationDatabase');
    const statements = [db.prepare(
      `INSERT INTO users (
         username,
         display_name,
         password_hash,
         password_salt
       ) VALUES (?, ?, ?, ?)`
    ).bind(username, displayName, hashed.hash, hashed.salt)];
    if ('roleId' in payload) {
      const roleId = Number(payload.roleId);
      if (!Number.isSafeInteger(roleId) || roleId < 1) return errorResponse('用户组无效');
      statements.push(db.prepare('UPDATE rbac_user_roles SET role_id = ?, assigned_by = ? WHERE user_id = (SELECT id FROM users WHERE username = ?)').bind(roleId, c.get('session').userId, username));
      statements.push(db.prepare('UPDATE users SET management_protected = CASE WHEN ? != 1 THEN 1 ELSE 0 END WHERE username = ?').bind(roleId, username));
    }
    const [result] = await runAuthorizedBatch(db, c.get('authorizationContext'), statements, undefined, { username, roleId: payload.roleId || 1 }).catch((error) => {
        if (String(error.message).includes('UNIQUE')) {
          throw new ApiError('用户名已存在');
        }
        throw error;
      });

    await ensureGeneralChannelMembership(c.env.DB, result.meta.last_row_id);

    return c.json({
      user: {
        id: result.meta.last_row_id,
        username,
        displayName,
        isDisabled: false,
        isPermanentlyDisabled: false,
        disabledUntil: null
      }
    });
  });

  app.patch('/api/admin/users/:userId', async (c) => {
    const userId = Number(c.req.param('userId'));
    const payload = await parseJsonRequest(c.req.raw);
    const updatesBanState = typeof payload.isDisabled === 'boolean';

    if (updatesBanState) {
      const durationMinutes = payload.banDurationMinutes == null
        ? null
        : Number(payload.banDurationMinutes);
      if (payload.isDisabled && durationMinutes !== null
        && (!Number.isInteger(durationMinutes) || durationMinutes < 1)) {
        return errorResponse('封禁时长必须是正整数分钟');
      }

      const isPermanentlyDisabled = payload.isDisabled && durationMinutes === null;
      const disabledUntil = payload.isDisabled && durationMinutes !== null
        ? banExpiryFromMinutes(durationMinutes)
        : null;
      await c.env.DB.prepare(
        `UPDATE users
         SET is_disabled = ?,
             disabled_until = ?,
             display_name = COALESCE(?, display_name),
             session_version = session_version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND deleted_at IS NULL`
      )
        .bind(isPermanentlyDisabled ? 1 : 0, disabledUntil, payload.displayName || null, userId)
        .run();
    } else {
      await c.env.DB.prepare(
        `UPDATE users
         SET display_name = COALESCE(?, display_name),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND deleted_at IS NULL`
      )
        .bind(payload.displayName || null, userId)
        .run();
    }

    return c.json({ ok: true });
  });

  app.post('/api/admin/users/:userId/reset-password', async (c) => {
    const userId = Number(c.req.param('userId'));
    const payload = await parseJsonRequest(c.req.raw);
    const password = String(payload.password || '');
    if (!password) {
      return errorResponse('新密码不能为空');
    }

    const hashed = await hashPassword(password);
    await c.env.DB.prepare(
      `UPDATE users
       SET password_hash = ?,
            password_salt = ?,
            session_version = session_version + 1,
            updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND deleted_at IS NULL`
    )
      .bind(hashed.hash, hashed.salt, userId)
      .run();

    return c.json({ ok: true });
  });

  app.delete('/api/admin/users/:userId', async (c) => {
    const userId = Number(c.req.param('userId'));
    await c.env.DB.prepare(
      `UPDATE users
       SET deleted_at = CURRENT_TIMESTAMP,
            is_disabled = 1,
            disabled_until = NULL,
            session_version = session_version + 1,
            updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(userId)
      .run();

    return c.json({ ok: true });
  });

}
