import { decryptMessageContent, encryptMessageContent } from "../encryption.js";
import { isUserDisabled } from "../user-status.js";
import { pickAttachment, publicFileUrl } from "../utils.js";
import { normalizeMentionUserIds } from "./mentions.js";
import { fileBelongsToUser, isR2ObjectUnavailableError } from "./uploaded-files.js";

function toNullableNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function mapAttachment(row) {
	if (!row.attachment_key) return null;
	const attachment = {
		key: row.attachment_key,
		name: row.attachment_name,
		type: row.attachment_type,
		size: toNullableNumber(row.attachment_size) || 0,
		url: publicFileUrl(row.attachment_key),
	};
	if (row.attachment_kind === "voice" || row.attachment_kind === "audio") {
		attachment.kind = row.attachment_kind;
		attachment.durationMs = toNullableNumber(row.attachment_duration_ms) || 0;
		if (row.attachment_kind === "voice") {
			attachment.waveform = JSON.parse(row.attachment_waveform || "[]");
		}
	}
	return attachment;
}

function mapReplyAttachment(row) {
	if (!row.reply_attachment_key) return null;
	const attachment = {
		key: row.reply_attachment_key,
		name: row.reply_attachment_name,
		type: row.reply_attachment_type,
		size: toNullableNumber(row.reply_attachment_size) || 0,
		url: publicFileUrl(row.reply_attachment_key),
	};
	if (row.reply_attachment_kind === "voice" || row.reply_attachment_kind === "audio") {
		attachment.kind = row.reply_attachment_kind;
		attachment.durationMs = toNullableNumber(row.reply_attachment_duration_ms) || 0;
	}
	return attachment;
}

function mapReplySender(row) {
	const isExternal = row.reply_sender_kind === "external";
	const isTelegramExternal = isExternal && row.reply_source === "telegram";
	return {
		kind: isExternal ? "external" : "local",
		id: isExternal ? String(row.reply_external_sender_id || "") : Number(row.reply_sender_id),
		username: isExternal ? "" : row.reply_sender_username,
		displayName: isExternal ? row.reply_external_sender_name : row.reply_sender_display_name,
		avatarUrl: isExternal
			? isTelegramExternal
				? `/api/integrations/telegram/avatar/${row.reply_external_sender_id}`
				: row.reply_external_sender_avatar_url || ""
			: row.reply_sender_avatar_key
				? publicFileUrl(row.reply_sender_avatar_key)
				: "",
		source: isExternal ? row.reply_source : "edgechat",
	};
}

export function mapMessage(row, content = row.content, replyTo = null) {
	const isExternal = row.sender_kind === "external";
	const isTelegramExternal = isExternal && row.source === "telegram";
	const mentions = JSON.parse(row.mentions_json || "[]").map((mention) => ({
		userId: Number(mention.userId),
		username: mention.username,
		displayName: mention.displayName,
	}));
	const sender = {
		kind: isExternal ? "external" : "local",
		id: isExternal ? String(row.external_sender_id || "") : Number(row.sender_id),
		username: isExternal ? "" : row.sender_username,
		displayName: isExternal ? row.external_sender_name : row.sender_display_name,
		avatarUrl: isExternal
			? isTelegramExternal
				? `/api/integrations/telegram/avatar/${row.external_sender_id}`
				: row.external_sender_avatar_url || ""
			: row.sender_avatar_key
				? publicFileUrl(row.sender_avatar_key)
				: "",
		source: isExternal ? row.source : "edgechat",
	};
	if (!isExternal) {
		sender.isAdmin = Boolean(Number(row.sender_is_admin));
		sender.isDisabled = isUserDisabled({
			is_disabled: row.sender_is_disabled,
			disabled_until: row.sender_disabled_until,
		});
	}
	const message = {
		id: Number(row.id),
		content,
		mentionUserIds: normalizeMentionUserIds(JSON.parse(row.mention_user_ids || "[]")),
		mentions,
		createdAt: row.created_at,
		source: row.source || "edgechat",
		sender,
		attachment: mapAttachment(row),
	};
	if (row.source_instance) {
		message.sourceInstance = row.source_instance;
		message.sender.sourceInstance = row.source_instance;
	}
	if (row.client_message_id) {
		message.clientMessageId = row.client_message_id;
	}
	if (row.reply_to_message_id) {
		message.replyToMessageId = Number(row.reply_to_message_id);
		message.replyTo = replyTo || {
			id: Number(row.reply_to_message_id),
			deleted: true,
		};
	}
	return message;
}

export async function externalSenderExists(db, source, senderId) {
	const { results } = await db
		.prepare(
			`SELECT 1 AS found
			 FROM messages
			 WHERE sender_kind = 'external'
			   AND source = ?
			   AND external_sender_id = ?
			   AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(String(source), String(senderId))
		.all();
	return Boolean(results[0]);
}

async function mapDecryptedMessage(env, row) {
	const content = await decryptMessageContent(env, row.content, {
		channelId: row.channel_id,
		senderId: row.sender_id ?? 0,
		senderContext:
			row.sender_kind === "external" ? `${row.source}:${row.external_sender_id}` : "",
	});
	let replyTo = null;
	if (row.reply_to_message_id) {
		const replyId = Number(row.reply_to_message_id);
		if (!row.reply_message_id || row.reply_deleted_at) {
			replyTo = { id: replyId, deleted: true };
		} else {
			const replyContent = await decryptMessageContent(env, row.reply_content, {
				channelId: row.channel_id,
				senderId: row.reply_sender_id ?? 0,
				senderContext:
					row.reply_sender_kind === "external"
						? `${row.reply_source}:${row.reply_external_sender_id}`
						: "",
			});
			replyTo = {
				id: replyId,
				deleted: false,
				content: replyContent,
				sender: mapReplySender(row),
				attachment: mapReplyAttachment(row),
			};
		}
	}
	return mapMessage(row, content, replyTo);
}

const MESSAGE_SELECT = `SELECT
			  m.id, m.channel_id, m.content, m.attachment_key, m.attachment_name, m.attachment_type, m.source_instance,
		  m.attachment_size, m.attachment_kind, m.attachment_duration_ms, m.attachment_waveform,
		  m.sender_kind, m.external_sender_id, m.external_sender_name,
		  m.external_sender_avatar_url, m.source, m.source_message_id,
		  m.source_attachment_id, m.source_attachment_unique_id, m.client_message_id,
			  m.mention_user_ids, m.reply_to_message_id, m.reply_to_sender_id, m.created_at,
		  u.id AS sender_id, u.username AS sender_username,
		  u.display_name AS sender_display_name, u.avatar_key AS sender_avatar_key,
		  u.is_super_admin AS sender_is_admin, u.is_disabled AS sender_is_disabled,
		  u.disabled_until AS sender_disabled_until,
		  reply.id AS reply_message_id, reply.content AS reply_content,
		  reply.deleted_at AS reply_deleted_at,
		  reply.attachment_key AS reply_attachment_key,
		  reply.attachment_name AS reply_attachment_name,
		  reply.attachment_type AS reply_attachment_type,
		  reply.attachment_size AS reply_attachment_size,
		  reply.attachment_kind AS reply_attachment_kind,
		  reply.attachment_duration_ms AS reply_attachment_duration_ms,
		  reply.sender_kind AS reply_sender_kind,
		  reply.external_sender_id AS reply_external_sender_id,
		  reply.external_sender_name AS reply_external_sender_name,
		  reply.external_sender_avatar_url AS reply_external_sender_avatar_url,
		  reply.source AS reply_source,
		  reply_user.id AS reply_sender_id,
		  reply_user.username AS reply_sender_username,
		  reply_user.display_name AS reply_sender_display_name,
		  reply_user.avatar_key AS reply_sender_avatar_key,
	  COALESCE((
	    SELECT json_group_array(json_object(
	      'userId', mentioned.id,
	      'username', mentioned.username,
	      'displayName', mentioned.display_name
	    ))
	    FROM json_each(COALESCE(m.mention_user_ids, '[]')) mention_ids
	    JOIN users mentioned ON mentioned.id = CAST(mention_ids.value AS INTEGER)
		 ), '[]') AS mentions_json
	 FROM messages m
	 LEFT JOIN users u ON u.id = m.sender_id
	 LEFT JOIN messages reply ON reply.id = m.reply_to_message_id
	 LEFT JOIN users reply_user ON reply_user.id = reply.sender_id`;

export async function getMessageDeletionTarget(db, messageId) {
	const { results } = await db
		.prepare(
			`SELECT m.id, m.channel_id, m.sender_id, m.attachment_key,
			        c.kind AS channel_kind
			 FROM messages m
			 JOIN channels c ON c.id = m.channel_id
			 WHERE m.id = ?
			   AND m.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(Number(messageId))
		.all();
	return results[0] || null;
}

export async function listMessages(env, roomId, before = null, limit = 30) {
	const filters = ["m.channel_id = ?", "m.deleted_at IS NULL"];
	const binds = [Number(roomId)];
	if (before) {
		filters.push("m.id < ?");
		binds.push(Number(before));
	}
	const { results } = await env.DB
		.prepare(`${MESSAGE_SELECT} WHERE ${filters.join(" AND ")} ORDER BY m.id DESC LIMIT ?`)
		.bind(...binds, Number(limit))
		.all();
	return (await Promise.all(results.map((row) => mapDecryptedMessage(env, row)))).reverse();
}

export async function getMessageById(env, messageId) {
	const { results } = await env.DB
		.prepare(`${MESSAGE_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL LIMIT 1`)
		.bind(Number(messageId))
		.all();
	return results[0] ? mapDecryptedMessage(env, results[0]) : null;
}

export async function getPinnedMessage(env, channelId) {
	// 直接投影置顶消息，避免先读取 ID 再发起第二次数据库往返。
	const { results } = await env.DB
		.prepare(`${MESSAGE_SELECT}
		 WHERE m.id = (SELECT message_id FROM channel_pins WHERE channel_id = ?)
		   AND m.channel_id = ? AND m.deleted_at IS NULL LIMIT 1`)
		.bind(Number(channelId), Number(channelId))
		.all();
	return results[0] ? mapDecryptedMessage(env, results[0]) : null;
}

export async function getMessageBySource(env, source, sourceMessageId) {
	const { results } = await env.DB
		.prepare(
			`${MESSAGE_SELECT}
			 WHERE m.source = ? AND m.source_message_id = ?
			 LIMIT 1`,
		)
		.bind(String(source), String(sourceMessageId))
		.all();
	return results[0] ? mapDecryptedMessage(env, results[0]) : null;
}

function messageByClientIdStatement(db, channelId, senderId, clientMessageId) {
	return db
		.prepare(
			`${MESSAGE_SELECT}
			 WHERE m.channel_id = ?
			   AND m.sender_id = ?
			   AND m.client_message_id = ?
			   AND m.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(Number(channelId), Number(senderId), String(clientMessageId));
}

export async function getMessageByClientId(env, channelId, senderId, clientMessageId) {
	const { results } = await messageByClientIdStatement(env.DB, channelId, senderId, clientMessageId).all();
	return results[0] ? mapDecryptedMessage(env, results[0]) : null;
}

async function hasConsumedClientMessageId(db, channelId, senderId, clientMessageId) {
	const { results } = await db
		.prepare(
			`SELECT id
			 FROM messages
			 WHERE channel_id = ? AND sender_id = ? AND client_message_id = ?
			 LIMIT 1`,
		)
		.bind(Number(channelId), Number(senderId), String(clientMessageId))
		.all();
	return Boolean(results[0]);
}

export async function getRoomSyncCursor(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT MAX(sequence) AS sequence
			 FROM (
			   SELECT COALESCE(MAX(sequence), 0) AS sequence
			   FROM message_events
			   WHERE channel_id = ?
			   UNION ALL
			   SELECT COALESCE(MAX(compacted_through), 0) AS sequence
			   FROM message_event_compaction
			   WHERE channel_id = ?
			 )`,
		)
		.bind(Number(channelId), Number(channelId))
		.all();
	return Number(results[0]?.sequence || 0);
}

export async function getRoomCompactedCursor(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT compacted_through
			 FROM message_event_compaction
			 WHERE channel_id = ?
			 LIMIT 1`,
		)
		.bind(Number(channelId))
		.all();
	return Number(results[0]?.compacted_through || 0);
}

export async function listRoomMessageEvents(env, channelId, afterSequence = 0, limit = 100) {
	const normalizedCursor = Number(afterSequence) || 0;
	const compactedThrough = await getRoomCompactedCursor(env.DB, channelId);
	if (normalizedCursor < compactedThrough) {
		const error = new Error("Room sync cursor expired");
		error.name = "RoomSyncCursorExpiredError";
		error.code = "sync_cursor_expired";
		error.status = 409;
		throw error;
	}
	const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 100);
	const { results } = await env.DB
		.prepare(
			`SELECT sequence, message_id, event_type, created_at
			 FROM message_events
			 WHERE channel_id = ? AND sequence > ?
			 ORDER BY sequence ASC
			 LIMIT ?`,
		)
		.bind(Number(channelId), normalizedCursor, pageSize + 1)
		.all();
	const page = results.slice(0, pageSize);
	const events = [];
	for (const row of page) {
		if (row.event_type === "deleted") {
			events.push({
				sequence: Number(row.sequence),
				type: "message_deleted",
				messageId: Number(row.message_id),
				createdAt: row.created_at,
			});
			continue;
		}
		const message = await getMessageById(env, row.message_id);
		if (message) {
			events.push({
				sequence: Number(row.sequence),
				type: "message",
				message,
				createdAt: row.created_at,
			});
		}
	}
	return {
		events,
		nextCursor: page.length
			? Number(page[page.length - 1].sequence)
				: normalizedCursor,
		hasMore: results.length > pageSize,
	};
}

export async function softDeleteMessage(db, { channelId, messageId }) {
	const result = await db
		.prepare(
			`UPDATE messages
			 SET deleted_at = CURRENT_TIMESTAMP
			 WHERE id = ?
			   AND channel_id = ?
			   AND deleted_at IS NULL`,
		)
		.bind(Number(messageId), Number(channelId))
		.run();
	return Number(result.meta?.changes || 0) > 0;
}

async function persistMessage(env, {
	channelId,
	senderId = null,
	externalSender = null,
	content,
	attachment = null,
	source = "edgechat",
	sourceMessageId = null,
	sourceAttachmentId = null,
	sourceAttachmentUniqueId = null,
	clientMessageId = null,
	mentionUserIds = [],
	replyToMessageId = null,
	replyToSenderId = null,
	bridgeDelivery = null,
	sourceInstance = null,
}) {
	const isExternal = externalSender !== null;
	const normalizedSenderId = isExternal ? null : Number(senderId);
	const hasAttachment = attachment !== undefined && attachment !== null;
	// 外部附件只能从已验证的内部 Bridge 入口进入；本地客户端仍必须通过上传归属校验。
	const cleanAttachment = pickAttachment(
		attachment,
		isExternal ? {} : { ownerUserId: normalizedSenderId },
	);
	const cleanContent = String(content || "").trim();
	if (hasAttachment && !cleanAttachment) {
		throw new Error("Invalid attachment");
	}
	if (
		!isExternal &&
		cleanAttachment &&
		!(await fileBelongsToUser(env.DB, cleanAttachment.key, normalizedSenderId))
	) {
		throw new Error("Attachment is not available");
	}
	if (!cleanContent && !cleanAttachment) {
		throw new Error("Message content cannot be empty");
	}
	const externalId = isExternal ? String(externalSender.id || "").trim() : "";
	const externalName = isExternal ? String(externalSender.displayName || "").trim() : "";
	if (isExternal && (!externalId || !externalName || !sourceMessageId)) {
		throw new Error("External sender is incomplete");
	}

	const storedContent = await encryptMessageContent(env, cleanContent, {
		channelId,
		senderId: normalizedSenderId ?? 0,
		senderContext: isExternal ? `${source}:${externalId}` : "",
	});
	const normalizedClientMessageId = isExternal
		? null
		: String(clientMessageId || "").trim() || null;
	const storedMentionUserIds = JSON.stringify(
		isExternal ? [] : normalizeMentionUserIds(mentionUserIds),
	);
	const normalizedReplyToMessageId = replyToMessageId ? Number(replyToMessageId) : null;
	const normalizedReplyToSenderId = replyToSenderId ? Number(replyToSenderId) : null;
	try {
		const insert = env.DB
				.prepare(
					`INSERT INTO messages (
					   channel_id, sender_id, content, attachment_key, attachment_name,
					   attachment_type, attachment_size, attachment_kind, attachment_duration_ms,
					   attachment_waveform, sender_kind, external_sender_id,
						   external_sender_name, external_sender_avatar_url, source, source_message_id,
						   source_attachment_id, source_attachment_unique_id, client_message_id,
								   mention_user_ids, reply_to_message_id, reply_to_sender_id,
								   bridge_binding_id, bridge_event_id, bridge_sent_at, source_instance, bridge_target_revision
								 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
			.bind(
				Number(channelId),
				normalizedSenderId,
				storedContent,
				cleanAttachment?.key || null,
				cleanAttachment?.name || null,
					cleanAttachment?.type || null,
					cleanAttachment?.size || null,
					cleanAttachment?.kind || null,
					cleanAttachment?.kind === "voice" || cleanAttachment?.kind === "audio"
						? cleanAttachment.durationMs
						: null,
					cleanAttachment?.kind === "voice"
						? JSON.stringify(cleanAttachment.waveform)
						: null,
					isExternal ? "external" : "local",
					isExternal ? externalId : null,
					isExternal ? externalName : null,
					isExternal ? String(externalSender.avatarUrl || "") : null,
					String(source || "edgechat"),
					sourceMessageId ? String(sourceMessageId) : null,
					sourceAttachmentId ? String(sourceAttachmentId) : null,
						sourceAttachmentUniqueId ? String(sourceAttachmentUniqueId) : null,
							normalizedClientMessageId,
							storedMentionUserIds,
							normalizedReplyToMessageId,
								normalizedReplyToSenderId,
								bridgeDelivery?.bindingId || null,
								bridgeDelivery?.eventId || null,
								bridgeDelivery?.createdAt || null,
								sourceInstance,
								bridgeDelivery?.targetRevision ?? null,
						);
		if (normalizedClientMessageId) {
			// 原子批次省去写入后的远程回查；用唯一业务键定位，不依赖跨语句的 last_insert_rowid 状态。
			const [, selected] = await env.DB.batch([
				insert,
				messageByClientIdStatement(env.DB, channelId, normalizedSenderId, normalizedClientMessageId),
			]);
			return { message: await mapDecryptedMessage(env, selected.results[0]), created: true };
		}
		const result = await insert.run();
		return { message: await getMessageById(env, result.meta.last_row_id), created: true };
		} catch (error) {
			if (bridgeDelivery && String(error).includes("UNIQUE")) {
				const receipt = await env.DB.prepare(
					"SELECT 1 FROM bridge_receipts WHERE binding_id = ? AND event_id = ?",
				).bind(bridgeDelivery.bindingId, bridgeDelivery.eventId).all();
				if (receipt.results.length) return { message: null, created: false };
			}
		if (isR2ObjectUnavailableError(error)) {
			throw new Error("Attachment is not available");
		}
		if (sourceMessageId && String(error?.message || error).includes("UNIQUE")) {
			const existing = await getMessageBySource(env, source, sourceMessageId);
			if (existing) {
				return { message: existing, created: false };
			}
		}
		if (normalizedClientMessageId && String(error?.message || error).includes("UNIQUE")) {
			const existing = await getMessageByClientId(
				env,
				channelId,
				normalizedSenderId,
				normalizedClientMessageId,
			);
			if (existing) {
				return { message: existing, created: false };
			}
			if (
				await hasConsumedClientMessageId(
					env.DB,
					channelId,
					normalizedSenderId,
					normalizedClientMessageId,
				)
			) {
				throw new Error("Message idempotency key was already consumed");
			}
		}
		throw error;
	}
}

export async function insertMessage(env, {
	channelId,
	senderId,
	content,
	attachment,
	clientMessageId = null,
	mentionUserIds = [],
	replyToMessageId = null,
	replyToSenderId = null,
}) {
	const result = await persistMessage(env, {
		channelId,
		senderId,
		content,
		attachment,
		clientMessageId,
		mentionUserIds,
		replyToMessageId,
		replyToSenderId,
	});
	return result.message;
}

export function insertMessageIdempotent(env, payload) {
	return persistMessage(env, payload);
}

export function insertExternalMessage(env, payload) {
	return persistMessage(env, payload);
}
