import { externalSenderExists } from "../data/messages.js";
import {
	createTelegramMapping,
	deleteTelegramMapping,
	getTelegramCredentials,
	getTelegramMappingByChatId,
	listTelegramBridgeAdminState,
	saveTelegramBridgeConfig,
	updateTelegramMapping,
} from "../data/telegram.js";
import { loadTelegramUserAvatar } from "../integrations/telegram/avatar.js";
import {
	getTelegramBot,
	getTelegramChat,
	sendTelegramText,
	setTelegramWebhook,
	TelegramApiError,
} from "../integrations/telegram/client.js";
import { ingestTelegramMessage } from "../integrations/telegram/bridge.js";
import { parseTelegramMessageUpdate } from "../integrations/telegram/parser.js";
import { handleTelegramDirectMessage, telegramMenu } from "../integrations/telegram/direct-messages.ts";
import {
	consumeTelegramNotificationLink,
	createTelegramNotificationLink,
	disconnectTelegramNotifications,
	getTelegramNotificationState,
	updateTelegramNotificationPreferences,
} from "../integrations/telegram/notifications.js";
import { errorResponse, parseJsonRequest, randomToken } from "../utils.js";

function webhookUrl(requestUrl) {
	const url = new URL(requestUrl);
	url.pathname = "/api/integrations/telegram/webhook";
	url.search = "";
	return url.toString();
}

function telegramApiError(error) {
	return error instanceof TelegramApiError
		? errorResponse(error.message, 400)
		: null;
}

const AVATAR_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";
const MISSING_AVATAR_CACHE_CONTROL = "public, max-age=600, s-maxage=600";

function avatarCacheKey(request, userId) {
	const url = new URL(request.url);
	url.pathname = `/api/integrations/telegram/avatar/${userId}`;
	url.search = "";
	return new Request(url.toString());
}

function missingAvatarResponse() {
	const response = errorResponse("头像不存在", 404);
	response.headers.set("Cache-Control", MISSING_AVATAR_CACHE_CONTROL);
	return response;
}

function telegramAvatarResponse(avatar) {
	return new Response(avatar.bytes, {
		headers: {
			"Cache-Control": AVATAR_CACHE_CONTROL,
			"Content-Length": String(avatar.bytes.byteLength),
			"Content-Type": avatar.contentType,
			"Content-Disposition": "inline",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		},
	});
}

export function registerTelegramPublicRoutes(app) {
	app.get("/api/integrations/telegram/avatar/:userId", async (c) => {
		const userId = String(c.req.param("userId") || "");
		if (!/^\d+$/.test(userId)) {
			return missingAvatarResponse();
		}

		if (!(await externalSenderExists(c.env.DB, "telegram", userId))) {
			return missingAvatarResponse();
		}

		const cache = caches.default;
		const cacheKey = avatarCacheKey(c.req.raw, userId);
		const cached = await cache.match(cacheKey);
		if (cached) return cached;

		const credentials = await getTelegramCredentials(c.env);
		if (!credentials) {
			return errorResponse("Telegram Bridge 未配置", 503);
		}

		try {
			const avatar = await loadTelegramUserAvatar(credentials.botToken, userId);
			const response = avatar ? telegramAvatarResponse(avatar) : missingAvatarResponse();
			await cache.put(cacheKey, response.clone());
			return response;
		} catch {
			return errorResponse("Telegram 头像暂时不可用", 502);
		}
	});

	app.post("/api/integrations/telegram/webhook", async (c) => {
		const credentials = await getTelegramCredentials(c.env);
		if (!credentials) {
			return errorResponse("Telegram Bridge 未配置", 503);
		}
		if (
			c.req.header("X-Telegram-Bot-Api-Secret-Token") !== credentials.webhookSecret
		) {
			return errorResponse("Webhook 验证失败", 401);
		}

		const update = await parseJsonRequest(c.req.raw);
		if (await consumeTelegramNotificationLink(c.env, update?.message)) {
			c.executionCtx.waitUntil(
				sendTelegramText(credentials.botToken, {
					chatId: update.message.chat.id,
					text: "EdgeChat 已绑定。通知将显示消息正文；点击「私聊列表」可直接发送站内私聊。你可以在 EdgeChat 设置中关闭提醒或解绑。",
					parseMode: null,
					replyMarkup: telegramMenu,
					timeoutMs: 5000,
				}).catch(() => {}),
			);
			return c.json({ ok: true });
		}
		if (await handleTelegramDirectMessage(c.env, credentials.botToken, update?.message)) {
			return c.json({ ok: true });
		}
		const telegramMessage = parseTelegramMessageUpdate(update);
		if (!telegramMessage) {
			return c.json({ ok: true });
		}
		const mapping = await getTelegramMappingByChatId(
			c.env.DB,
			telegramMessage.telegramChatId,
		);
		if (!mapping) {
			return c.json({ ok: true });
		}

			await ingestTelegramMessage(c.env, {
				mapping,
				telegramMessage,
				botToken: credentials.botToken,
			});
		return c.json({ ok: true });
	});
}

export function registerTelegramNotificationRoutes(app) {
	app.get("/api/me/telegram-notifications", async (c) =>
		c.json(await getTelegramNotificationState(c.env, c.get("session").userId)),
	);
	app.post("/api/me/telegram-notifications/link", async (c) => {
		const url = await createTelegramNotificationLink(c.env, c.get("session").userId);
		return url ? c.json({ url }) : errorResponse("管理员尚未配置 Telegram Bot", 503);
	});
	app.put("/api/me/telegram-notifications", async (c) => {
		const payload = await parseJsonRequest(c.req.raw);
		if (typeof payload.dmEnabled !== "boolean" || typeof payload.mentionEnabled !== "boolean") {
			return errorResponse("通知设置无效");
		}
		const userId = c.get("session").userId;
		await updateTelegramNotificationPreferences(c.env.DB, userId, payload);
		return c.json(await getTelegramNotificationState(c.env, userId));
	});
	app.delete("/api/me/telegram-notifications", async (c) => {
		await disconnectTelegramNotifications(c.env.DB, c.get("session").userId);
		return c.json({ ok: true });
	});
}

export function registerTelegramAdminRoutes(app) {
	app.get("/api/admin/telegram", async (c) => {
		return c.json(await listTelegramBridgeAdminState(c.env, c.get('session')));
	});

	app.put("/api/admin/telegram/config", async (c) => {
		const payload = await parseJsonRequest(c.req.raw);
		const botToken = String(payload.botToken || "").trim();
		if (!botToken) {
			return errorResponse("Telegram Bot Token 不能为空");
		}

		try {
			const bot = await getTelegramBot(botToken);
			const secret = randomToken(32);
			const url = webhookUrl(c.req.url);
			await setTelegramWebhook(botToken, { url, secretToken: secret });
			await saveTelegramBridgeConfig(c.env, {
				botToken,
				webhookSecret: secret,
				botUsername: bot.username || "",
				webhookUrl: url,
				updatedBy: c.get("session").userId,
			});
			return c.json(await listTelegramBridgeAdminState(c.env, c.get('session')));
		} catch (error) {
			return telegramApiError(error) || errorResponse("Telegram 配置保存失败", 500);
		}
	});

	app.post("/api/admin/telegram/mappings", async (c) => {
		const payload = await parseJsonRequest(c.req.raw);
		const channelId = Number(payload.channelId);
		const telegramChatId = String(payload.telegramChatId || "").trim();
		if (!Number.isInteger(channelId) || channelId <= 0 || !/^-\d+$/.test(telegramChatId)) {
			return errorResponse("请选择群组并填写有效的 Telegram 群 ID");
		}

		try {
			const credentials = await getTelegramCredentials(c.env);
			if (!credentials) {
				return errorResponse("请先连接 Telegram Bot");
				}
				const telegramChat = await getTelegramChat(credentials.botToken, telegramChatId);
				if (!["group", "supergroup"].includes(telegramChat.type)) {
					return errorResponse("目标必须是 Telegram 群组或超级群组");
				}
				const mappingId = await createTelegramMapping(c.env.DB, {
				channelId,
				telegramChatId,
				telegramChatTitle:
					telegramChat.title || telegramChat.username || String(telegramChat.id),
				createdBy: c.get("session").userId,
			});
			if (!mappingId) {
				return errorResponse("群组不存在", 404);
			}
			return c.json(await listTelegramBridgeAdminState(c.env, c.get('session')));
		} catch (error) {
			const telegramError = telegramApiError(error);
			if (telegramError) {
				return telegramError;
			}
			if (String(error?.message || error).includes("UNIQUE")) {
				return errorResponse("这个 EdgeChat 群组或 Telegram 群已经绑定");
			}
			throw error;
		}
	});

	app.patch("/api/admin/telegram/mappings/:mappingId", async (c) => {
		const payload = await parseJsonRequest(c.req.raw);
		const updated = await updateTelegramMapping(c.env.DB, c.req.param("mappingId"), {
			enabled: Boolean(payload.enabled),
		});
		if (!updated) {
			return errorResponse("Telegram 映射不存在", 404);
		}
		return c.json(await listTelegramBridgeAdminState(c.env, c.get('session')));
	});

	app.delete("/api/admin/telegram/mappings/:mappingId", async (c) => {
		const deleted = await deleteTelegramMapping(c.env.DB, c.req.param("mappingId"));
		if (!deleted) {
			return errorResponse("Telegram 映射不存在", 404);
		}
		return c.json(await listTelegramBridgeAdminState(c.env, c.get('session')));
	});
}
