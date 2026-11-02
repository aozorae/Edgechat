import { errorResponse, parseJsonRequest } from "../utils.js";
import {
  getAiReplyConfig,
  getAiReplyStats,
  updateAiReplyConfig
} from "../integrations/ai-reply/store.js";
import { hasPermission } from "../../../shared/admin-permissions.ts";

/**
 * 期一增项：文本回复链后台接口（仅管理员；复用 invites 权限，不新增权限点）。
 * - GET  /api/admin/ai-reply/config   读配置（hasApiKey 只回布尔，不返回 key）
 * - PUT  /api/admin/ai-reply/config   改开关与每日上限
 * - GET  /api/admin/ai-reply/stats    最近若干天回复量（按天汇总，成本观察）
 */
export function registerAiReplyAdminRoutes(app) {
  app.get("/api/admin/ai-reply/config", async (c) => {
    if (!hasPermission(c.get("session"), "invites.read")) {
      return errorResponse("无权限", 403);
    }
    return c.json(await getAiReplyConfig(c.env.DB, c.env));
  });

  app.put("/api/admin/ai-reply/config", async (c) => {
    if (!hasPermission(c.get("session"), "invites.create")) {
      return errorResponse("无权限", 403);
    }
    const payload = await parseJsonRequest(c.req.raw);
    const patch = {};
    if (typeof payload.enabled === "boolean") patch.enabled = payload.enabled;
    if (payload.dailyLimit !== undefined && payload.dailyLimit !== null) {
      const limit = Number(payload.dailyLimit);
      if (!Number.isInteger(limit) || limit < 0 || limit > 5000) {
        return errorResponse("每日上限必须是 0 到 5000 的整数", 400);
      }
      patch.dailyLimit = limit;
    }
    if (!Object.keys(patch).length) {
      return errorResponse("没有需要修改的配置", 400);
    }
    await updateAiReplyConfig(c.env.DB, patch);
    return c.json(await getAiReplyConfig(c.env.DB, c.env));
  });

  app.get("/api/admin/ai-reply/stats", async (c) => {
    if (!hasPermission(c.get("session"), "invites.read")) {
      return errorResponse("无权限", 403);
    }
    return c.json(await getAiReplyStats(c.env.DB, { days: c.req.query("days") }));
  });
}
