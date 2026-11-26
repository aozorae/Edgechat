import {
	normalizeContentType,
	safeFilenameExtension,
	sanitizeFilename,
} from "../../attachment-metadata.js";
import { decryptAttachment, encryptAttachment } from "../../encryption.js";
import { downloadTelegramFile, getTelegramFile } from "./client.js";
import { getFileStorage } from "../../storage/index.ts";
import { isDirectFile, serveDirectFile } from "../../storage/direct-read.ts";
import { getUploadedFileMetadata } from "../../data/uploaded-files.js";

export const TELEGRAM_BRIDGE_FILE_LIMIT = 16 * 1024 * 1024;
export const TELEGRAM_FILE_SKIP_REASON = Object.freeze({
	TOO_LARGE: "too_large",
	STORAGE_UNAVAILABLE: "storage_unavailable",
	NOT_FOUND: "not_found",
});
const FILE_RESPONSE_CACHE_CONTROL = "private, no-store";

function telegramObjectKey({ telegramChatId, telegramMessageId, filename }) {
	const extension = safeFilenameExtension(filename);
	return `telegram/${telegramChatId}/${telegramMessageId}-${crypto.randomUUID()}${extension}`;
}

export async function importTelegramAttachment(env, {
	botToken,
	telegramChatId,
	telegramMessageId,
	attachment,
}) {
	if (!attachment) return { attachment: null, skipReason: null };
	const storage = getFileStorage(env);
	if (!storage) {
		return {
			attachment: null,
			skipReason: TELEGRAM_FILE_SKIP_REASON.STORAGE_UNAVAILABLE,
		};
	}
	if (attachment.fileSize > TELEGRAM_BRIDGE_FILE_LIMIT) {
		return { attachment: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
	}

	const telegramFile = await getTelegramFile(botToken, attachment.fileId);
	const resolvedSize = Number(telegramFile.file_size || attachment.fileSize || 0);
	if (resolvedSize > TELEGRAM_BRIDGE_FILE_LIMIT) {
		return { attachment: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
	}
	const bytes = await downloadTelegramFile(
		botToken,
		telegramFile.file_path,
		TELEGRAM_BRIDGE_FILE_LIMIT,
	);
	const name = sanitizeFilename(attachment.fileName);
	const type = normalizeContentType(attachment.mimeType) || "application/octet-stream";
	const key = telegramObjectKey({ telegramChatId, telegramMessageId, filename: name });
	// Telegram 只负责传输，正式附件在进入消息前即转换为 EdgeChat 自有加密对象。
	const encrypted = await encryptAttachment(env, bytes, key);
	await storage.put(key, encrypted, {
		httpMetadata: { contentType: type, cacheControl: FILE_RESPONSE_CACHE_CONTROL },
		customMetadata: { filename: name, edgechatEncryption: "v1", source: "telegram" },
	});
	return {
		attachment: {
			key,
			name,
			type,
			size: bytes.byteLength,
				...(attachment.kind === "voice" || attachment.kind === "audio"
					? {
						kind: attachment.kind,
						durationMs: attachment.durationMs || 0,
						...(attachment.kind === "voice" ? { waveform: [] } : {}),
					}
					: {}),
		},
		skipReason: null,
	};
}

export async function loadEdgeChatAttachment(env, attachment) {
	if (!attachment) {
		return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.NOT_FOUND };
	}
	if (Number(attachment.size) > TELEGRAM_BRIDGE_FILE_LIMIT) {
		return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
	}
	const storage = getFileStorage(env);
	if (!storage) {
		return {
			file: null,
			skipReason: TELEGRAM_FILE_SKIP_REASON.STORAGE_UNAVAILABLE,
		};
	}
	let bytes;
	if (isDirectFile(attachment.key)) {
		const meta = await getUploadedFileMetadata(env.DB, attachment.key);
		if (!meta) return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.NOT_FOUND };
		if (meta.size > TELEGRAM_BRIDGE_FILE_LIMIT) return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
		const response = await serveDirectFile(env, attachment.key, meta, new Request('https://internal/'), 'attachment');
		if (!response.ok) return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.NOT_FOUND };
		bytes = new Uint8Array(await response.arrayBuffer());
	} else {
		const object = await storage.get(attachment.key);
		if (!object) {
			return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.NOT_FOUND };
		}
		bytes = (await decryptAttachment(env, await object.arrayBuffer(), attachment.key)).bytes;
	}
	if (bytes.byteLength > TELEGRAM_BRIDGE_FILE_LIMIT) {
		return { file: null, skipReason: TELEGRAM_FILE_SKIP_REASON.TOO_LARGE };
	}
	return {
		file: {
			bytes,
			name: sanitizeFilename(attachment.name),
				type: normalizeContentType(attachment.type) || "application/octet-stream",
				size: bytes.byteLength,
				kind: attachment.kind,
				durationMs: Number(attachment.durationMs || 0),
			},
		skipReason: null,
	};
}

export async function deleteImportedTelegramAttachment(env, attachment) {
	if (!attachment?.key) return;
	try {
		const storage = getFileStorage(env);
		if (!storage) return;
		await storage.delete(attachment.key);
	} catch (error) {
		console.warn(JSON.stringify({
			message: "telegram orphan attachment delete failed",
			objectKey: attachment.key,
			error: error instanceof Error ? error.message : String(error),
		}));
	}
}
