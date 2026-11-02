import {
  listAdminChannels,
  listChannelMembers,
  listVisibleChannels
} from '../data/channels.js';
import {
  isGeneralChannel,
  isReservedGeneralChannelName
} from '../data/general-channel.js';
import {
  authorizeRoom,
  authorizeChannelManagement,
  getChannelById,
  getChannelMembership
} from '../room-access.js';
import { ApiError } from '../errors.js';
import {
  isR2ObjectUnavailableError,
  resolveAvatarKeyUpdate
} from '../avatar-policy.js';
import { errorResponse, parseJsonRequest, publicFileUrl } from '../utils.js';
import { activeUserSql } from '../user-status.js';
import { hardDeleteChannel } from '../data/channel-deletion.ts';

function normalizeMemberIds(payload) {
  const source = Array.isArray(payload.memberUserIds)
    ? payload.memberUserIds
    : Array.isArray(payload.userIds)
      ? payload.userIds
      : [];

  return [...new Set(source.map((value) => Number(value)).filter((value) => Number.isFinite(value)))];
}

async function ensureValidInvitees(db, userIds) {
  if (!userIds.length) {
    return [];
  }

  const placeholders = userIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT id
       FROM users
       WHERE deleted_at IS NULL
         AND ${activeUserSql()}
         AND id IN (${placeholders})`
    )
    .bind(...userIds)
    .all();

  return results.map((row) => Number(row.id));
}

export function registerChannelRoutes(app) {
  app.get('/api/channels', async (c) => {
    const session = c.get('session');
    const channels = await listVisibleChannels(c.env.DB, session.userId);
    return c.json({
      channels,
      publicChannels: channels.filter((channel) => channel.kind === 'public'),
      privateChannels: channels.filter((channel) => channel.kind === 'private')
    });
  });

  app.post('/api/channels', async (c) => {
    const session = c.get('session');
    const payload = await parseJsonRequest(c.req.raw);
    const name = String(payload.name || '').trim();
    const description = String(payload.description || '').trim();
    const kind = String(payload.kind || 'public').trim();

    if (!name) {
      return errorResponse('群组名称不能为空');
    }

    if (!['public', 'private'].includes(kind)) {
      return errorResponse('群组类型无效');
    }

    if (isReservedGeneralChannelName(name)) {
      return errorResponse('general 是系统群组名称');
    }

    const inviteUserIds = normalizeMemberIds(payload).filter((userId) => userId !== session.userId);
    const validInvitees = await ensureValidInvitees(c.env.DB, inviteUserIds);
    const result = await c.env.DB.prepare(
      `INSERT INTO channels (name, description, kind, created_by)
       VALUES (?, ?, ?, ?)`
    )
      .bind(name, description, kind, session.userId)
      .run()
      .catch((error) => {
        if (String(error.message).includes('UNIQUE')) {
          throw new ApiError('群组名称已存在');
        }
        throw error;
      });

    const channelId = Number(result.meta.last_row_id);
    const statements = [
      c.env.DB
        .prepare(
          `INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
           VALUES (?, ?, 'owner', ?)`
        )
        .bind(channelId, session.userId, session.userId)
    ];

    validInvitees.forEach((userId) => {
      statements.push(
        c.env.DB
          .prepare(
            `INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
             VALUES (?, ?, 'member', ?)`
          )
          .bind(channelId, userId, session.userId)
      );
    });
    await c.env.DB.batch(statements);

    return c.json({
      channel: {
        id: channelId,
        name,
        description,
        avatarKey: '',
        avatarUrl: '',
        kind,
        ownerDisplayName: session.displayName,
        isMember: true,
        myRole: 'owner',
        canManage: true,
        memberCount: 1 + validInvitees.length
      }
    });
  });

  app.post('/api/channels/:channelId/join', async (c) => {
    const session = c.get('session');
    const channelId = Number(c.req.param('channelId'));
    if (!Number.isFinite(channelId)) {
      return errorResponse('群组不存在', 404);
    }

    const channel = await getChannelById(c.env.DB, channelId);
    if (!channel || channel.kind !== 'public') {
      return errorResponse('公开群组不存在', 404);
    }

    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
       VALUES (?, ?, 'member', ?)`
    )
      .bind(channelId, session.userId, session.userId)
      .run();

    return c.json({ ok: true });
  });

  app.get('/api/channels/:channelId/members', async (c) => {
    const session = c.get('session');
    const channelId = Number(c.req.param('channelId'));
    const channel = await getChannelById(c.env.DB, channelId);
    if (!channel || channel.kind === 'dm') {
      return errorResponse('群组不存在', 404);
    }

    const access = await authorizeRoom(c.env.DB, session, channel.kind, channelId);
    if (!access.ok) {
      return errorResponse('无权查看群组成员', 403);
    }

    const membership = await getChannelMembership(c.env.DB, channelId, session.userId);
    const members = await listChannelMembers(c.env.DB, channelId);
    return c.json({
      room: {
        id: Number(channel.id),
        name: channel.name,
        description: channel.description,
        avatarKey: channel.avatar_key || '',
        avatarUrl: channel.avatar_key ? publicFileUrl(channel.avatar_key) : '',
        kind: channel.kind,
        isGeneral: isGeneralChannel(channel),
        myRole: membership?.role || '',
        canManage: membership?.role === 'owner'
      },
      members
    });
  });

  app.patch('/api/channels/:channelId', async (c) => {
    const session = c.get('session');
    const channelId = Number(c.req.param('channelId'));
    if (!Number.isFinite(channelId)) {
      return errorResponse('群组不存在', 404);
    }

    const payload = await parseJsonRequest(c.req.raw);
    const name =
      payload.name === undefined ? undefined : String(payload.name || '').trim();

    if (name !== undefined && !name) {
      return errorResponse('群组名称不能为空');
    }

    const management = await authorizeChannelManagement(c.env.DB, session, channelId);
    if (!management.ok) {
      return errorResponse('只有群主或管理员可以编辑群组', 403);
    }

    if (
      isGeneralChannel(management.channel) &&
      name !== undefined &&
      name !== 'general'
    ) {
      return errorResponse('general 系统群组不能改名');
    }

    const avatarUpdate = await resolveAvatarKeyUpdate(c.env.DB, session.userId, payload);

    const updates = [];
    const binds = [];
    if (name !== undefined) {
      updates.push('name = ?');
      binds.push(name);
    }
    if (avatarUpdate.provided) {
      updates.push('avatar_key = ?');
      binds.push(avatarUpdate.key);
    }

    if (!updates.length) {
      return c.json({ ok: true });
    }

    try {
      await c.env.DB.prepare(
        `UPDATE channels
         SET ${updates.join(', ')}
         WHERE id = ?
           AND kind IN ('public', 'private')
           AND deleted_at IS NULL`
      )
        .bind(...binds, channelId)
        .run();
    } catch (error) {
      if (isR2ObjectUnavailableError(error)) {
        return errorResponse('头像文件不存在或正在清理，请重新上传');
      }
      if (String(error.message).includes('UNIQUE')) {
        return errorResponse('群组名称已存在');
      }
      throw error;
    }

    const updated = await getChannelById(c.env.DB, channelId);
    return c.json({
      channel: {
        id: Number(updated.id),
        name: updated.name,
        avatarKey: updated.avatar_key || '',
        avatarUrl: updated.avatar_key ? publicFileUrl(updated.avatar_key) : ''
      }
    });
  });

  app.post('/api/channels/:channelId/invite', async (c) => {
    const session = c.get('session');
    const channelId = Number(c.req.param('channelId'));
    const payload = await parseJsonRequest(c.req.raw);
    const management = await authorizeChannelManagement(c.env.DB, session, channelId);
    if (!management.ok) {
      return errorResponse('只有群主或管理员可以邀请成员', 403);
    }

    const userIds = normalizeMemberIds(payload).filter((userId) => userId !== session.userId);
    const validInvitees = await ensureValidInvitees(c.env.DB, userIds);
    if (!validInvitees.length) {
      return errorResponse('没有可邀请的用户');
    }

    const statements = validInvitees.map((userId) =>
      c.env.DB
        .prepare(
          `INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
           VALUES (?, ?, 'member', ?)`
        )
        .bind(channelId, userId, session.userId)
    );
    await c.env.DB.batch(statements);

    return c.json({
      ok: true,
      members: await listChannelMembers(c.env.DB, channelId)
    });
  });

  app.delete('/api/channels/:channelId/members/:userId', async (c) => {
    const session = c.get('session');
    const channelId = Number(c.req.param('channelId'));
    const userId = Number(c.req.param('userId'));
    const management = await authorizeChannelManagement(c.env.DB, session, channelId);
    if (!management.ok) {
      return errorResponse('只有群主或管理员可以移除成员', 403);
    }

    if (isGeneralChannel(management.channel)) {
      return errorResponse('general 系统群组必须保留所有成员');
    }

    const targetMembership = await getChannelMembership(c.env.DB, channelId, userId);
    if (!targetMembership) {
      return errorResponse('成员不存在', 404);
    }

    if (targetMembership.role === 'owner') {
      return errorResponse('不能移除群主，请直接删除群组');
    }

    await c.env.DB.prepare(
      `DELETE FROM channel_members
       WHERE channel_id = ?
         AND user_id = ?`
    )
      .bind(channelId, userId)
      .run();

    return c.json({
      ok: true,
      members: await listChannelMembers(c.env.DB, channelId)
    });
  });

  app.delete('/api/channels/:channelId', async (c) => {
    const session = c.get('session');
    const channelId = Number(c.req.param('channelId'));
    const management = await authorizeChannelManagement(c.env.DB, session, channelId);
    if (!management.ok) {
      return errorResponse('只有群主或管理员可以删除群组', 403);
    }

    if (isGeneralChannel(management.channel)) {
      return errorResponse('general 系统群组不能删除');
    }

    await hardDeleteChannel(c.env.DB, channelId);

    return c.json({ ok: true });
  });

  app.get('/api/admin/channels', async (c) => {
    const { results: channels } = await c.env.DB.prepare(`SELECT c.id, c.name, c.kind, c.created_at AS createdAt,
      (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS memberCount
      FROM channels c WHERE c.kind IN ('public', 'private') AND c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 100`).all();
    return c.json({ channels });
  });

  app.delete('/api/admin/channels/:channelId', async (c) => {
    const channelId = Number(c.req.param('channelId'));
    const channel = await getChannelById(c.env.DB, channelId);
    if (!channel) {
      return errorResponse('群组不存在', 404);
    }
    if (isGeneralChannel(channel)) {
      return errorResponse('general 系统群组不能删除');
    }

    await hardDeleteChannel(c.env.DB, channelId);

    return c.json({ ok: true });
  });
}
