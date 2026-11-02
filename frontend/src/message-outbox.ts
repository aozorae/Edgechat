import { shallowRef } from "vue";
import type { MessageSender, MessageView } from "./components/chat/message-view.ts";

type SendFrame = {
	type: "send";
	clientMessageId: string;
	content: string;
	attachment: MessageView["attachment"];
	mentionUserIds: number[];
	replyMessageId: number | null;
};
type OutboxEntry = { roomKey: string; frame: SendFrame; message: MessageView };

export const MESSAGE_ACK_TIMEOUT_MS = 15000;

// 只保留当前页面的发件箱；独立于历史快照，避免刷新和房间缓存淘汰丢失重试内容。
export function createMessageOutbox() {
	const entries = shallowRef<OutboxEntry[]>([]);
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	function stopTimer(id: string) {
		clearTimeout(timers.get(id));
		timers.delete(id);
	}

	function update(id: string, status: "pending" | "failed", sendError = "") {
		entries.value = entries.value.map(entry => entry.frame.clientMessageId === id
			? { ...entry, message: { ...entry.message, sendStatus: status, sendError } } : entry);
	}

	function fail(id: string, reason = "") {
		stopTimer(id);
		update(id, "failed", reason);
	}

	function start(id: string) {
		stopTimer(id);
		update(id, "pending");
		timers.set(id, setTimeout(() => fail(id), MESSAGE_ACK_TIMEOUT_MS));
	}

	function add(roomKey: string, frame: SendFrame, sender: MessageSender, reply?: MessageView) {
		const entry: OutboxEntry = {
			roomKey, frame,
			message: {
				id: `local:${frame.clientMessageId}`,
				clientMessageId: frame.clientMessageId,
				sender, content: frame.content, attachment: frame.attachment,
				createdAt: new Date().toISOString(), sendStatus: "pending",
				replyToMessageId: frame.replyMessageId,
				replyTo: reply ? { id: reply.id, sender: reply.sender, content: reply.content, attachment: reply.attachment } : null,
			},
		};
		entries.value = [...entries.value, entry];
		return entry;
	}

	function confirm(roomKey: string, messages: MessageView[]) {
		// 幂等键仅在房间和发送者内唯一，不能用其他用户的同名键确认本人的消息。
		entries.value = entries.value.filter(entry => {
			const confirmed = entry.roomKey === roomKey && messages.some(message =>
				message.clientMessageId === entry.frame.clientMessageId && message.sender?.kind !== "external"
				&& Number(message.sender?.id) === Number(entry.message.sender.id));
			if (confirmed) stopTimer(entry.frame.clientMessageId);
			return !confirmed;
		});
	}

	function clear(roomKey?: string) {
		for (const entry of entries.value) {
			if (!roomKey || entry.roomKey === roomKey) stopTimer(entry.frame.clientMessageId);
		}
		entries.value = roomKey ? entries.value.filter(entry => entry.roomKey !== roomKey) : [];
	}

	return { entries, add, start, fail, confirm, clear };
}
