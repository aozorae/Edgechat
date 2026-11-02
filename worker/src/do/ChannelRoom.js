import {
  MessageSubmissionError,
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

const MESSAGE_SIZE_LIMIT = 10 * 1024;

function socketMeta(token, principal, room) {
  return {
    token,
    principal,
    room
  };
}

function sendSocketError(ws, message, clientMessageId) {
  try {
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'error', error: message, clientMessageId }));
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

  async revalidateConnection(ws, meta, validations = new Map()) {
    if (!meta?.token || !meta.room) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    // 仅同一次广播内相同凭据/房间共享在途校验；发送前与写入后广播必须分别读取最新状态。
    const key = JSON.stringify([meta.token, meta.room.kind, meta.room.id]);
    if (!validations.has(key)) {
      validations.set(key, validateSession(this.env, meta.token, { room: meta.room }));
    }
    const auth = await validations.get(key);
    if (!auth.ok) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    const nextMeta = socketMeta(
      meta.token,
      {
        userId: auth.session.userId,
        isAdmin: auth.session.isAdmin
      },
      auth.room
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
    const validations = new Map();
    await Promise.all(connections.map(async ([socket, meta]) => {
      let currentMeta;
      try {
        currentMeta = await this.revalidateConnection(socket, meta, validations);
      } catch {
        // 单个收件人的存储读取失败不能阻止其他投递和提交后投影；失败连接本次不接收正文。
        console.error(JSON.stringify({ message: 'room broadcast validation failed', roomId: Number(meta.room?.id || 0) }));
        return;
      }
      if (!currentMeta) return;
      // 各连接验完即发，不让一个慢 KV 读取拖延其他合法收件人的消息确认。
      try {
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }));
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

      if (payload.clientMessageId !== undefined && (typeof payload.clientMessageId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.clientMessageId))) {
        throw new MessageSubmissionError('clientMessageId 必须是 UUID');
      }
      const result = await submitRoomMessageIdempotent(
        this.env,
        currentMeta,
        payload
      );
      if (!result.created) {
        // 重试只向发送连接补确认，避免重复未读、桥接和其他客户端的新消息事件。
        // 查询旧消息期间也可能撤权，补确认与新消息广播一样在发出正文前重新验证。
        if (await this.revalidateConnection(ws, currentMeta)) ws.send(result.packet);
        return;
      }
      await this.broadcast(result.packet);
      // 未读与外部桥接都属于提交后投影，异步执行以缩短 WebSocket 发送链路。
      this.runMessageProjections(currentMeta.room, result.message, result.replyToSenderId);
    } catch (error) {
      if (
        error instanceof MessageSubmissionError ||
        error instanceof MessageDeletionError ||
        error instanceof MessagePinningError
      ) {
        sendSocketError(ws, error.message, payload.type === 'send' ? payload.clientMessageId : undefined);
        return;
      }
      console.error(JSON.stringify({
        message: 'room message action failed',
        roomId: Number(meta.room?.id || 0),
        error: error instanceof Error ? error.message : String(error)
      }));
      sendSocketError(ws, '消息操作失败', payload.type === 'send' ? payload.clientMessageId : undefined);
    }
  }

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
