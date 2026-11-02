import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, ref } from "vue";
import { useChatRoom } from "../frontend/src/composables/useChatRoom.js";
import { MESSAGE_ACK_TIMEOUT_MS } from "../frontend/src/message-outbox.ts";

async function fixture(t, api = {}) {
	const activeRoom = ref({ id: 1, kind: "public" });
	const session = ref({ userId: 7, displayName: "Alice", token: "private-token" });
	const error = ref("");
	const sockets = [];
	const activity = [];
	let history = [];
	const scope = effectScope();
	const room = scope.run(() => useChatRoom({
		activeRoom, session, error, onRoomActivity: event => activity.push(event),
		roomApi: { getMessages: async () => ({ messages: history }), markRoomRead: async () => {}, ...api },
		openRoomConnection(params) {
			const socket = {
				readyState: 1, frames: [],
				send(frame) { this.frames.push(JSON.parse(frame)); },
				close() { this.readyState = 3; },
				emit(payload) { params.onMessage(JSON.stringify(payload), socket); },
				drop() { this.readyState = 3; params.onStatus({ status: "closed", code: 1000, socket }); },
			};
			sockets.push(socket);
			params.onStatus({ status: "open", socket });
			return socket;
		},
	}));
	t.after(() => scope.stop());
	await room.activateRoom();
	return { room, activeRoom, session, error, sockets, activity, setHistory: value => { history = value; } };
}

function canonical(frame, id = 10, senderId = 7) {
	return { id, clientMessageId: frame.clientMessageId, content: frame.content.trim(), sender: { id: senderId, kind: "local" } };
}

test("发送立即显示本地消息，重复确认只保留一条服务端消息，不提前更新未读", async t => {
	const h = await fixture(t);
	h.room.composerText.value = "hello";
	const sending = h.room.sendMessage();
	assert.equal(h.room.messages.value[0].sendStatus, "pending");
	assert.equal(h.room.messages.value[0].content, "hello");
	assert.equal(h.room.messages.value[0].sender.token, undefined);
	assert.equal(h.room.composerText.value, "");
	assert.equal(h.activity.length, 0);
	assert.equal(await sending, true);
	const frame = h.sockets[0].frames[0];
	assert.match(frame.clientMessageId, /^[0-9a-f-]{36}$/);
	h.sockets[0].emit({ type: "message", message: canonical(frame) });
	h.sockets[0].emit({ type: "message", message: canonical(frame) });
	assert.equal(h.room.messages.value.length, 1);
	assert.equal(h.room.messages.value[0].id, 10);
	assert.equal(h.room.messages.value[0].sendStatus, undefined);
});

test("错误按 ID 关联，重试保持原始正文、提及、回复与附件帧", async t => {
	const h = await fixture(t, { uploadFile: async () => ({ file: { key: "file", name: "a.png", type: "image/png" } }) });
	await h.room.uploadAttachment(new File(["image"], "a.png", { type: "image/png" }));
	h.room.composerText.value = "hello @bob";
	await h.room.sendMessage([8], 9);
	h.room.composerText.value = "another";
	await h.room.sendMessage();
	const first = h.sockets[0].frames[0];
	h.sockets[0].emit({ type: "error", clientMessageId: first.clientMessageId, error: "消息操作失败" });
	assert.equal(h.room.messages.value[0].sendStatus, "failed");
	assert.equal(h.room.messages.value[1].sendStatus, "pending");
	h.room.retryMessage(first.clientMessageId);
	assert.equal(h.error.value, "");
	h.room.retryMessage(first.clientMessageId);
	assert.equal(h.sockets[0].frames.length, 3);
	assert.deepEqual(h.sockets[0].frames[2], first);
	assert.equal(h.room.messages.value[0].sendStatus, "pending");
});

test("确认超时后可以重试，迟到确认仍替换失败项", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = await fixture(t);
	h.room.composerText.value = "slow";
	await h.room.sendMessage();
	t.mock.timers.tick(MESSAGE_ACK_TIMEOUT_MS);
	assert.equal(h.room.messages.value[0].sendStatus, "failed");
	h.sockets[0].emit({ type: "message", message: canonical(h.sockets[0].frames[0]) });
	assert.equal(h.room.messages.value.length, 1);
	assert.equal(h.room.messages.value[0].id, 10);
});

test("历史刷新和切房不丢失待确认项，其他发送者的同名键不能确认", async t => {
	const h = await fixture(t);
	h.room.composerText.value = "stay";
	await h.room.sendMessage();
	const frame = h.sockets[0].frames[0];
	h.setHistory([canonical(frame, 9, 8)]);
	await h.room.loadMessages();
	assert.equal(h.room.messages.value.length, 2);
	h.activeRoom.value = { id: 2, kind: "private" };
	h.setHistory([]);
	await h.room.activateRoom();
	assert.equal(h.room.messages.value.length, 0);
	h.room.retryMessage(frame.clientMessageId);
	assert.equal(h.sockets[1].frames.length, 0);
	h.activeRoom.value = { id: 1, kind: "public" };
	await h.room.activateRoom();
	assert.equal(h.room.messages.value.length, 1);
	h.setHistory([canonical(frame)]);
	await h.room.loadMessages();
	assert.equal(h.room.messages.value.length, 1);
	assert.equal(h.room.messages.value[0].id, 10);
});

test("连接断开将待确认项标记失败，退出登录清空发件箱", async t => {
	const h = await fixture(t);
	h.room.composerText.value = "disconnect";
	await h.room.sendMessage();
	const id = h.sockets[0].frames[0].clientMessageId;
	h.sockets[0].drop();
	assert.equal(h.room.messages.value[0].sendStatus, "failed");
	h.room.connectSocket();
	h.room.retryMessage(id);
	assert.equal(h.sockets[1].frames[0].clientMessageId, id);
	h.session.value = null;
	assert.deepEqual(h.room.messages.value, []);
});

test("同步发送失败也保留可重试项，语音上传完成后切房不误发", async t => {
	let uploadDone;
	const h = await fixture(t, { uploadFile: () => new Promise(resolve => { uploadDone = resolve; }) });
	h.sockets[0].send = () => { throw new Error("Disconnected"); };
	h.room.composerText.value = "retry me";
	assert.equal(await h.room.sendMessage(), true);
	assert.equal(h.room.messages.value[0].sendStatus, "failed");
	const voice = h.room.sendVoiceMessage({ file: new File(["voice"], "voice.webm"), durationMs: 500, waveform: [0.5] });
	h.activeRoom.value = { id: 2, kind: "private" };
	await h.room.activateRoom();
	uploadDone({ file: { key: "voice", type: "audio/webm" } });
	assert.equal(await voice, false);
	assert.equal(h.room.messages.value.length, 0);
	assert.equal(h.sockets[1].frames.length, 0);
});

test("语音消息复用发件箱，失败重试保留时长、波形和回复", async t => {
	const h = await fixture(t, { uploadFile: async () => ({ file: { key: "voice", type: "audio/webm" } }) });
	assert.equal(await h.room.sendVoiceMessage({ file: new File(["voice"], "voice.webm"), durationMs: 500, waveform: [0.5] }, 9), true);
	const frame = h.sockets[0].frames[0];
	assert.equal(h.room.messages.value[0].sendStatus, "pending");
	assert.deepEqual(frame.attachment, { key: "voice", type: "audio/webm", kind: "voice", durationMs: 500, waveform: [0.5] });
	h.sockets[0].emit({ type: "error", clientMessageId: frame.clientMessageId, error: "消息操作失败" });
	h.room.retryMessage(frame.clientMessageId);
	assert.deepEqual(h.sockets[0].frames[1], frame);
	assert.equal(frame.replyMessageId, 9);
});
