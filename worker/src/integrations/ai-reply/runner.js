import { insertMessage, listMessages } from "../../data/messages.js";
import { buildChatMessages } from "./persona.js";
import { requestDashScopeReply } from "./provider.js";
import {
  countRecentReplies,
  createAiReplyJob,
  DEFAULT_CONTEXT_MESSAGES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  getAiReplyConfig,
  resolveBenbenDm,
  updateAiReplyJob,
  utcDayStart
} from "./store.js";

/**
 * 期一增项：笨笨文本回复执行器。
 *
 * 调用点：ChannelRoom Durable Object 在消息落库并广播后，用 state.waitUntil 异步触发，
 * 不阻塞用户发消息的响应，也不依赖客户端配合（网页 WS 与 App 的 v1 HTTP 都会走到）。
 *
 * 行为：
 * - 只在「用户 与 笨笨」的一对一 dm 里触发；笨笨自己发的消息、群聊、普通用户间 DM 一律不动
 * - 幂等：trigger_message_id 唯一，一条用户消息最多一条回复
 * - 闸门：总开关 / 缺 API Key / 每人每日上限（默认 200）→ 记 skipped，不回复
 * - 失败：静默（不向用户发报错文案），重试一次；结果写 ai_reply_jobs 供后台排障
 */

const RETRY_DELAY_MS = 2000;

function envInt(env, key, fallback, max) {
  const parsed = Number(env?.[key]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAiReply({
  env,
  room,
  triggerMessage,
  onReply = async () => {},
  providerFetch = fetch,
  now = new Date(),
  sleep = defaultSleep
} = {}) {
  if (!env?.DB || !room || !triggerMessage) {
    return { status: "ignored", reason: "invalid_input" };
  }
  if (String(room.kind || "") !== "dm") {
    return { status: "ignored", reason: "not_dm" };
  }
  const sender = triggerMessage.sender;
  if (!sender || String(sender.kind || "") !== "local") {
    return { status: "ignored", reason: "not_local_sender" };
  }

  const dm = await resolveBenbenDm(env.DB, room.id, sender.id);
  if (!dm) {
    return { status: "ignored", reason: "not_benben_dm" };
  }
  if (Number(sender.id) === dm.botId) {
    return { status: "ignored", reason: "bot_self" };
  }

  const job = await createAiReplyJob(env.DB, {
    channelId: room.id,
    triggerMessageId: triggerMessage.id,
    recipientUserId: dm.recipientUserId
  });
  if (!job.created || !job.id) {
    return { status: "ignored", reason: "duplicate" };
  }

  const skip = async (reason) => {
    await updateAiReplyJob(env.DB, job.id, { status: "skipped", error: reason });
    return { status: "skipped", reason };
  };

  const config = await getAiReplyConfig(env.DB, env);
  if (!config.enabled) return skip("disabled");
  if (!config.hasApiKey) return skip("missing_api_key");

  const used = await countRecentReplies(env.DB, {
    recipientUserId: dm.recipientUserId,
    since: utcDayStart(now)
  });
  // 刚登记的本条已计入 used：dailyLimit=0 表示当日禁止，1 表示每天只回一条
  if (used > config.dailyLimit) return skip("daily_limit");

  const contextLimit = envInt(env, "AI_REPLY_CONTEXT_MESSAGES", DEFAULT_CONTEXT_MESSAGES, 30);
  const history = await listMessages(env, room.id, null, contextLimit);
  const messages = buildChatMessages({ history, botId: dm.botId });

  const maxTokens = envInt(env, "AI_REPLY_MAX_TOKENS", DEFAULT_MAX_TOKENS, 2000);
  const timeoutMs = envInt(env, "AI_REPLY_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 60000);
  const request = {
    apiKey: env.DASHSCOPE_API_KEY,
    model: config.model,
    messages,
    maxTokens,
    timeoutMs,
    fetchImpl: providerFetch
  };

  await updateAiReplyJob(env.DB, job.id, {
    status: "running",
    attempts: 1,
    provider: "dashscope",
    model: config.model
  });

  let reply = await requestDashScopeReply(request);
  if (!reply.ok) {
    await sleep(RETRY_DELAY_MS);
    reply = await requestDashScopeReply(request);
    await updateAiReplyJob(env.DB, job.id, { attempts: 2 });
  }
  if (!reply.ok) {
    await updateAiReplyJob(env.DB, job.id, { status: "failed", error: reply.error });
    return { status: "failed", reason: reply.error };
  }

  let message = null;
  try {
    message = await insertMessage(env, {
      channelId: room.id,
      senderId: dm.botId,
      content: reply.content
    });
  } catch (error) {
    await updateAiReplyJob(env.DB, job.id, {
      status: "failed",
      error: `persist_failed: ${String(error?.message || error).slice(0, 160)}`
    });
    return { status: "failed", reason: "persist_failed" };
  }

  await updateAiReplyJob(env.DB, job.id, {
    status: "done",
    replied_message_id: message.id,
    error: null
  });

  try {
    await onReply(message);
  } catch (error) {
    // 消息已落库：广播/投影失败只影响实时性，不改变任务结果
    console.error(
      JSON.stringify({
        message: "ai reply delivery failed",
        roomId: Number(room.id),
        messageId: Number(message.id),
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }

  return { status: "done", messageId: message.id };
}
