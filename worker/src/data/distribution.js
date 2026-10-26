import { hashPassword } from '../auth.js';
import { randomToken } from '../utils.js';

/**
 * 期一：分发制数据层。
 * - 分发总开关 / 关系树可见开关：site_settings（缺失按默认开启）
 * - 笨笨 bot 账号：懒创建（首个自动建号时建），用户名固定 benben
 * - 设备幂等：按 device_sessions.installation_id 查活跃会话（同设备只开一个号）
 * - 邀请树：期一只做一级（管理员/运营发码 → 客户）
 */

export const BENBEN_BOT_USERNAME = 'benben';
export const BENBEN_BOT_DISPLAY_NAME = '笨笨';
export const BOT_PREFS_PASSWORD_KEY = 'distribution.botPasswordHash';

const GATE_KEY = 'distribution.gateEnabled';
const TREE_KEY = 'distribution.treeVisible';

/** 读取期一开关。缺省视为开启（历史库未迁移时也不至于锁死客户端）。 */
export async function getDistributionConfig(db) {
  const result = await db
    .prepare(
      `SELECT setting_key, setting_value
       FROM site_settings
       WHERE setting_key IN (?, ?)`
    )
    .bind(GATE_KEY, TREE_KEY)
    .all();
  const map = Object.fromEntries((result.results || []).map((row) => [row.setting_key, row.setting_value]));
  return {
    gateEnabled: (map[GATE_KEY] ?? '1') !== '0',
    treeVisible: (map[TREE_KEY] ?? '1') !== '0'
  };
}

/** 后台改开关（admin 接口调用）。 */
export async function updateDistributionConfig(db, { gateEnabled, treeVisible } = {}) {
  const statements = [];
  if (typeof gateEnabled === 'boolean') {
    statements.push(
      db
        .prepare(
          `INSERT INTO site_settings (setting_key, setting_value, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`
        )
        .bind(GATE_KEY, gateEnabled ? '1' : '0')
    );
  }
  if (typeof treeVisible === 'boolean') {
    statements.push(
      db
        .prepare(
          `INSERT INTO site_settings (setting_key, setting_value, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`
        )
        .bind(TREE_KEY, treeVisible ? '1' : '0')
    );
  }
  if (statements.length) {
    await db.batch(statements);
  }
  return getDistributionConfig(db);
}

/**
 * 懒创建「笨笨」bot 账号：固定用户名 benben，随机密码（不可登录使用，仅占位）。
 * 幂等：已存在则直接返回。
 */
export async function ensureBenbenBot(db) {
  const existing = await db
    .prepare(
      `SELECT id, username, display_name, session_version, avatar_key
       FROM users
       WHERE username = ? AND deleted_at IS NULL
       LIMIT 1`
    )
    .bind(BENBEN_BOT_USERNAME)
    .all();
  if (existing.results?.[0]) {
    return existing.results[0];
  }
  const hashed = await hashPassword(randomToken(32));
  const created = await db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, password_salt, bio)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(BENBEN_BOT_USERNAME, BENBEN_BOT_DISPLAY_NAME, hashed.hash, hashed.salt, '')
    .run();
  return {
    id: Number(created.meta.last_row_id),
    username: BENBEN_BOT_USERNAME,
    display_name: BENBEN_BOT_DISPLAY_NAME,
    session_version: 0,
    avatar_key: null
  };
}

/** 同设备幂等：按 installation_id 找活跃会话对应的用户（未注销且未过期）。 */
export async function findActiveDeviceUser(db, installationId) {
  const result = await db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.session_version, u.avatar_key, u.is_admin, u.is_super_admin
       FROM device_sessions ds
       JOIN users u ON u.id = ds.user_id
       WHERE ds.installation_id = ?
         AND ds.revoked_at IS NULL
         AND ds.expires_at > CURRENT_TIMESTAMP
         AND u.deleted_at IS NULL
         AND u.is_disabled = 0
       ORDER BY ds.created_at DESC
       LIMIT 1`
    )
    .bind(installationId)
    .all();
  return result.results?.[0] || null;
}

/**
 * 期一：一级邀请树（管理员/运营发码 → 客户）。
 * 只返回邀请人=有下级的用户及其直接下级；不返回更深的层级。
 */
export async function getInvitationTreeOneLevel(db) {
  const roots = await db
    .prepare(
      `SELECT u.id, u.username, u.display_name,
              (SELECT COUNT(*) FROM users c WHERE c.invited_by = u.id AND c.deleted_at IS NULL) AS invited_count
       FROM users u
       WHERE u.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM users c WHERE c.invited_by = u.id AND c.deleted_at IS NULL)
       ORDER BY u.id ASC`
    )
    .all();
  const rootList = roots.results || [];
  if (!rootList.length) {
    return [];
  }
  const tree = [];
  for (const root of rootList) {
    const children = await db
      .prepare(
        `SELECT id, username, display_name, invited_at
         FROM users
         WHERE invited_by = ? AND deleted_at IS NULL
         ORDER BY invited_at DESC, id DESC`
      )
      .bind(root.id)
      .all();
    tree.push({
      userId: Number(root.id),
      username: root.username,
      displayName: root.display_name,
      invitedCount: Number(root.invited_count || 0),
      children: (children.results || []).map((child) => ({
        userId: Number(child.id),
        username: child.username,
        displayName: child.display_name,
        invitedAt: child.invited_at || null
      }))
    });
  }
  return tree;
}
