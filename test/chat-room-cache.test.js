import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, ref } from "vue";
import { dispatchAuthInvalid } from "../frontend/src/auth-storage.js";
import { useChatRoom } from "../frontend/src/composables/useChatRoom.js";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function message(id, content = `message ${id}`) {
	return { id, content, sender: { id: 7, kind: "local" } };
}

function harness(t) {
	const scope = effectScope();
	const activeRoom = ref({ kind: "private", id: 1 });
	const session = ref({ userId: 7, token: "login-1" });
	const error = ref("");
	const requests = [];
	const sockets = [];
	const revoked = [];
	const room = scope.run(() => useChatRoom({
		activeRoom, session, error,
		onRoomAccessRevoked: (value) => revoked.push(value),
		roomApi: {
			getMessages(kind, id, before) {
				const request = { ...deferred(), kind, id, before };
				requests.push(request);
				return request.promise;
			},
			async markRoomRead() {},
		},
		openRoomConnection(params) {
			const socket = {
				readyState: 1,
				close() { this.readyState = 3; },
				send() {},
				emit(payload) { params.onMessage(JSON.stringify(payload), socket); },
				revoke(code = 4403) { this.readyState = 3; params.onStatus({ status: "closed", socket, code, reason: code === 1008 ? "Unauthorized" : "" }); },
			};
			sockets.push(socket);
			params.onStatus({ status: "open", socket });
			return socket;
		},
	}));
	t.after(() => scope.stop());
	function activate(id, kind = "private") {
		activeRoom.value = { id, kind };
		return room.activateRoom();
	}
	async function visit(id, messages = [message(id)], pinnedMessage = null, kind = "private") {
		const pending = activate(id, kind);
		requests.at(-1).resolve({ messages, pinnedMessage });
		assert.equal(await pending, true);
	}
	return { room, activeRoom, session, error, requests, sockets, revoked, activate, visit, stop: () => scope.stop() };
}

test("A→B→A 在延迟历史请求完成前恢复消息与置顶，并继续后台刷新", async (t) => {
	const h = harness(t);
	await h.visit(1, [message(10)], message(10));
	await h.visit(2);
	const pending = h.activate(1);
	assert.deepEqual(h.room.messages.value, [message(10)]);
	assert.equal(h.room.pinnedMessage.value.id, 10);
	assert.equal(h.room.refreshing.value, true);
	assert.equal(h.requests.length, 3, "缓存命中仍请求服务端历史并重新鉴权");
	h.requests.at(-1).resolve({ messages: [message(10, "updated"), message(11)], pinnedMessage: null });
	assert.equal(await pending, true);
	assert.deepEqual(h.room.messages.value, [message(10, "updated"), message(11)]);
	assert.equal(h.room.pinnedMessage.value, null);
	assert.equal(h.room.refreshing.value, false);
});

test("空会话也有快照，首次打开与后台刷新状态可区分", async (t) => {
	const h = harness(t);
	const first = h.activate(1);
	assert.equal(h.room.loading.value, true);
	assert.equal(h.room.refreshing.value, false);
	h.requests.at(-1).resolve({ messages: [], pinnedMessage: null });
	await first;
	await h.visit(2);
	const refresh = h.activate(1);
	assert.deepEqual(h.room.messages.value, []);
	assert.equal(h.room.refreshing.value, true);
	h.requests.at(-1).resolve({ messages: [] });
	await refresh;
});

test("离开期间的删除与修改以完整历史为准，不合并回旧快照", async (t) => {
	const h = harness(t);
	await h.visit(1, [message(10), message(11)], message(10));
	await h.visit(2);
	const refresh = h.activate(1);
	h.requests.at(-1).resolve({ messages: [message(11, "edited")], pinnedMessage: null });
	await refresh;
	assert.deepEqual(h.room.messages.value, [message(11, "edited")]);
	await h.visit(2);
	const again = h.activate(1);
	assert.deepEqual(h.room.messages.value, [message(11, "edited")]);
	assert.equal(h.room.pinnedMessage.value, null);
	h.requests.at(-1).resolve({ messages: [] });
	await again;
});

test("刷新期间的新消息、删除和引用状态不会被较早的历史响应覆盖", async (t) => {
	const h = harness(t);
	await h.visit(1, [message(10)]);
	await h.visit(2);
	const refresh = h.activate(1);
	const socket = h.sockets.at(-1);
	socket.emit({ type: "message", message: message(12) });
	socket.emit({ type: "message_deleted", messageId: 10 });
	h.requests.at(-1).resolve({
		messages: [message(10), { ...message(11), replyToMessageId: 10, replyTo: message(10) }],
		pinnedMessage: message(10),
	});
	await refresh;
	assert.deepEqual(h.room.messages.value.map((value) => value.id), [11, 12]);
	assert.deepEqual(h.room.messages.value[0].replyTo, { id: 10, deleted: true });
	assert.equal(h.room.pinnedMessage.value, null);
});

test("刷新期间置顶与取消置顶事件优先于历史响应", async (t) => {
	const h = harness(t);
	await h.visit(1);
	for (const unpin of [false, true]) {
		const refresh = h.room.loadMessages();
		const socket = h.sockets.at(-1);
		socket.emit({ type: "message_pinned", message: message(12) });
		if (unpin) socket.emit({ type: "message_unpinned", messageId: 12 });
		h.requests.at(-1).resolve({ messages: [message(1)], pinnedMessage: message(1) });
		await refresh;
		assert.equal(h.room.pinnedMessage.value?.id ?? null, unpin ? null : 12);
	}
});

test("快速 A→B→A 不接受第一次 A 的响应或旧连接事件", async (t) => {
	const h = harness(t);
	await h.visit(1, [message(10)]);
	await h.visit(2);
	const firstA = h.activate(1);
	const oldRequest = h.requests.at(-1);
	const oldSocket = h.sockets.at(-1);
	await h.visit(2);
	const secondA = h.activate(1);
	assert.deepEqual(h.room.messages.value, [message(10)]);
	oldRequest.resolve({ messages: [message(999)] });
	oldSocket.emit({ type: "message", message: message(999) });
	assert.equal(await firstA, false);
	assert.deepEqual(h.room.messages.value, [message(10)]);
	assert.equal(h.room.loading.value, true);
	h.requests.at(-1).resolve({ messages: [message(11)] });
	await secondA;
	assert.deepEqual(h.room.messages.value, [message(11)]);
});

test("网络失败保留快照并提示失败，重试后恢复最新内容", async (t) => {
	const h = harness(t);
	await h.visit(1, [message(10)]);
	await h.visit(2);
	const refresh = h.activate(1);
	h.requests.at(-1).reject(new Error("offline"));
	assert.equal(await refresh, false);
	assert.deepEqual(h.room.messages.value, [message(10)]);
	assert.equal(h.room.refreshFailed.value, true);
	assert.equal(h.room.refreshing.value, false);
	assert.equal(h.error.value, "offline");
	const retry = h.room.loadMessages();
	assert.equal(h.room.refreshFailed.value, false);
	assert.equal(h.room.refreshing.value, true);
	h.requests.at(-1).resolve({ messages: [message(11)] });
	await retry;
	assert.deepEqual(h.room.messages.value, [message(11)]);
});

for (const status of [403, 404]) {
	test(`历史返回 ${status} 清理消息、置顶和房间快照`, async (t) => {
		const h = harness(t);
		await h.visit(1, [message(10)], message(10));
		await h.visit(2);
		const refresh = h.activate(1);
		h.requests.at(-1).reject(Object.assign(new Error("forbidden"), { status }));
		assert.equal(await refresh, false);
		assert.deepEqual(h.room.messages.value, []);
		assert.equal(h.room.pinnedMessage.value, null);
		assert.equal(h.sockets.at(-1).readyState, 3);
		assert.equal(h.revoked.length, 1);
		const retry = h.activate(1);
		assert.deepEqual(h.room.messages.value, []);
		assert.equal(h.room.refreshing.value, false);
		h.requests.at(-1).resolve({ messages: [] });
		await retry;
	});
}

for (const code of [4403, 1008]) {
	test(`WS ${code} 撤权使在途历史响应失效且不能恢复快照`, async (t) => {
		const h = harness(t);
		await h.visit(1, [message(10)], message(10));
		await h.visit(2);
		const refresh = h.activate(1);
		const request = h.requests.at(-1);
		h.sockets.at(-1).revoke(code);
		assert.deepEqual(h.room.messages.value, []);
		assert.equal(h.room.pinnedMessage.value, null);
		request.resolve({ messages: [message(10)], pinnedMessage: message(10) });
		assert.equal(await refresh, false);
		assert.deepEqual(h.room.messages.value, []);
		const retry = h.activate(1);
		assert.deepEqual(h.room.messages.value, []);
		h.requests.at(-1).resolve({ messages: [] });
		await retry;
	});
}

test("旧会话的迟到 403 只使该快照失效，不清空当前会话", async (t) => {
	const h = harness(t);
	await h.visit(1);
	await h.visit(2);
	const refresh = h.activate(1);
	const denied = h.requests.at(-1);
	await h.visit(2);
	denied.reject(Object.assign(new Error("forbidden"), { status: 403 }));
	await refresh;
	assert.deepEqual(h.room.messages.value, [message(2)]);
	assert.equal(h.revoked.length, 0);
	const retry = h.activate(1);
	assert.deepEqual(h.room.messages.value, []);
	h.requests.at(-1).resolve({ messages: [] });
	await retry;
});

for (const invalidation of ["logout", "account", "token", "401", "4401"]) {
	test(`${invalidation} 清理所有快照与在途读取`, async (t) => {
		const h = harness(t);
		await h.visit(1);
		await h.visit(2);
		const pending = h.activate(1);
		const oldRequest = h.requests.at(-1);
		if (invalidation === "logout") h.session.value = null;
		if (invalidation === "account") h.session.value = { userId: 8, token: "login-2" };
		if (invalidation === "token") h.session.value = { userId: 7, token: "login-2" };
		if (invalidation === "401") oldRequest.reject(Object.assign(new Error("unauthorized"), { status: 401 }));
		if (invalidation === "4401") h.sockets.at(-1).revoke(4401);
		if (invalidation !== "401") oldRequest.resolve({ messages: [message(999)] });
		assert.equal(await pending, false);
		assert.deepEqual(h.room.messages.value, []);
		h.session.value = { userId: 7, token: "login-3" };
		for (const id of [1, 2]) {
			const refresh = h.activate(id);
			assert.deepEqual(h.room.messages.value, []);
			assert.equal(h.room.refreshing.value, false);
			h.requests.at(-1).resolve({ messages: [] });
			await refresh;
		}
	});
}

test("暂停后恢复复用快照，并丢弃暂停前的定位请求", async (t) => {
	const h = harness(t);
	await h.visit(1, [message(10)]);
	const reveal = h.room.revealMessage(5);
	await Promise.resolve();
	const oldRequest = h.requests.at(-1);
	h.room.pauseRoom();
	const refresh = h.activate(1);
	assert.deepEqual(h.room.messages.value, [message(10)]);
	oldRequest.resolve({ messages: [message(5)] });
	assert.equal(await reveal, false);
	assert.deepEqual(h.room.messages.value, [message(10)]);
	h.requests.at(-1).resolve({ messages: [message(11)] });
	await refresh;
});

test("不同 kind 下相同 id 的快照隔离，删除或卸载后不恢复", async (t) => {
	const h = harness(t);
	await h.visit(1, [message(10)], null, "public");
	await h.visit(1, [message(20)], null, "dm");
	const pending = h.activate(1, "public");
	assert.deepEqual(h.room.messages.value, [message(10)]);
	h.activeRoom.value = null;
	h.room.deactivateRoom();
	h.requests.at(-1).resolve({ messages: [message(999)] });
	assert.equal(await pending, false);
	const retry = h.activate(1, "public");
	assert.deepEqual(h.room.messages.value, []);
	h.requests.at(-1).resolve({ messages: [message(10)] });
	await retry;
	h.room.composerText.value = "draft";
	// Stopping the owning Vue scope mirrors ChatPage unmount.
	h.stop();
	assert.equal(h.room.composerText.value, "");
	assert.deepEqual(h.room.messages.value, []);
	assert.equal(await h.activate(1), false);
});

test("快照限制为最近 8 个会话、每个 100 条，访问过的会话提升淘汰优先级", async (t) => {
	const h = harness(t);
	const batch = Array.from({ length: 130 }, (_, index) => message(index + 1));
	await h.visit(1, batch);
	await h.visit(2);
	const restore = h.activate(1);
	assert.equal(h.room.messages.value.length, 100);
	assert.equal(h.room.messages.value[0].id, 31);
	h.requests.at(-1).resolve({ messages: batch });
	await restore;
	for (let id = 3; id <= 9; id++) await h.visit(id);
	// Room 1 was touched after room 2, so room 2 is evicted first.
	const recent = h.activate(1);
	assert.equal(h.room.messages.value.length, 100);
	h.requests.at(-1).resolve({ messages: batch });
	await recent;
	const evicted = h.activate(2);
	assert.deepEqual(h.room.messages.value, []);
	h.requests.at(-1).resolve({ messages: [] });
	await evicted;
});

test("超出总字节预算的快照不会保留", async (t) => {
	const h = harness(t);
	await h.visit(1, [message(1, "中".repeat(800_000))]);
	await h.visit(2);
	const restore = h.activate(1);
	assert.deepEqual(h.room.messages.value, []);
	h.requests.at(-1).resolve({ messages: [] });
	await restore;
});

test("多会话快照累计达到字节预算时淘汰最久未使用的会话", async (t) => {
	const h = harness(t);
	for (let id = 1; id <= 4; id++) await h.visit(id, [message(id, "中".repeat(250_000))]);
	const evicted = h.activate(1);
	assert.deepEqual(h.room.messages.value, []);
	h.requests.at(-1).resolve({ messages: [] });
	await evicted;
	const retained = h.activate(3);
	assert.equal(h.room.messages.value[0].id, 3);
	h.requests.at(-1).resolve({ messages: [] });
	await retained;
});

test("任意接口发出的登录失效事件同步清理快照，卸载时移除监听", async (t) => {
	const previousWindow = globalThis.window;
	globalThis.window = new EventTarget();
	const h = harness(t);
	try {
		await h.visit(1);
		await h.visit(2);
		dispatchAuthInvalid("expired");
		assert.deepEqual(h.room.messages.value, []);
		const refresh = h.activate(1);
		assert.deepEqual(h.room.messages.value, []);
		h.requests.at(-1).resolve({ messages: [] });
		await refresh;
		h.stop();
		h.room.composerText.value = "unmounted";
		dispatchAuthInvalid("expired");
		assert.equal(h.room.composerText.value, "unmounted", "卸载后事件不再操作已销毁的实例");
	} finally {
		h.stop();
		if (previousWindow === undefined) delete globalThis.window;
		else globalThis.window = previousWindow;
	}
});
