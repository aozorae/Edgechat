#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword, verifyPassword } from "../../worker/src/auth.js";
import { activeUserSql } from "../../worker/src/user-status.js";
import { generateBootstrapSql } from "./generate-admin-bootstrap-sql.mjs";
import { createD1Query } from "./cloudflare-d1.ts";

type Credentials = { username: string; password: string; displayName?: string };
type QueryD1 = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function syncAdminCredentials(credentials: Credentials, queryD1: QueryD1) {
  const username = credentials.username.trim();
  if (!username) throw new Error("Missing required environment variable: EDGECHAT_ADMIN_USERNAME");
  if (!credentials.password) throw new Error("Missing required environment variable: EDGECHAT_ADMIN_PASSWORD");
  const [user] = await queryD1(`SELECT id, password_hash, password_salt,
    (is_super_admin = 1 AND deleted_at IS NULL AND ${activeUserSql()}) AS can_sync
    FROM users WHERE username = ?`, [username]);
  if (!user) {
    await queryD1(await generateBootstrapSql({ ...credentials, username }));
    return "created";
  }
  // 部署凭据只管理已有超管的密码，不能顺带提权、解封或恢复已删除账号。
  if (!Number(user.can_sync)) {
    throw new Error("Configured administrator is not an active super administrator; follow docs/rbac.md for explicit recovery.");
  }
  if (await verifyPassword(credentials.password, user.password_hash, user.password_salt)) return "unchanged";
  const hashed = await hashPassword(credentials.password);
  // 相同密码不写库；真正换密时递增版本，让网页与原生旧会话统一失效。
  const updated = await queryD1(`UPDATE users SET password_hash = ?, password_salt = ?,
    session_version = session_version + 1 WHERE id = ? AND is_super_admin = 1
    AND deleted_at IS NULL AND ${activeUserSql()} RETURNING id`,
  [hashed.hash, hashed.salt, user.id]);
  if (!updated.length) throw new Error("Administrator status changed during sync; rerun deployment after checking the account.");
  return "updated";
}

async function main() {
  const username = process.env.EDGECHAT_ADMIN_USERNAME || process.env.CFCHAT_ADMIN_USERNAME || "";
  const result = await syncAdminCredentials({
    username,
    password: process.env.EDGECHAT_ADMIN_PASSWORD || process.env.CFCHAT_ADMIN_PASSWORD || "",
    displayName: (process.env.EDGECHAT_ADMIN_DISPLAY_NAME || process.env.CFCHAT_ADMIN_DISPLAY_NAME || "").trim() || username.trim(),
  }, createD1Query());
  console.log(`Administrator credentials: ${result}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
