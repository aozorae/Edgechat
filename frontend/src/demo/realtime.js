import {
	cloneDemo,
	createDemoMessage,
	demoState,
	getDemoDirectMessageBlockStatus,
	roomKey
} from './state.js';
import { isGroupChannelKind } from '../../../shared/group-channel.ts';

const roomSockets = new Map();
const inboxSockets = new Set();

function emit(socket, payload) {
  socket.onMessage?.(JSON.stringify(payload), socket);
}

function publishRoom(kind, roomId, payload) {
  const sockets = roomSockets.get(roomKey(kind, roomId)) || [];
  for (const socket of sockets) emit(socket, payload);
}

function publishInbox(kind, roomId, message, { incrementUnread = false } = {}) {
  const room = kind === 'dm'
    ? demoState.dms.find((dm) => Number(dm.id) === Number(roomId))
    : demoState.channels.find((channel) => Number(channel.id) === Number(roomId));
  if (room && incrementUnread) {
    room.unreadCount = Number(room.unreadCount || 0) + 1;
  }
  const mentionsMe = (message.mentionUserIds || []).includes(Number(demoState.session.userId));
  const replyToMe = message.replyTo?.sender?.kind !== 'external'
    && Number(message.replyTo?.sender?.id) === Number(demoState.session.userId);
  if (room && incrementUnread && (mentionsMe || replyToMe)) {
    room.mentionUnreadCount = Number(room.mentionUnreadCount || 0) + 1;
  }
  const payload = {
    type: 'room_message',
    room: {
      kind,
      id: Number(roomId),
      name: kind === 'dm' ? room?.otherUser?.displayName : room?.name
    },
    messageId: message.id,
    createdAt: message.createdAt,
    unreadCount: Number(room?.unreadCount || 0),
    mentionUnreadCount: Number(room?.mentionUnreadCount || 0),
    mentionsMe,
    replyToMe,
    contentPreview: message.content,
    sender: cloneDemo(message.sender)
  };
  for (const socket of inboxSockets) emit(socket, payload);
}

function currentSender() {
  return {
    id: demoState.session.userId,
    username: demoState.session.username,
    displayName: demoState.session.displayName,
    avatarUrl: demoState.session.avatarUrl,
    kind: 'user',
    source: 'edgechat'
  };
}

function telegramSender() {
  return {
    id: 'telegram:-1002345678901:demo',
    username: '',
    displayName: demoState.copy.telegramMember,
    avatarUrl: '',
    kind: 'external',
    source: 'telegram'
  };
}

function hasEnabledTelegramMapping(kind, roomId) {
  return isGroupChannelKind(kind) && demoState.telegram.mappings.some(
    (mapping) => Number(mapping.channelId) === Number(roomId) && mapping.enabled
  );
}

function handleRoomFrame(socket, frame) {
	const payload = JSON.parse(frame);
	if (payload.type === 'send') {
		if (socket.kind === 'dm') {
			const status = getDemoDirectMessageBlockStatus(socket.roomId, demoState.session.userId);
			if (status.blockedByPeer) {
					emit(socket, { type: 'error', error: '发送被拒，你已经被拉黑', clientMessageId: payload.clientMessageId });
				return;
			}
			if (status.blockedBySender) {
					emit(socket, { type: 'error', error: '请先解除拉黑再发送', clientMessageId: payload.clientMessageId });
				return;
			}
		}
		const existing = payload.clientMessageId && (demoState.messages[roomKey(socket.kind, socket.roomId)] || [])
			.find(message => message.clientMessageId === payload.clientMessageId
				&& Number(message.sender.id) === Number(demoState.session.userId) && message.sender.kind !== 'external');
		if (existing) {
			emit(socket, { type: 'message', message: cloneDemo(existing) });
			return;
		}
		const message = createDemoMessage({
      kind: socket.kind,
      roomId: socket.roomId,
      content: payload.content,
      attachment: payload.attachment,
      sender: currentSender(),
	      mentionUserIds: payload.mentionUserIds || [],
	      replyMessageId: payload.replyMessageId || null
    });
    if (payload.clientMessageId) message.clientMessageId = payload.clientMessageId;
    publishRoom(socket.kind, socket.roomId, { type: 'message', message: cloneDemo(message) });

    if (hasEnabledTelegramMapping(socket.kind, socket.roomId)) {
      globalThis.setTimeout(() => {
        const reply = createDemoMessage({
          kind: socket.kind,
          roomId: socket.roomId,
	        content: demoState.copy.telegramAutoReply,
	        attachment: null,
	        sender: telegramSender(),
	        mentionUserIds: [],
	        replyMessageId: message.id
        });
        publishRoom(socket.kind, socket.roomId, { type: 'message', message: cloneDemo(reply) });
        publishInbox(socket.kind, socket.roomId, reply, { incrementUnread: true });
      }, 650);
    }
    return;
  }

  if (payload.type === 'delete_message') {
    const key = roomKey(socket.kind, socket.roomId);
		demoState.messages[key] = (demoState.messages[key] || [])
		  .filter((message) => Number(message.id) !== Number(payload.messageId))
		  .map((message) => Number(message.replyToMessageId) === Number(payload.messageId)
		    ? { ...message, replyTo: { id: Number(payload.messageId), deleted: true } }
		    : message);
    publishRoom(socket.kind, socket.roomId, {
      type: 'message_deleted',
      messageId: Number(payload.messageId)
    });
    if (Number(demoState.pinnedMessages[key]?.id) === Number(payload.messageId)) {
      delete demoState.pinnedMessages[key];
    }
    return;
  }

  if (payload.type === 'pin_message' && socket.kind !== 'dm') {
    const key = roomKey(socket.kind, socket.roomId);
    const message = (demoState.messages[key] || []).find(
      (item) => Number(item.id) === Number(payload.messageId)
    );
    if (!message) return;
    demoState.pinnedMessages[key] = message;
    publishRoom(socket.kind, socket.roomId, {
      type: 'message_pinned',
      message: cloneDemo(message)
    });
    return;
  }

  if (payload.type === 'unpin_message' && socket.kind !== 'dm') {
    const key = roomKey(socket.kind, socket.roomId);
    if (Number(demoState.pinnedMessages[key]?.id) !== Number(payload.messageId)) return;
    delete demoState.pinnedMessages[key];
    publishRoom(socket.kind, socket.roomId, {
      type: 'message_unpinned',
      messageId: Number(payload.messageId)
    });
  }
}

class DemoSocket {
  constructor({ kind = '', roomId = 0, onMessage, onStatus, onSend, onClose }) {
    this.kind = kind;
    this.roomId = Number(roomId);
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onSend = onSend;
    this.onClose = onClose;
    this.readyState = 0;

    globalThis.setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onStatus?.({ status: 'open', socket: this });
    }, 30);
  }

  send(frame) {
    this.onSend?.(this, frame);
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.onClose?.(this);
    this.onStatus?.({
      status: 'closed',
      socket: this,
      code: 1000,
      reason: 'demo_navigation',
      wasClean: true
    });
  }
}

export function connectDemoRoomSocket({ kind, roomId, onMessage, onStatus }) {
  const key = roomKey(kind, roomId);
  const socket = new DemoSocket({
    kind,
    roomId,
    onMessage,
    onStatus,
    onSend: handleRoomFrame,
    onClose(currentSocket) {
      roomSockets.get(key)?.delete(currentSocket);
    }
  });
  if (!roomSockets.has(key)) roomSockets.set(key, new Set());
  roomSockets.get(key).add(socket);
  return socket;
}

export function connectDemoInboxSocket({ onMessage, onStatus }) {
  const socket = new DemoSocket({
    onMessage,
    onStatus,
    onClose(currentSocket) {
      inboxSockets.delete(currentSocket);
    }
  });
  inboxSockets.add(socket);
  return socket;
}
