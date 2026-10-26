import {
  MessageSubmissionError,
  submitRoomMessage,
  submitRoomMessageIdempotent
} from '../message-submission.js';
import { deleteRoomMessage, MessageDeletionError } from '../message-deletion.js';
import {
  MessagePinningError,
  pinRoomMessage,
  unpinRoomMessage
} from '../message-pinning.js';
import { submitExternalMessage } from '../external-message-submission.js';
import { forwardEdgeChatMessageToTelegram } from '../integrations/telegram/bridge.js';
import { isGroupChannelKind } from '../../../shared/group-channel.ts';
import { authorizeRoom } from '../room-access.js';
import { validateSession } from '../session.js';
import { projectUnreadMessage } from '../unread-projection.js';
import { isVerifiedInternalRequest, parseVerifiedPrincipal } from '../verified-identity.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';
import { wakeForMessage } from '../integrations/instance-bridge/delivery.ts';
import { runAiReply } from '../integrations/ai-reply/runner.js';

const MESSAGE_SIZE_LIMIT = 10 * 1024;

function socketMeta(token, principal, room) {
  return {
    token,
    principal,
    room
  };
}

function sendSocketError(ws, message) {
  try {
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'error', error: message }));
  } catch {
    // Ignore broken sockets.
  }
}

function getMessageByteLength(message) {
  if (typeof message === 'string') {
    return new TextEncoder().encode(message).length;
  }
  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }
  if (ArrayBuffer.isView(message)) {
    return message.byteLength;
  }

  // 未知 WebSocket 消息类型无法可靠解析，按超大处理，避免绕过大小限制。
  return Number.MAX_SAFE_INTEGER;
}

function normalizeWebSocketMessage(message) {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message);
  }
  if (ArrayBuffer.isView(message)) {
    return new TextDecoder().decode(message);
  }
  return '';
}

export class ChannelRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Map();

    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment();
      if (meta) {
        this.connections.set(socket, meta);
      }
    }
  }

  parsePayload(ws, message) {
    try {
      return JSON.parse(message);
    } catch {
      sendSocketError(ws, 'Invalid message payload');
      return null;
    }
  }

  async revalidateConnection(ws, meta) {
    if (!meta?.token) {
      return null;
    }

    const auth = await validateSession(this.env, meta.token);
    if (!auth.ok) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    const access = await authorizeRoom(
      this.env.DB,
      auth.session,
      meta.room.kind,
      meta.room.id
    );
    if (!access.ok) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    const { room } = access;

    const nextMeta = socketMeta(
      meta.token,
      {
        userId: auth.session.userId,
        isAdmin: auth.session.isAdmin
      },
      room
    );
    this.connections.set(ws, nextMeta);
    ws.serializeAttachment(nextMeta);
    return nextMeta;
  }

  closeUnauthorizedSocket(ws) {
    this.connections.delete(ws);
    try {
      ws.close(1008, 'Unauthorized');
    } catch {
      // Ignore broken sockets.
    }
  }

  async broadcast(packet) {
    const connections = [...this.connections.entries()];
    const validated = await Promise.all(
      connections.map(async ([socket, meta]) => ({
        socket,
        meta: await this.revalidateConnection(socket, meta)
      }))
    );

    for (const { socket, meta } of validated) {
      if (!meta) continue;
      try {
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  runMessageProjections(room, message, replyToSenderId = null) {
    this.state.waitUntil(
      Promise.all([
        projectUnreadMessage(this.env, {
          room,
          senderId: message.sender.kind === 'local' ? message.sender.id : null,
          message,
          replyToSenderId
        }),
        forwardEdgeChatMessageToTelegram(this.env, { room, message }),
        wakeForMessage(this.env, room, message)
      ])
    );
  }

  runAttachmentCleanup(result) {
    if (result.cleanupPromise) {
      this.state.waitUntil(result.cleanupPromise);
    }
  }

  /**
   * 期一增项：文本回复链。消息落库并广播后异步触发，不阻塞发送方响应。
   * 只对「用户 与 笨笨」的一对一 dm 生效（判定在 runner 内，非 dm 直接返回）。
   */
  scheduleAiReply(room, message) {
    if (!room || room.kind !== 'dm' || !message?.sender || message.sender.kind !== 'local') {
      return;
    }
    this.state.waitUntil(
      runAiReply({
        env: this.env,
        room,
        triggerMessage: message,
        onReply: (replyMessage) => this.deliverAiReply(room, replyMessage)
      }).catch((error) => {
        console.error(
          JSON.stringify({
            message: 'ai reply failed',
            roomId: Number(room.id),
            error: error instanceof Error ? error.message : String(error)
          })
        );
      })
    );
  }

  async deliverAiReply(room, message) {
    await this.broadcast(JSON.stringify({ protocolVersion: 1, type: 'message', message }));
    this.runMessageProjections(room, message, null);
  }

  async receiveExternalMessage(request) {
    if (!isVerifiedInternalRequest(request)) {
      return Response.json({ error: { code: 'authentication_required', message: 'Unauthorized' } }, { status: 401 });
    }

    const payload = await request.json();
    const room = payload.room;
    if (!isGroupChannelKind(room?.kind) || !Number.isInteger(Number(room.id))) {
      return Response.json({ error: { code: 'invalid_room', message: 'Invalid room' } }, { status: 400 });
    }

    try {
      const result = await submitExternalMessage(this.env, { room, payload });
      if (result.created) {
        await this.broadcast(result.packet);
        this.runMessageProjections(room, result.message, result.replyToSenderId);
      }
      return Response.json({ ok: true, created: result.created, message: result.message });
    } catch (error) {
      const stopped = String(error).includes('BRIDGE_NOT_RECEIVING');
      return Response.json({ error: { code: stopped ? 'not_receiving' : 'internal_error',
        message: stopped ? '跨实例绑定当前不接收消息' : '外部消息提交失败' } }, { status: stopped ? 409 : 500 });
    }
  }

  async receiveClientAction(request) {
    if (!isVerifiedInternalRequest(request)) {
      return Response.json(
        { error: { code: 'authentication_required', message: '请先登录' } },
        { status: 401 }
      );
    }

    const principal = parseVerifiedPrincipal(request);
    const payload = await request.json();
    const room = payload.room;
    const action = payload.action;
    const access = principal
      ? await authorizeRoom(this.env.DB, principal, room?.kind, Number(room?.id))
      : { ok: false };
    if (!access.ok) {
      return Response.json(
        { error: { code: 'forbidden', message: '无权访问该会话' } },
        { status: 403 }
      );
    }

    const meta = { principal, room: access.room };
    try {
      if (action?.type === 'send') {
        const result = await submitRoomMessageIdempotent(this.env, meta, action);
        if (result.created) {
          await this.broadcast(result.packet);
          this.runMessageProjections(access.room, result.message, result.replyToSenderId);
          this.scheduleAiReply(access.room, result.message);
        }
        return Response.json({ created: result.created, message: result.message });
      }
      if (action?.type === 'delete_message') {
        const result = await deleteRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        this.runAttachmentCleanup(result);
        return Response.json({ ok: true, messageId: result.messageId });
      }
      if (action?.type === 'pin_message') {
        const result = await pinRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        return Response.json({ ok: true, message: result.message });
      }
      if (action?.type === 'unpin_message') {
        const result = await unpinRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        return Response.json({ ok: true, messageId: result.messageId });
      }
      return Response.json(
        { error: { code: 'invalid_request', message: '不支持的消息操作' } },
        { status: 400 }
      );
    } catch (error) {
      if (
        error instanceof MessageSubmissionError ||
        error instanceof MessageDeletionError ||
        error instanceof MessagePinningError
      ) {
        return Response.json(
          { error: { code: error.code || 'invalid_request', message: error.message } },
          { status: error.status || 400 }
        );
      }
      console.error(JSON.stringify({
        message: 'client room action failed',
        roomId: Number(access.room.id),
        error: error instanceof Error ? error.message : String(error)
      }));
      return Response.json(
        { error: { code: 'internal_error', message: '消息操作失败' } },
        { status: 500 }
      );
    }
  }

  async fetch(request) {
    const health = durableObjectHealth(request, 'ChannelRoom');
    if (health) return health;
    const url = new URL(request.url);

    if (url.pathname === '/external-message' && request.method === 'POST') {
      return this.receiveExternalMessage(request);
    }

    if (url.pathname === '/client-action' && request.method === 'POST') {
      return this.receiveClientAction(request);
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const token = url.searchParams.get('token') || '';
    const kind = url.searchParams.get('kind') || '';
    const roomId = Number(url.searchParams.get('id') || '');

    let principal = parseVerifiedPrincipal(request);
    if (!principal) {
      const auth = await validateSession(this.env, token);
      if (!auth.ok) {
        return new Response('Unauthorized', { status: 401 });
      }

      principal = {
        userId: auth.session.userId,
        isAdmin: auth.session.isAdmin
      };
    }

    const access = await authorizeRoom(this.env.DB, principal, kind, roomId);

    if (!access.ok) {
      return new Response('Forbidden', { status: 403 });
    }
    const { room } = access;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const meta = socketMeta(token, principal, room);
    server.serializeAttachment(meta);
    this.connections.set(server, meta);
    server.send(
      JSON.stringify({
        protocolVersion: 1,
        type: 'ready',
        room: {
          id: Number(room.id),
          kind: room.kind,
          name: room.name
        }
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = this.connections.get(ws);
    if (!meta) {
      return;
    }

    if (getMessageByteLength(message) > MESSAGE_SIZE_LIMIT) {
      sendSocketError(ws, `消息过大，最大 ${Math.round(MESSAGE_SIZE_LIMIT / 1024)}KB`);
      return;
    }

    const payload = this.parsePayload(ws, normalizeWebSocketMessage(message));
    if (!payload) {
      return;
    }

    if (!['send', 'delete_message', 'pin_message', 'unpin_message'].includes(payload.type)) {
      sendSocketError(ws, 'Unsupported message type');
      return;
    }

    try {
      const currentMeta = await this.revalidateConnection(ws, meta);
      if (!currentMeta) {
        return;
      }

      if (payload.type === 'delete_message') {
        const result = await deleteRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(result.packet);
        this.runAttachmentCleanup(result);
        return;
      }
      if (payload.type === 'pin_message') {
        const { packet } = await pinRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(packet);
        return;
      }
      if (payload.type === 'unpin_message') {
        const { packet } = await unpinRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(packet);
        return;
      }

      const { message: saved, packet } = await submitRoomMessage(
        this.env,
        currentMeta,
        payload
      );
      await this.broadcast(packet);
      // 未读与外部桥接都属于提交后投影，异步执行以缩短 WebSocket 发送链路。
      this.runMessageProjections(currentMeta.room, saved);
      this.scheduleAiReply(currentMeta.room, saved);
    } catch (error) {
      if (
        error instanceof MessageSubmissionError ||
        error instanceof MessageDeletionError ||
        error instanceof MessagePinningError
      ) {
        sendSocketError(ws, error.message);
        return;
      }
      console.error(JSON.stringify({
        message: 'room message action failed',
        roomId: Number(meta.room?.id || 0),
        error: error instanceof Error ? error.message : String(error)
      }));
      sendSocketError(ws, '消息操作失败');
    }
  }

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
