const TELEGRAM_API_ROOT = "https://api.telegram.org";
const TELEGRAM_FILE_ROOT = `${TELEGRAM_API_ROOT}/file`;

export class TelegramApiError extends Error {
	constructor(message, { status = 0, retryAfter = 0 } = {}) {
		super(message);
		this.name = "TelegramApiError";
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

function validateBotToken(botToken) {
	const token = String(botToken || "").trim();
	if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
		throw new TelegramApiError("Telegram Bot Token 格式无效");
	}
	return token;
}

async function parseTelegramResponse(response) {
	const result = await response.json().catch(() => null);
	if (!response.ok || !result?.ok) {
		throw new TelegramApiError(result?.description || `Telegram API 请求失败：${response.status}`, {
			status: result?.error_code || response.status,
			retryAfter: Number(result?.parameters?.retry_after) || 0,
		});
	}
	return result.result;
}

export async function callTelegramApi(botToken, method, payload = {}, options = {}) {
	const token = validateBotToken(botToken);
	const response = await fetch(
		`${TELEGRAM_API_ROOT}/bot${token}/${method}`,
		{
			method: "POST",
			...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	return parseTelegramResponse(response);
}

export async function callTelegramMultipartApi(botToken, method, formData) {
	const token = validateBotToken(botToken);
	const response = await fetch(`${TELEGRAM_API_ROOT}/bot${token}/${method}`, {
		method: "POST",
		body: formData,
	});
	return parseTelegramResponse(response);
}

export function getTelegramBot(botToken) {
	return callTelegramApi(botToken, "getMe");
}

export function setTelegramWebhook(botToken, { url, secretToken }) {
	return callTelegramApi(botToken, "setWebhook", {
		url,
		secret_token: secretToken,
		allowed_updates: ["message"],
		drop_pending_updates: false,
	});
}

export function getTelegramChat(botToken, chatId) {
	return callTelegramApi(botToken, "getChat", { chat_id: String(chatId) });
}

export function getTelegramUserProfilePhotos(botToken, userId) {
	return callTelegramApi(botToken, "getUserProfilePhotos", {
		user_id: Number(userId),
		offset: 0,
		limit: 1,
	});
}

export function sendTelegramText(botToken, {
	chatId,
	text,
	parseMode = "HTML",
	replyToMessageId = null,
	replyMarkup = null,
	disableLinkPreview = false,
	timeoutMs = 0,
}) {
	const payload = {
		chat_id: String(chatId),
		text: String(text),
	};
	if (parseMode) payload.parse_mode = parseMode;
	if (replyMarkup) payload.reply_markup = replyMarkup;
	if (disableLinkPreview) payload.link_preview_options = { is_disabled: true };
	if (replyToMessageId) {
		payload.reply_parameters = { message_id: Number(replyToMessageId) };
	}
	return callTelegramApi(botToken, "sendMessage", payload, { timeoutMs });
}

export function getTelegramFile(botToken, fileId) {
	return callTelegramApi(botToken, "getFile", { file_id: String(fileId) });
}

export async function downloadTelegramFile(botToken, filePath, maxBytes) {
	const token = validateBotToken(botToken);
	const cleanPath = String(filePath || "").replace(/^\/+/, "");
	if (!cleanPath) {
		throw new TelegramApiError("Telegram 文件路径无效");
	}
	const response = await fetch(`${TELEGRAM_FILE_ROOT}/bot${token}/${cleanPath}`);
	if (!response.ok) {
		throw new TelegramApiError(`Telegram 文件下载失败：${response.status}`);
	}
	const contentLength = Number(response.headers.get("content-length") || 0);
	if (contentLength > maxBytes) {
		throw new TelegramApiError("Telegram 文件超过 Bridge 大小限制");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) {
		throw new TelegramApiError("Telegram 文件超过 Bridge 大小限制");
	}
	return bytes;
}

export function sendTelegramMedia(botToken, {
	chatId,
	kind,
	bytes,
	filename,
	contentType,
	caption,
	durationMs = 0,
	replyToMessageId = null,
}) {
	const methods = {
		photo: ["sendPhoto", "photo"],
		video: ["sendVideo", "video"],
		voice: ["sendVoice", "voice"],
		audio: ["sendAudio", "audio"],
		document: ["sendDocument", "document"],
	};
	const [method, field] = methods[kind] || methods.document;
	const formData = new FormData();
	formData.set("chat_id", String(chatId));
	formData.set("parse_mode", "HTML");
	if (replyToMessageId) {
		formData.set("reply_parameters", JSON.stringify({ message_id: Number(replyToMessageId) }));
	}
	if (caption) formData.set("caption", String(caption));
	if (durationMs > 0 && (kind === "voice" || kind === "audio")) {
		formData.set("duration", String(Math.round(durationMs / 1000)));
	}
	formData.set(field, new Blob([bytes], { type: contentType }), filename);
	return callTelegramMultipartApi(botToken, method, formData);
}
