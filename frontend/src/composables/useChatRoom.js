import { computed, getCurrentScope, nextTick, onScopeDispose, ref, watch } from "vue";
import api from "../api.js";
import { addAuthInvalidListener, dispatchAuthInvalid } from "../auth-storage.js";
import { createRealtimeSession } from "../realtime-session.js";
import { connectRoomSocket } from "../ws.js";
import { t } from "../i18n.js";
import { localizeErrorMessage } from "../localized-error.js";
import { useAttachmentQueue } from "./useAttachmentQueue.js";
import { createRoomSnapshotCache } from "../room-snapshot-cache.js";
import { createMessageOutbox } from "../message-outbox.ts";

const WS_CLOSE_UNAUTHORIZED = 4401;
const WS_CLOSE_FORBIDDEN = 4403;
const WS_REASON_UNAUTHORIZED = "session_invalid";
const WS_REASON_FORBIDDEN = "room_forbidden";

export function useChatRoom({
	activeRoom,
	session,
	error,
	roomVisible = { value: true },
	onRoomActivity = () => {},
	onRoomAccessRevoked = () => {},
	roomApi = api,
	openRoomConnection = connectRoomSocket,
}) {
	const messages = ref([]);
	const outbox = createMessageOutbox();
	const visibleMessages = computed(() => [...messages.value,
		...outbox.entries.value.filter(entry => entry.roomKey === roomKey()).map(entry => entry.message)]);
	const pinnedMessage = ref(null);
	const highlightedMessageId = ref(null);
	const loading = ref(false);
	const refreshing = ref(false);
	const refreshFailed = ref(false);
	const wsStatus = ref("closed");
	const composerText = ref("");
	const {
		pendingAttachments, attachmentsReady, uploadAttachment, retryAttachment,
		clearAttachment, clearAttachments, addReadyAttachment,
	} = useAttachmentQueue((file) => roomApi.uploadFile(file));
	const sending = ref(false);
	const messagesEl = ref(null);
	let messageLoadGeneration = 0;
	let highlightTimer = null;
	const snapshots = createRoomSnapshotCache();
	const historyReads = new Set();
	let displayedRoomKey = "";
	let snapshotReady = false;
	let sessionGeneration = 0;
	let disposed = false;

	function invalidateReads() {
		messageLoadGeneration += 1;
		historyReads.clear();
		loading.value = false;
		refreshing.value = false;
		refreshFailed.value = false;
	}

	function clearRoomState() {
		invalidateReads();
		messages.value = [];
		pinnedMessage.value = null;
		snapshotReady = false;
		displayedRoomKey = "";
		clearMessageHighlight();
	}

	function clearSessionState() {
		sessionGeneration += 1;
		snapshots.clear();
		outbox.clear();
		clearRoomState();
		clearAttachments();
		composerText.value = "";
		disconnectSocket();
	}

	const stopSessionWatch = watch(
		[() => session.value?.userId, () => session.value?.token],
		clearSessionState,
		{ flush: "sync" },
	);
	const removeAuthInvalidListener = addAuthInvalidListener(clearSessionState);

	function saveSnapshot() {
		if (displayedRoomKey && snapshotReady) {
			snapshots.set(displayedRoomKey, { messages: messages.value, pinnedMessage: pinnedMessage.value });
		}
	}

	function roomKey(room = activeRoom.value) {
		return room?.kind && room?.id ? `${room.kind}:${room.id}` : "";
	}

	function isOwnMessage(message) {
		return (
			message.sender.kind !== "external" &&
			Number(message.sender.id) === Number(session.value?.userId)
		);
	}

	function scrollToBottom() {
		const element = messagesEl.value;
		if (element) {
			requestAnimationFrame(() => {
				element.scrollTop = element.scrollHeight;
			});
		}
	}

	function mergeMessages(...collections) {
		const byId = new Map();
		for (const collection of collections) {
			for (const message of collection || []) {
				byId.set(Number(message.id), message);
			}
		}
		return [...byId.values()].sort((left, right) => Number(left.id) - Number(right.id));
	}

	function highlightMessage(messageId) {
		const numericMessageId = Number(messageId);
		const element = messagesEl.value?.querySelector(
			`[data-message-id="${numericMessageId}"]`,
		);
		if (!element) {
			return false;
		}
		element.scrollIntoView({ behavior: "smooth", block: "center" });
		highlightedMessageId.value = numericMessageId;
		if (highlightTimer !== null) {
			globalThis.clearTimeout(highlightTimer);
		}
		highlightTimer = globalThis.setTimeout(() => {
			highlightedMessageId.value = null;
			highlightTimer = null;
		}, 1400);
		return true;
	}

	function clearMessageHighlight() {
		highlightedMessageId.value = null;
		if (highlightTimer !== null) {
			globalThis.clearTimeout(highlightTimer);
			highlightTimer = null;
		}
	}

	function applyActiveRoomActivity(message) {
		if (!activeRoom.value || !message || !roomVisible.value) {
			return;
		}

		onRoomActivity({ room: activeRoom.value, message });

		if (!isOwnMessage(message)) {
			void roomApi
				.markRoomRead(activeRoom.value.kind, activeRoom.value.id, message.id)
				.catch(() => {});
		}
	}

	function handleRoomAccessRevoked(key = roomKey()) {
		snapshots.delete(key);
		outbox.clear(key);
		if (displayedRoomKey === key) {
			clearRoomState();
			disconnectSocket();
		}
		if (roomKey() === key && activeRoom.value) {
			onRoomAccessRevoked(activeRoom.value);
		}
	}

	function handleSocketClose(event) {
		for (const entry of outbox.entries.value) {
			if (entry.roomKey === event.key && entry.message.sendStatus === "pending") {
				outbox.fail(entry.frame.clientMessageId);
			}
		}
		const code = Number(event?.code || 0);
		const reason = String(event?.reason || "");
		if (code === WS_CLOSE_UNAUTHORIZED || reason === WS_REASON_UNAUTHORIZED) {
			clearSessionState();
			dispatchAuthInvalid(t('chat.sessionInvalid'));
			return;
		}
		if (code === WS_CLOSE_FORBIDDEN || reason === WS_REASON_FORBIDDEN) {
			handleRoomAccessRevoked(event.key);
		}
		if (code === 1008 && reason === "Unauthorized") {
			// ChannelRoom's legacy close does not distinguish a lost login from lost membership.
			snapshots.clear();
			handleRoomAccessRevoked(event.key);
		}
	}

	function applyMessageEvent(payload) {
		if (payload.type === "message" && payload.message) {
			outbox.confirm(roomKey(), [payload.message]);
			messages.value = mergeMessages(messages.value, [payload.message]);
		}
		if (payload.type === "message_deleted") {
			const messageId = Number(payload.messageId);
			messages.value = messages.value
				.filter((message) => Number(message.id) !== messageId)
				.map((message) => Number(message.replyToMessageId) === messageId
					? { ...message, replyTo: { id: messageId, deleted: true } }
					: message);
			if (Number(pinnedMessage.value?.id) === messageId) pinnedMessage.value = null;
		}
		if (payload.type === "message_pinned" && payload.message) {
			pinnedMessage.value = payload.message;
		}
		if (payload.type === "message_unpinned" &&
			Number(pinnedMessage.value?.id) === Number(payload.messageId)) {
			pinnedMessage.value = null;
		}
	}

	function applyHistory(payload, read, append) {
		outbox.confirm(roomKey(), payload.messages);
		// Replace cached history so edits/deletions made while away cannot survive a refresh.
		messages.value = append ? mergeMessages(payload.messages, messages.value) : payload.messages;
		pinnedMessage.value = payload.pinnedMessage || null;
		// HTTP may have captured its snapshot before these socket events arrived.
		for (const event of read.events) applyMessageEvent(event);
		snapshotReady = true;
	}

	function handleHistoryError(currentError, key, loginGeneration) {
		if (loginGeneration !== sessionGeneration) return;
		if (currentError.status === 401) {
			clearSessionState();
			dispatchAuthInvalid(currentError.message);
		} else if (currentError.status === 403 || currentError.status === 404) {
			handleRoomAccessRevoked(key);
		}
	}

	const roomSession = createRealtimeSession({
		openConnection(params, handlers) {
			return openRoomConnection({
				kind: params.kind,
				roomId: params.roomId,
				...handlers,
			});
		},
		onStatus(event) {
			wsStatus.value = event.status === "reconnecting" ? "connecting" : event.status;
		},
		onClose: handleSocketClose,
		onMessage(payload, connection) {
			if (connection?.key !== roomKey()) {
				return;
			}
			if (["message", "message_deleted", "message_pinned", "message_unpinned"].includes(payload.type)) {
				for (const read of historyReads) read.events.push(payload);
				applyMessageEvent(payload);
			}
			if (payload.type === "message" && payload.message) {
				applyActiveRoomActivity(payload.message);
				nextTick().then(scrollToBottom);
			}
			if (payload.type === "error") {
				error.value = localizeErrorMessage(payload.error);
				if (payload.clientMessageId) outbox.fail(payload.clientMessageId, error.value);
			}
		},
	});

	async function loadMessages(before = null, append = false) {
		const room = activeRoom.value;
		const key = roomKey(room);
		if (!key || disposed || !session.value?.userId) return false;

		const generation = ++messageLoadGeneration;
		const loginGeneration = sessionGeneration;
		const read = { events: [] };
		historyReads.add(read);
		loading.value = true;
		refreshing.value = !append && snapshotReady;
		refreshFailed.value = false;
		error.value = "";
		try {
			const payload = await roomApi.getMessages(room.kind, room.id, before);
			if (generation !== messageLoadGeneration || roomKey() !== key) return false;
			applyHistory(payload, read, append);
			await nextTick();
			if (generation !== messageLoadGeneration || roomKey() !== key) return false;
			if (!append) scrollToBottom();
			return true;
		} catch (currentError) {
			if (generation === messageLoadGeneration && roomKey() === key) {
				error.value = currentError.message;
				refreshFailed.value = !append && snapshotReady;
			}
			handleHistoryError(currentError, key, loginGeneration);
			return false;
		} finally {
			historyReads.delete(read);
			if (generation === messageLoadGeneration) {
				loading.value = false;
				refreshing.value = false;
			}
		}
	}

	async function activateRoom() {
		if (disposed || !session.value?.userId) return false;
		saveSnapshot();
		clearRoomState();
		displayedRoomKey = roomKey();
		const snapshot = snapshots.get(displayedRoomKey);
		if (snapshot) {
			messages.value = snapshot.messages;
			pinnedMessage.value = snapshot.pinnedMessage;
			snapshotReady = true;
		}
		// History and WS start independently, including on a cache hit.
		const pending = loadMessages();
		const generation = messageLoadGeneration;
		if (snapshot) void nextTick().then(() => {
			if (generation === messageLoadGeneration) scrollToBottom();
		});
		connectSocket();
		return pending;
	}

	function deactivateRoom() {
		// No active room also covers room deletion; never retain that room's snapshot.
		snapshots.delete(displayedRoomKey);
		outbox.clear(displayedRoomKey);
		clearRoomState();
		disconnectSocket();
	}

	function pauseRoom() {
		saveSnapshot();
		invalidateReads();
		disconnectSocket();
	}

	function connectSocket() {
		if (!activeRoom.value || disposed || !session.value?.userId) {
			return;
		}
		const key = roomKey();
		roomSession.connect(key, {
			kind: activeRoom.value.kind,
			roomId: activeRoom.value.id,
		});
	}

	function disconnectSocket() {
		roomSession.disconnect();
	}

	function transmit(entry) {
		const id = entry.frame.clientMessageId;
		outbox.start(id);
		try {
			if (!roomSession.send(JSON.stringify(entry.frame), entry.roomKey)) {
				throw new Error(t('chat.realtimeNotReady'));
			}
		} catch (currentError) {
			outbox.fail(id, currentError.message);
		}
	}

	function queueMessage(key, payload) {
		const frame = { type: "send", clientMessageId: crypto.randomUUID(), ...payload };
		const sender = { id: session.value.userId, kind: "local", displayName: session.value.displayName,
			avatarUrl: session.value.avatarUrl };
		const reply = messages.value.find(message => Number(message.id) === frame.replyMessageId);
		const entry = outbox.add(key, frame, sender, reply);
		transmit(entry);
		nextTick().then(scrollToBottom);
	}

	function retryMessage(clientMessageId) {
		const entry = outbox.entries.value.find(item => item.roomKey === roomKey()
			&& item.frame.clientMessageId === clientMessageId && item.message.sendStatus === "failed");
		if (!entry) return;
		error.value = "";
		transmit(entry);
	}

	async function sendMessage(mentionUserIds = [], replyMessageId = null) {
		const key = roomKey();
		if (!roomSession.isOpenFor(key)) {
			error.value = t('chat.realtimeNotReady');
			return false;
		}
		if (sending.value || !attachmentsReady.value ||
			(!composerText.value.trim() && !pendingAttachments.value.length)) {
			return false;
		}

		sending.value = true;
		error.value = "";
		try {
			const entries = pendingAttachments.value.length ? [...pendingAttachments.value] : [null];
			for (const [index, entry] of entries.entries()) {
				queueMessage(key, {
					content: index === 0 ? composerText.value : "",
					attachment: entry?.attachment || null,
					mentionUserIds: index === 0 ? mentionUserIds : [],
					replyMessageId: replyMessageId ? Number(replyMessageId) : null,
				});
				composerText.value = "";
				if (entry) clearAttachment(entry.id);
			}
			return true;
		} catch (currentError) {
			error.value = currentError.message;
			return false;
		} finally {
			sending.value = false;
		}
	}

	async function sendVoiceMessage(recording, replyMessageId = null) {
		if (sending.value) return false;
		const key = roomKey();
		const loginGeneration = sessionGeneration;
		if (!roomSession.isOpenFor(key)) {
			error.value = t('chat.realtimeNotReady');
			return false;
		}
		sending.value = true;
		error.value = "";
		let attachment = null;
		try {
			const payload = await roomApi.uploadFile(recording.file);
			if (roomKey() !== key || loginGeneration !== sessionGeneration || disposed) return false;
			attachment = {
				...payload.file,
				kind: "voice",
				durationMs: recording.durationMs,
				waveform: recording.waveform,
			};
			queueMessage(key, {
				content: "",
				attachment,
				mentionUserIds: [],
				replyMessageId: replyMessageId ? Number(replyMessageId) : null,
			});
			return true;
		} catch (currentError) {
			if (roomKey() === key && loginGeneration === sessionGeneration) {
				if (attachment) addReadyAttachment(attachment);
				error.value = currentError.message;
			}
			return false;
		} finally {
			sending.value = false;
		}
	}

	function deleteMessage(messageId) {
		const key = activeRoom.value
			? `${activeRoom.value.kind}:${activeRoom.value.id}`
			: "";
		if (!roomSession.isOpenFor(key)) {
			error.value = t('chat.realtimeNotReady');
			return false;
		}

		error.value = "";
		return roomSession.send(
			JSON.stringify({ type: "delete_message", messageId: Number(messageId) }),
			key,
		);
	}

	function pinMessage(messageId) {
		const key = roomKey();
		if (!roomSession.isOpenFor(key)) {
			error.value = t('chat.realtimeNotReady');
			return false;
		}
		error.value = "";
		return roomSession.send(
			JSON.stringify({ type: "pin_message", messageId: Number(messageId) }),
			key,
		);
	}

	function unpinMessage(messageId) {
		const key = roomKey();
		if (!roomSession.isOpenFor(key)) {
			error.value = t('chat.realtimeNotReady');
			return false;
		}
		error.value = "";
		return roomSession.send(
			JSON.stringify({ type: "unpin_message", messageId: Number(messageId) }),
			key,
		);
	}

	async function revealMessage(messageId) {
		const targetId = Number(messageId);
		const key = roomKey();
		const generation = messageLoadGeneration;
		const loginGeneration = sessionGeneration;
		if (!targetId || !key || disposed || !session.value?.userId) {
			return false;
		}
		await nextTick();
		if (generation !== messageLoadGeneration || roomKey() !== key) return false;
		if (highlightMessage(targetId)) {
			return true;
		}

		const read = { events: [] };
		historyReads.add(read);
		try {
			const room = activeRoom.value;
			const payload = await roomApi.getMessages(room.kind, room.id, targetId + 1);
			if (generation !== messageLoadGeneration || roomKey() !== key) {
				return false;
			}
			applyHistory(payload, read, true);
			await nextTick();
			if (generation !== messageLoadGeneration || roomKey() !== key) return false;
			return highlightMessage(targetId);
		} catch (currentError) {
			if (generation === messageLoadGeneration && roomKey() === key) error.value = currentError.message;
			handleHistoryError(currentError, key, loginGeneration);
			return false;
		} finally {
			historyReads.delete(read);
		}
	}

	function revealPinnedMessage() {
		return revealMessage(pinnedMessage.value?.id);
	}

	const stopAttachmentWatch = watch(() => roomKey(), clearAttachments, { flush: "sync" });

	async function loadOlder() {
		if (loading.value) {
			return;
		}
		const firstMessage = messages.value[0];
		if (firstMessage) {
			await loadMessages(firstMessage.id, true);
		}
	}

	const stopMessagesWatch = watch(
		messages,
		(current, previous) => {
			const receivedNewLastMessage =
				current.length > previous.length &&
				current.at(-1)?.id !== previous.at(-1)?.id;
			if (receivedNewLastMessage) {
				nextTick().then(scrollToBottom);
			}
		},
		{ flush: "post" },
	);

	function dispose() {
		disposed = true;
		stopSessionWatch();
		stopAttachmentWatch();
		stopMessagesWatch();
		removeAuthInvalidListener();
		clearSessionState();
	}
	if (getCurrentScope()) onScopeDispose(dispose);

	return {
		messages: visibleMessages,
		pinnedMessage,
		highlightedMessageId,
		loading,
		refreshing,
		refreshFailed,
		wsStatus,
		composerText,
		pendingAttachments,
		sending,
		messagesEl,
		isOwnMessage,
		loadMessages,
		activateRoom,
		deactivateRoom,
		pauseRoom,
		connectSocket,
		disconnectSocket,
		sendMessage,
		retryMessage,
		sendVoiceMessage,
		deleteMessage,
		pinMessage,
		unpinMessage,
		revealMessage,
		revealPinnedMessage,
		uploadAttachment,
		clearAttachment,
		retryAttachment,
		loadOlder,
	};
}
