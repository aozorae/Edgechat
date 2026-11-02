import {
  getTelegramBoundUser, getTelegramDm, getTelegramPrompt, listTelegramDms, saveTelegramPrompt,
  type TelegramDatabase, type TelegramDm,
} from "../../data/telegram-direct.ts";
import { submitClientRoomAction } from "../../do-bridge.js";
import { sendTelegramText } from "./client.js";

interface PrivateMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  reply_to_message?: { message_id: number };
}
interface DirectEnv {
  DB: TelegramDatabase;
  CHANNEL_ROOM: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

export const TELEGRAM_CHAT_LIST = "私聊列表";
export const TELEGRAM_CANCEL = "取消发送";
export const telegramMenu = { keyboard: [[{ text: TELEGRAM_CHAT_LIST }, { text: TELEGRAM_CANCEL }]], resize_keyboard: true };

export function telegramDmButton(room: TelegramDm) {
  return { text: `✉ ${room.name.replace(/[\r\n]/g, " ").slice(0, 40)} [${room.id}]` };
}

export async function handleTelegramDirectMessage(env: DirectEnv, botToken: string, message?: PrivateMessage) {
  if (!message || message.chat?.type !== "private" || message.from?.is_bot ||
    String(message.chat.id) !== String(message.from?.id)) return false;
  const chatId = String(message.chat.id);
  const text = String(message.text || "").trim();
  const send = (body: string, replyMarkup: object = telegramMenu) => sendTelegramText(botToken, {
    chatId, text: body, parseMode: null, replyMarkup, disableLinkPreview: true, timeoutMs: 5000,
  });
  const bound = await getTelegramBoundUser(env.DB, chatId);
  if (!bound) {
    await send("请先在 EdgeChat「设置 → Telegram 通知」中绑定账号。", { remove_keyboard: true });
    return true;
  }
  const userId = bound.user_id;
  if (text === "/cancel" || text === TELEGRAM_CANCEL) {
    await env.DB.prepare("DELETE FROM telegram_dm_prompts WHERE user_id = ?").bind(userId).run();
    await send("已取消发送。点击「私聊列表」选择联系人。");
    return true;
  }

  const pageMatch = /^(?:◀|▶) 私聊第 (\d+) 页$/.exec(text);
  if (/^\/(?:chats|start|help)(?:@[A-Za-z0-9_]+)?$/.test(text) || text === TELEGRAM_CHAT_LIST || pageMatch) {
    const page = pageMatch ? Number(pageMatch[1]) - 1 : 0;
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) return true;
    const { rooms, hasNext } = await listTelegramDms(env.DB, userId, page);
    const keyboard = rooms.map(room => [telegramDmButton(room)]);
    const navigation = [];
    if (page > 0) navigation.push({ text: `◀ 私聊第 ${page} 页` });
    if (hasNext) navigation.push({ text: `▶ 私聊第 ${page + 2} 页` });
    if (navigation.length) keyboard.push(navigation);
    keyboard.push([{ text: TELEGRAM_CHAT_LIST }, { text: TELEGRAM_CANCEL }]);
    await send(rooms.length
      ? `你的私聊联系人 · 第 ${page + 1} 页\n点击姓名，然后回复提示即可发送文字。\n这里只显示已有且可发送的私聊，不包含群组。`
      : "暂无可发送的私聊。请先在 EdgeChat 中发起私聊，再点击「私聊列表」。",
    { keyboard, resize_keyboard: true });
    return true;
  }

  // Telegram 回复键盘可能保留当前回复引用；按钮必须先识别，避免把联系人按钮误发成正文。
  const selection = /^✉ .+ \[(\d+)\]$/.exec(text);
  if (message.reply_to_message && !selection) {
    const prompt = await getTelegramPrompt(env.DB, userId, chatId, message.reply_to_message.message_id);
    const room = prompt ? await getTelegramDm(env.DB, userId, prompt.channel_id) : null;
    if (!room) {
      await send("提示已过期、已取消或该私聊不可发送。请重新点击「私聊列表」选择联系人。");
      return true;
    }
    if (!text || new TextEncoder().encode(text).byteLength > 8000) {
      await send("这里只支持非空文字，单条最多 8000 字节；附件请在 EdgeChat 中发送。请回复原提示重试。");
      return true;
    }
    // 走站内本地用户提交器：保留加密、双向拉黑、房间授权、广播及未读投影。
    // Telegram 重发同一 webhook 时复用消息键，不会创建第二条站内消息。
    const response = await submitClientRoomAction(env, {
      room: { kind: "dm", id: room.id }, principal: { userId, isAdmin: false },
      action: { type: "send", content: text, clientMessageId: `tg:${chatId}:${message.message_id}` },
    });
    if (response.status >= 500) throw new Error("Telegram DM submission unavailable");
    if (!response.ok) {
      await send("发送失败：该私聊当前不可发送，请检查账号、联系人状态或拉黑设置。");
      return true;
    }
    await send(`已发送给 ${room.name}。\n继续发送可点击下方姓名，或回复原提示（10 分钟内有效）。`,
      { keyboard: [[telegramDmButton(room)], [{ text: TELEGRAM_CHAT_LIST }, { text: TELEGRAM_CANCEL }]], resize_keyboard: true });
    return true;
  }

  if (selection) {
    const channelId = Number(selection[1]);
    const room = Number.isSafeInteger(channelId) ? await getTelegramDm(env.DB, userId, channelId) : null;
    if (!room) {
      await send("该私聊当前不可发送。请重新打开「私聊列表」。");
      return true;
    }
    const existing = await env.DB.prepare("SELECT request_message_id FROM telegram_dm_prompts WHERE user_id = ?")
      .bind(userId).first<{ request_message_id: number }>();
    if (existing && existing.request_message_id >= message.message_id) return true;
    const prompt = await send(`发送给 ${room.name}\n请回复这条提示输入文字，10 分钟内有效。取消请点「取消发送」或输入 /cancel。`,
      { force_reply: true, input_field_placeholder: "输入要发送的私聊文字" });
    await saveTelegramPrompt(env.DB, {
      userId, chatId, channelId: room.id, promptId: prompt.message_id, requestId: message.message_id,
    });
    return true;
  }
  await send("点击「私聊列表」选择联系人，再回复提示发送文字。也可以输入 /chats 打开列表。");
  return true;
}
