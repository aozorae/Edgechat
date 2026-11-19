#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword } from "../../worker/src/auth.js";
import { activeUserSql } from "../../worker/src/user-status.js";
import { isValidNewUsername, USERNAME_RULE_ERROR } from "../../shared/username.ts";

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

export async function generateBootstrapSql({ username, password, displayName = username }) {
  username = String(username || "").trim();
  if (!username) throw new Error("Missing required environment variable: EDGECHAT_ADMIN_USERNAME (or legacy CFCHAT_ADMIN_USERNAME)");
  if (!password) throw new Error("Missing required environment variable: EDGECHAT_ADMIN_PASSWORD (or legacy CFCHAT_ADMIN_PASSWORD)");
  if (!isValidNewUsername(username)) throw new Error(USERNAME_RULE_ERROR);
  const hashed = await hashPassword(password);

  const safeUsername = escapeSql(username);
  const safeDisplayName = escapeSql(displayName);
  const safeHash = escapeSql(hashed.hash);
  const safeSalt = escapeSql(hashed.salt);

  // 初始化只负责新账号，不能借重复部署覆盖已有账号的密码、权限或封禁状态。
  return `
INSERT INTO users (
  username,
  display_name,
  password_hash,
  password_salt,
  is_admin,
  is_super_admin,
  management_protected,
  is_disabled
)
SELECT
  '${safeUsername}',
  '${safeDisplayName}',
  '${safeHash}',
  '${safeSalt}',
  1,
  1,
  1,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE username = '${safeUsername}'
);

`.trim();
}

export async function verifyAdminBootstrap(queryD1) {
  const rows = await queryD1(`SELECT id FROM users WHERE is_super_admin = 1
    AND deleted_at IS NULL AND ${activeUserSql()} LIMIT 1`);
  if (!rows.length) {
    throw new Error("No active super administrator. Set EDGECHAT_ADMIN_USERNAME and EDGECHAT_ADMIN_PASSWORD Repository Secrets and rerun Deploy Worker, or follow docs/admin-bootstrap.md for manual initialization. Existing accounts are never overwritten; use the explicit recovery procedure if needed.");
  }
}

async function main() {
  const username = process.env.EDGECHAT_ADMIN_USERNAME || process.env.CFCHAT_ADMIN_USERNAME || "";
  const sql = await generateBootstrapSql({
    username,
    password: process.env.EDGECHAT_ADMIN_PASSWORD || process.env.CFCHAT_ADMIN_PASSWORD || "",
    displayName: (process.env.EDGECHAT_ADMIN_DISPLAY_NAME || process.env.CFCHAT_ADMIN_DISPLAY_NAME || "").trim() || username.trim(),
  });

  const outputPath = resolve(process.cwd(), ".tmp", "edgechat-admin-upsert.sql");
  mkdirSync(resolve(process.cwd(), ".tmp"), { recursive: true });
  writeFileSync(outputPath, `${sql}\n`, "utf8");

  console.log(`Generated admin bootstrap SQL: ${outputPath}`);
  console.log("Apply it to the Worker's D1 database before signing in. This only creates a missing account; it does not reset an existing password.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
