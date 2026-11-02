import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";

import { useChatRoom } from "../frontend/src/composables/useChatRoom.js";

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createSocket(params, handlers) {
	return {
		params,
		handlers,
		sentFrames: [],
		readyState: 1,
		close() {
			this.readyState = 3;
		},
		send(frame) {
			this.sentFrames.push(JSON.parse(frame));
		},
		emitMessage(message) {
			handlers.onMessage(JSON.stringify(message), this);
		},
	};
}

test("快速切换房间时丢弃旧历史响应和旧连接消息", async () => {
	const activeRoom = ref({ id: 1, kind: "public" });
	const requests = new Map();
	const sockets = [];
	const room = useChatRoom({
		activeRoom,
		session: ref({ userId: 7 }),
		error: ref(""),
		roomApi: {
			getMessages(_kind, roomId) {
				const request = deferred();
				requests.set(roomId, request);
				return request.promise;
			},
			async markRoomRead() {},
		},
		openRoomConnection(params) {
			const handlers = {
				onStatus: params.onStatus,
				onMessage: params.onMessage,
			};
			const socket = createSocket(params, handlers);
			sockets.push(socket);
			handlers.onStatus({ status: "open", socket });
			return socket;
		},
	});

	const firstActivation = room.activateRoom();
	activeRoom.value = { id: 2, kind: "private" };
	sockets[0].emitMessage({ type: "message", message: { id: 98, content: "stale before watcher" } });
	const secondActivation = room.activateRoom();
	sockets[0].emitMessage({ type: "message", message: { id: 99, content: "stale socket" } });
	requests.get(1).resolve({ messages: [{ id: 1, content: "stale history" }] });
	requests.get(2).resolve({ messages: [{ id: 2, content: "current history" }] });

	assert.equal(await firstActivation, false);
	assert.equal(await secondActivation, true);
	assert.deepEqual(room.messages.value, [{ id: 2, content: "current history" }]);
});

test("房间置顶状态从历史与实时事件同步，并发送管理动作", async () => {
	const activeRoom = ref({ id: 2, kind: "private" });
	const sockets = [];
	const room = useChatRoom({
		activeRoom,
		session: ref({ userId: 7 }),
		error: ref(""),
		roomApi: {
			async getMessages() {
				return {
					messages: [{ id: 10, sender: { id: 7, kind: "local" } }],
					pinnedMessage: { id: 10, sender: { id: 7, kind: "local" } },
				};
			},
			async markRoomRead() {},
		},
		openRoomConnection(params) {
			const handlers = { onStatus: params.onStatus, onMessage: params.onMessage };
			const socket = createSocket(params, handlers);
			sockets.push(socket);
			handlers.onStatus({ status: "open", socket });
			return socket;
		},
	});

	assert.equal(await room.activateRoom(), true);
	assert.equal(room.pinnedMessage.value.id, 10);
	assert.equal(room.pinMessage(10), true);
	assert.deepEqual(sockets[0].sentFrames.at(-1), { type: "pin_message", messageId: 10 });

	sockets[0].emitMessage({
		type: "message_pinned",
		message: { id: 11, sender: { id: 7, kind: "local" } },
	});
	assert.equal(room.pinnedMessage.value.id, 11);
	assert.equal(room.unpinMessage(11), true);
	assert.deepEqual(sockets[0].sentFrames.at(-1), { type: "unpin_message", messageId: 11 });

	sockets[0].emitMessage({ type: "message_unpinned", messageId: 11 });
	assert.equal(room.pinnedMessage.value, null);
	sockets[0].emitMessage({
		type: "message_pinned",
		message: { id: 10, sender: { id: 7, kind: "local" } },
	});
	sockets[0].emitMessage({ type: "message_deleted", messageId: 10 });
	assert.equal(room.pinnedMessage.value, null);
});

test("网页发送回复字段，并在原消息删除后保留已删除引用状态", async () => {
	const activeRoom = ref({ id: 2, kind: "private" });
	const sockets = [];
	const room = useChatRoom({
		activeRoom,
		session: ref({ userId: 7 }),
		error: ref(""),
		roomApi: {
			async getMessages() {
				return {
					messages: [
						{ id: 10, sender: { id: 3, kind: "local" } },
						{
							id: 11,
							sender: { id: 7, kind: "local" },
							replyToMessageId: 10,
							replyTo: { id: 10, deleted: false, content: "原消息" },
						},
					],
				};
			},
			async markRoomRead() {},
		},
		openRoomConnection(params) {
			const handlers = { onStatus: params.onStatus, onMessage: params.onMessage };
			const socket = createSocket(params, handlers);
			sockets.push(socket);
			handlers.onStatus({ status: "open", socket });
			return socket;
		},
	});

	await room.activateRoom();
	room.composerText.value = "回复正文";
	assert.equal(await room.sendMessage([], 10), true);
	assert.deepEqual(sockets[0].sentFrames.at(-1), {
		type: "send",
		clientMessageId: room.messages.value.at(-1).clientMessageId,
		content: "回复正文",
		attachment: null,
		mentionUserIds: [],
		replyMessageId: 10,
	});

	sockets[0].emitMessage({ type: "message_deleted", messageId: 10 });
	assert.deepEqual(room.messages.value[0].replyTo, { id: 10, deleted: true });
	sockets[0].emitMessage({ type: "message", message: {
		id: 12, sender: { id: 7, kind: "local" }, clientMessageId: sockets[0].sentFrames.at(-1).clientMessageId,
	} });
});
