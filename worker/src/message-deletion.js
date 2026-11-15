import { cleanupR2Keys } from "./gc.js";
import { getMessageDeletionTarget, softDeleteMessage } from "./data/messages.js";
import { authorizeMessageModeration } from "./room-access.js";
import { hasFileStorage } from "./storage/index.ts";

export class MessageDeletionError extends Error {
	constructor(message) {
		super(message);
		this.name = "MessageDeletionError";
	}
}

export function createMessageDeletion({
	authorize = authorizeMessageModeration,
	persistDeletion = softDeleteMessage,
	getDeletionTarget = getMessageDeletionTarget,
	cleanupAttachments = cleanupR2Keys,
} = {}) {
	return async function deleteRoomMessage(env, meta, payload) {
		const messageId = Number(payload.messageId);
		if (!Number.isInteger(messageId) || messageId <= 0) {
			throw new MessageDeletionError("消息不存在");
		}

		const access = await authorize(
			env.DB,
			meta.principal,
			meta.room.kind,
			meta.room.id,
		);
		if (!access.ok) {
			throw new MessageDeletionError("无权删除该消息");
		}

		let attachmentKey = null;
		if (hasFileStorage(env)) {
			const target = await getDeletionTarget(env.DB, messageId);
			attachmentKey = target?.attachment_key || null;
		}

		const deleted = await persistDeletion(env.DB, {
			channelId: meta.room.id,
			messageId,
		});
		if (!deleted) {
			throw new MessageDeletionError("消息不存在或已被删除");
		}

		const cleanupPromise = attachmentKey
			? Promise.resolve().then(() => cleanupAttachments(env, [attachmentKey])).catch((error) => {
					console.warn("Failed to clean up deleted message attachment", error);
				})
			: null;

		return {
			messageId,
			packet: JSON.stringify({ protocolVersion: 1, type: "message_deleted", messageId }),
			cleanupPromise,
		};
	};
}

export const deleteRoomMessage = createMessageDeletion();
