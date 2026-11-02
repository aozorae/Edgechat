import { getMessageByClientId, insertMessage, insertMessageIdempotent } from "./data/messages.js";
import { resolveMessageMentionUserIds } from "./data/mentions.js";
import { resolveMessageReply } from "./data/replies.js";
import { getDirectMessageBlockStatus } from "./data/user-blocks.ts";

export class MessageSubmissionError extends Error {
	constructor(message, code = "invalid_request", status = 400) {
		super(message);
		this.name = "MessageSubmissionError";
		this.code = code;
		this.status = status;
	}
}

export function createMessageSubmission({
	persistMessage = insertMessage,
	resolveMentions = resolveMessageMentionUserIds,
	resolveReply = resolveMessageReply,
	resolveDmBlockStatus = getDirectMessageBlockStatus,
	findMessage = null,
} = {}) {
	return async function submitRoomMessage(env, meta, payload) {
		try {
			// 拉黑门禁与幂等读取互不依赖；仍先判定门禁，不能用重试确认绕过拉黑。
			const [blockStatus, existingMessage] = await Promise.all([
				meta.room.kind === "dm"
					? resolveDmBlockStatus(env.DB, Number(meta.room.id), Number(meta.principal.userId))
					: null,
				findMessage && payload.clientMessageId
					? findMessage(env, meta.room.id, meta.principal.userId, payload.clientMessageId)
					: null,
			]);
			if (meta.room.kind === "dm") {
				if (blockStatus.blockedByPeer) {
					throw new MessageSubmissionError(
						"发送被拒，你已经被拉黑",
						"blocked_by_recipient",
						403,
					);
				}
				if (blockStatus.blockedBySender) {
					throw new MessageSubmissionError(
						"请先解除拉黑再发送",
						"recipient_blocked",
						403,
					);
				}
			}
			// 确认丢失后的重试必须先返回原消息；回复目标可能已经被删除，不能再次校验旧内容。
			if (existingMessage) {
				return {
					message: existingMessage, created: false,
					packet: JSON.stringify({ protocolVersion: 1, type: "message", message: existingMessage }),
				};
			}
			const [mentionUserIds, reply] = await Promise.all([
				resolveMentions(env.DB, {
					channelId: meta.room.id,
					roomKind: meta.room.kind,
					senderId: meta.principal.userId,
					content: payload.content,
					candidateUserIds: payload.mentionUserIds,
				}),
				resolveReply(env.DB, {
					channelId: meta.room.id,
					replyMessageId: payload.replyMessageId,
				}),
			]);
			const persistencePayload = {
				channelId: meta.room.id,
				senderId: meta.principal.userId,
				content: payload.content,
				attachment: payload.attachment,
				mentionUserIds,
			};
			if (reply.messageId) {
				persistencePayload.replyToMessageId = reply.messageId;
				persistencePayload.replyToSenderId = reply.senderId;
			}
			if (payload.clientMessageId) {
				persistencePayload.clientMessageId = payload.clientMessageId;
			}
			const persisted = await persistMessage(env, persistencePayload);
			const message = persisted?.message || persisted;
			const created = persisted?.message ? persisted.created !== false : true;
			return {
				message,
				created,
				replyToSenderId: reply.senderId,
				packet: JSON.stringify({ protocolVersion: 1, type: "message", message }),
			};
		} catch (error) {
			if (
				error?.message === "Invalid attachment" ||
				error?.message === "Attachment is not available"
			) {
				throw new MessageSubmissionError(
					"附件不存在、无权使用或正在清理，请重新上传",
					"attachment_unavailable",
			);
			}
			if (error?.message === "Message content cannot be empty") {
				throw new MessageSubmissionError("消息内容不能为空");
			}
			if (error?.message === "Message idempotency key was already consumed") {
				throw new MessageSubmissionError(
					"该消息已删除，不能使用相同的 clientMessageId 再次发送",
					"client_message_id_consumed",
					409,
				);
			}
			if (error?.message === "Reply message is not available") {
				throw new MessageSubmissionError(
					"回复的消息不存在或已删除",
					"reply_message_unavailable",
				);
			}
			throw error;
		}
	};
}

export const submitRoomMessage = createMessageSubmission();
export const submitRoomMessageIdempotent = createMessageSubmission({
	persistMessage: insertMessageIdempotent,
	findMessage: getMessageByClientId,
});
