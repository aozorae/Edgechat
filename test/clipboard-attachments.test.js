import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { effectScope, ref } from "vue";
import { getClipboardFiles } from "../frontend/src/components/chat/clipboard-files.js";
import { isPdfAttachment, isVideoAttachment } from "../frontend/src/components/chat/attachment-utils.js";
import { useAttachmentQueue } from "../frontend/src/composables/useAttachmentQueue.js";
import { useChatRoom } from "../frontend/src/composables/useChatRoom.js";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

function file(name = "image.png") {
	return new File(["test"], name, { type: "image/png" });
}

function uploaded(input) {
	return { file: { key: input.name, name: input.name, type: input.type } };
}

function createRoom(uploadFile) {
	const activeRoom = ref({ id: 1, kind: "public" });
	const frames = [];
	const error = ref("");
	const socket = {
		readyState: 1,
		send(frame) { frames.push(JSON.parse(frame)); },
		close() { this.readyState = 3; },
	};
	const scope = effectScope();
	const room = scope.run(() => useChatRoom({
		activeRoom,
		error,
		session: ref({ userId: 7 }),
		roomApi: { uploadFile },
		openRoomConnection(params) {
			params.onStatus({ status: "open", socket });
			return socket;
		},
	}));
	room.connectSocket();
	return { room, activeRoom, frames, socket, scope, error };
}

test("clipboard files preserve order and do not duplicate files exposed as items", () => {
	const first = file();
	const second = file("second.png");
	assert.deepEqual(getClipboardFiles({ files: [first, second], items: [
		{ kind: "file", getAsFile: () => first },
	] }), [first, second]);
	assert.deepEqual(getClipboardFiles({ files: [], items: [
		{ kind: "string" },
		{ kind: "file", getAsFile: () => first },
		{ kind: "file", getAsFile: () => null },
	] }), [first]);
	assert.deepEqual(getClipboardFiles(null), []);
	assert.deepEqual(getClipboardFiles({ files: [], items: [{ kind: "string" }] }), []);
});

test("queued files preview immediately and retain selection order when uploads finish out of order", async () => {
	const requests = [deferred(), deferred()];
	let index = 0;
	const scope = effectScope();
	const queue = scope.run(() => useAttachmentQueue(() => requests[index++].promise));
	const first = file();
	const second = file("second.png");
	const uploading = queue.uploadAttachment([first, second]);
	assert.equal(queue.attachmentsReady.value, false);
	assert.equal(queue.pendingAttachments.value.length, 2);
	assert.match(queue.pendingAttachments.value[0].previewUrl, /^blob:/);
	requests[1].resolve(uploaded(second));
	await Promise.resolve();
	assert.equal(queue.pendingAttachments.value[1].status, "ready");
	assert.equal(queue.pendingAttachments.value[0].status, "uploading");
	requests[0].resolve(uploaded(first));
	await uploading;
	assert.equal(queue.attachmentsReady.value, true);
	assert.deepEqual(queue.pendingAttachments.value.map((entry) => entry.attachment.name), [first.name, second.name]);
	await queue.uploadAttachment([]);
	assert.equal(index, 2);
	scope.stop();
});

test("failed uploads can be retried individually without losing other files", async () => {
	let failed = true;
	const scope = effectScope();
	const queue = scope.run(() => useAttachmentQueue(async (input) => {
		if (failed && input.name === "bad.png") throw new Error("Upload failed");
		return uploaded(input);
	}));
	await queue.uploadAttachment([file(), file("bad.png")]);
	const bad = queue.pendingAttachments.value[1];
	assert.equal(bad.status, "failed");
	assert.equal(bad.error, "Upload failed");
	assert.equal(queue.attachmentsReady.value, false);
	failed = false;
	await queue.retryAttachment(bad.id);
	assert.equal(bad.status, "ready");
	assert.equal(bad.error, "");
	assert.equal(queue.pendingAttachments.value.length, 2);
	assert.equal(queue.attachmentsReady.value, true);
	scope.stop();
});

test("removed uploads never reappear and their local preview is released", async () => {
	const request = deferred();
	const scope = effectScope();
	const queue = scope.run(() => useAttachmentQueue(() => request.promise));
	const uploading = queue.uploadAttachment(file());
	const entry = queue.pendingAttachments.value[0];
	assert.equal((await fetch(entry.previewUrl)).status, 200);
	queue.clearAttachment(entry.id);
	await assert.rejects(fetch(entry.previewUrl));
	request.resolve(uploaded(file()));
	await uploading;
	assert.deepEqual(queue.pendingAttachments.value, []);
	scope.stop();
});

test("a batch sends text and mentions only with the first file, preserving replies", async () => {
	const h = createRoom(async (input) => uploaded(input));
	await h.room.uploadAttachment([file(), file("second.png")]);
	await h.room.uploadAttachment(file("third.png"));
	h.room.composerText.value = "caption @alice";
	assert.equal(await h.room.sendMessage([8], 9), true);
	assert.deepEqual(h.frames.map((frame) => frame.content), ["caption @alice", "", ""]);
	assert.deepEqual(h.frames.map((frame) => frame.attachment.name), ["image.png", "second.png", "third.png"]);
	assert.deepEqual(h.frames.map((frame) => frame.mentionUserIds), [[8], [], []]);
	assert.ok(h.frames.every((frame) => frame.replyMessageId === 9));
	assert.equal(h.room.composerText.value, "");
	assert.deepEqual(h.room.pendingAttachments.value, []);
	h.scope.stop();
});

test("files send without text, but not before all uploads are ready", async () => {
	const request = deferred();
	const h = createRoom(() => request.promise);
	const uploading = h.room.uploadAttachment(file());
	assert.equal(await h.room.sendMessage(), false);
	assert.equal(h.frames.length, 0);
	request.resolve(uploaded(file()));
	await uploading;
	assert.equal(await h.room.sendMessage(), true);
	assert.equal(h.frames[0].content, "");
	h.scope.stop();
});

test("a partially failed send moves unsent files into retryable rows without duplicating the caption", async () => {
	const h = createRoom(async (input) => uploaded(input));
	await h.room.uploadAttachment([file(), file("second.png")]);
	h.room.composerText.value = "caption";
	h.socket.send = (frame) => {
		if (h.frames.length) throw new Error("Disconnected");
		h.frames.push(JSON.parse(frame));
	};
	assert.equal(await h.room.sendMessage(), true);
	assert.equal(h.room.pendingAttachments.value.length, 0);
	assert.equal(h.room.composerText.value, "");
	const failed = h.room.messages.value.find(message => message.sendStatus === "failed");
	assert.equal(failed.attachment.name, "second.png");
	h.socket.send = (frame) => h.frames.push(JSON.parse(frame));
	h.room.retryMessage(failed.clientMessageId);
	assert.deepEqual(h.frames.map((frame) => frame.content), ["caption", ""]);
	assert.equal(h.frames[1].clientMessageId, failed.clientMessageId);
	h.scope.stop();
});

test("switching rooms clears pending files and ignores late upload completion", async () => {
	const request = deferred();
	const h = createRoom(() => request.promise);
	const uploading = h.room.uploadAttachment(file());
	h.activeRoom.value = { id: 2, kind: "public" };
	assert.deepEqual(h.room.pendingAttachments.value, []);
	request.resolve(uploaded(file()));
	await uploading;
	assert.deepEqual(h.room.pendingAttachments.value, []);
	h.scope.stop();
});

test("plain and rich composers route native paste events to the attachment queue", () => {
	const composer = readFileSync(new URL("../frontend/src/components/chat/MessageComposer.vue", import.meta.url), "utf8");
	const rich = readFileSync(new URL("../frontend/src/components/chat/VditorComposerEditor.vue", import.meta.url), "utf8");
	assert.match(composer, /@paste="handlePaste"/);
	assert.match(composer, /if \(!files\.length\) return;/);
	assert.match(composer, /setRangeText\(text, input\.selectionStart, input\.selectionEnd, "end"\)/);
	assert.match(composer, /@upload="emit\('upload', \$event\)"/);
	assert.match(rich, /getClipboardFiles\(data\)/);
	assert.match(rich, /if \(files\.length\) emit\("upload", files\)/);
	assert.match(rich, /if \(props\.disabled\) return;/);
});

test("video and PDF preview classification uses renderable MIME types", () => {
	assert.equal(isVideoAttachment({ type: "video/mp4" }), true);
	assert.equal(isPdfAttachment({ type: "application/pdf; charset=binary" }), true);
	assert.equal(isVideoAttachment({ type: "application/octet-stream", name: "fake.mp4" }), false);
	assert.equal(isPdfAttachment({ type: "text/html", name: "fake.pdf" }), false);
	assert.equal(isPdfAttachment(null), false);
});
