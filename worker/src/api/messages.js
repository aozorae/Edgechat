import { listMessages } from '../data/messages.js';
import { getPinnedMessage } from '../data/pins.js';
import { markRoomRead } from '../data/unread.js';
import { authorizeRoom, isRoomKind } from '../room-access.js';
import { errorResponse, parseJsonRequest, sanitizeLimit } from '../utils.js';

export function registerMessageRoutes(app) {
  app.get('/api/messages', async (c) => {
    const session = c.get('session');
    const kind = c.req.query('kind');
    const roomId = Number(c.req.query('roomId'));
    const before = c.req.query('before');
    const limit = sanitizeLimit(c.req.query('limit'));

    if (!isRoomKind(kind) || !Number.isInteger(roomId) || roomId <= 0) {
      return errorResponse('参数无效');
    }

    const access = await authorizeRoom(c.env.DB, session, kind, roomId);

    if (!access.ok) {
      return errorResponse('无权访问该会话', 403);
    }

    const [messages, pinnedMessage] = await Promise.all([
      listMessages(c.env, roomId, before, limit),
      getPinnedMessage(c.env, roomId)
    ]);
    // 只确认首屏已返回的水位；旧页不能顺带读掉新消息，已读失败也不阻塞正文显示。
    if (!before && messages.length) {
      c.executionCtx.waitUntil(markRoomRead(c.env.DB, {
        channelId: roomId,
        userId: session.userId,
        messageId: messages.at(-1).id
      }).catch(() => { console.error('history_read_receipt_failed'); }));
    }

    return c.json({
      room: {
        id: Number(access.room.id),
        kind: access.room.kind,
        name: access.room.name,
        description: access.room.description
      },
      messages,
      pinnedMessage
    });
  });

  app.post('/api/messages/read', async (c) => {
    const session = c.get('session');
    const payload = await parseJsonRequest(c.req.raw);
    const kind = String(payload.kind || '');
    const roomId = Number(payload.roomId);
    const messageId = payload.messageId === undefined ? null : Number(payload.messageId);

    if (
      !isRoomKind(kind) ||
      !Number.isInteger(roomId) ||
      roomId <= 0 ||
      (messageId !== null && (!Number.isInteger(messageId) || messageId <= 0))
    ) {
      return errorResponse('参数无效');
    }

    const access = await authorizeRoom(c.env.DB, session, kind, roomId);

    if (!access.ok) {
      return errorResponse('无权访问该会话', 403);
    }

    const lastReadMessageId = await markRoomRead(c.env.DB, {
      channelId: roomId,
      userId: session.userId,
      messageId
    });

    return c.json({ ok: true, lastReadMessageId });
  });
}
