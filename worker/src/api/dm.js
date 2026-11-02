import { ensureDmChannel } from '../data/dm-provisioning.js';
import { listAdminDms, listUserDms } from '../data/dm-queries.js';
import { getUserBlockStatus } from '../data/user-blocks.ts';
import { areContacts, listOfficialUsernames } from '../data/social.js';
import { errorResponse, parseJsonRequest } from '../utils.js';
import { activeUserSql } from '../user-status.js';

export function registerDmRoutes(app) {
  app.get('/api/dm', async (c) => {
    const session = c.get('session');
    const dms = await listUserDms(c.env.DB, session.userId);
    return c.json({ dms });
  });

  app.post('/api/dm/open', async (c) => {
    const session = c.get('session');
    const payload = await parseJsonRequest(c.req.raw);
    const targetUserId = Number(payload.userId);

    if (!Number.isFinite(targetUserId) || targetUserId === session.userId) {
      return errorResponse('请选择有效用户');
    }

    const targetUser = await c.env.DB.prepare(
      `SELECT id, username, display_name, avatar_key
       FROM users
       WHERE id = ?
         AND ${activeUserSql()}
         AND deleted_at IS NULL
       LIMIT 1`
    )
      .bind(targetUserId)
      .all();

    if (!targetUser.results[0]) {
      return errorResponse('目标用户不存在', 404);
    }

    // [打招呼制 2026-11-01] 私聊闸：仅互认联系人或官方号可开（默认互不可聊）
    const target = targetUser.results[0];
    const officials = await listOfficialUsernames(c.env.DB);
    if (!officials.includes(target.username)) {
      const known = await areContacts(c.env.DB, session.userId, target.id);
      if (!known) {
        return errorResponse('还没建立联系：先在「新的对话」里给对方发一句打招呼，对方同意后就能聊了', 403);
      }
    }

    const [channel, blockStatus] = await Promise.all([
      ensureDmChannel(c.env.DB, session.userId, targetUserId),
      getUserBlockStatus(c.env.DB, session.userId, targetUserId)
    ]);
    return c.json({
      dm: {
        id: Number(channel.id),
        kind: 'dm',
        name: channel.dm_key,
        otherUser: {
          id: Number(targetUser.results[0].id),
          username: targetUser.results[0].username,
          displayName: targetUser.results[0].display_name,
          avatarUrl: targetUser.results[0].avatar_key
            ? `/files/${encodeURIComponent(targetUser.results[0].avatar_key)}`
            : ''
        },
        isBlockedByMe: blockStatus.blockedByMe
      }
    });
  });

  app.get('/api/admin/dms', async (c) => {
    const dms = await listAdminDms(c.env.DB);
    return c.json({ dms });
  });
}
