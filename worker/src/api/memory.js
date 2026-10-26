import { errorResponse, parseJsonRequest } from "../utils.js";
import { getMemoryAccount } from "../integrations/memory/accounts.js";
import { settleTextSession } from "../integrations/memory/text-session.js";

/**
 * TASK-133：Chat 版记忆接口。
 * - POST /api/v1/memory/text-session/ended   客户端切后台时上报文本会话结束（转调 /pi 生成摘要）
 * - GET  /api/admin/memory/account?userId=   管理员只读台账状态（不含令牌）
 *
 * 安全：任何响应都不返回令牌明文；只回 has_account / customer_id / status。
 */
export function registerMemoryRoutes(app) {
  app.post("/api/v1/memory/text-session/ended", async (c) => {
    const session = c.get("session");
    const payload = await parseJsonRequest(c.req.raw);
    const roomId = Number(payload.roomId);
    const lastMessageId = Number(payload.lastMessageId);
    if (!Number.isInteger(roomId) || roomId <= 0 || !Number.isInteger(lastMessageId) || lastMessageId <= 0) {
      return errorResponse("参数无效", 400);
    }

    // 只允许结算自己所在的 DM 房间，且该消息属于该房间
    const member = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM channel_members WHERE channel_id = ? AND user_id = ? LIMIT 1`
    )
      .bind(roomId, Number(session.userId))
      .all();
    if (!member.results?.length) {
      return errorResponse("无权访问该会话", 403);
    }
    const message = await c.env.DB.prepare(
      `SELECT id FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL LIMIT 1`
    )
      .bind(lastMessageId, roomId)
      .all();
    if (!message.results?.length) {
      return errorResponse("消息不存在", 400);
    }

    const result = await settleTextSession(c.env, {
      roomId,
      userId: Number(session.userId),
      lastMessageId,
      startedAt: Number(payload.startedAt) || Date.now(),
      turnCount: Number(payload.turnCount) || 0,
      lastUserText: String(payload.lastUserText || "")
    });

    // 客户端只需要知道"收到了"：失败一律 202（异步语义），状态码只在服务端日志/台账里
    return c.json({ ok: true, accepted: true, status: result.status }, 202);
  });
}

export function registerMemoryAdminRoutes(app) {
  app.get("/api/admin/memory/account", async (c) => {
    const userId = Number(c.req.query("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      return errorResponse("参数无效", 400);
    }
    const account = await getMemoryAccount(c.env.DB, userId);
    if (!account) {
      return c.json({ userId, hasAccount: false });
    }
    return c.json({
      userId,
      hasAccount: account.status === "active",
      status: account.status,
      customerId: account.customer_id || "",
      deviceId: account.device_id,
      hasToken: Boolean(account.sag_token_cipher),
      lastError: account.last_error || "",
      updatedAt: account.updated_at
    });
  });
}
