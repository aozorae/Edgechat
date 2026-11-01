PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  avatar_key TEXT,
  registration_invite_id INTEGER UNIQUE,
  invited_by INTEGER REFERENCES users(id),
  invited_at TEXT,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  disabled_until TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_super_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_super_admin IN (0, 1)),
  management_protected INTEGER NOT NULL DEFAULT 0 CHECK(management_protected IN (0, 1)),
  authz_version INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by);

CREATE TABLE IF NOT EXISTS rbac_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO rbac_roles (id, key, name) VALUES (1, 'ordinary', '普通用户');
CREATE TABLE IF NOT EXISTS rbac_role_permissions (
  role_id INTEGER NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY(role_id, permission_key)
);
CREATE TABLE IF NOT EXISTS rbac_user_roles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL DEFAULT 1 REFERENCES rbac_roles(id) ON DELETE RESTRICT,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rbac_members ON rbac_user_roles(role_id, user_id);
INSERT OR IGNORE INTO rbac_user_roles (user_id) SELECT id FROM users;
CREATE TABLE IF NOT EXISTS admin_write_guard (request_id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok = 1));
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT 'success',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_log(created_at, id);
-- 与增量迁移保持同一保留规则，单次清理限量，避免审计写入扩大请求成本。
CREATE TRIGGER IF NOT EXISTS limit_admin_audit AFTER INSERT ON admin_audit_log BEGIN
  DELETE FROM admin_audit_log WHERE id IN (SELECT id FROM admin_audit_log
    WHERE created_at < datetime('now', '-90 days') OR id <= NEW.id - 10000 ORDER BY id LIMIT 100);
END;
CREATE TRIGGER IF NOT EXISTS assign_new_user_rbac AFTER INSERT ON users BEGIN
  INSERT INTO rbac_user_roles (user_id) VALUES (NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS protect_default_rbac_update BEFORE UPDATE ON rbac_roles
WHEN OLD.id = 1 BEGIN SELECT RAISE(ABORT, 'rbac_default_protected'); END;
CREATE TRIGGER IF NOT EXISTS protect_default_rbac_delete BEFORE DELETE ON rbac_roles
WHEN OLD.id = 1 BEGIN SELECT RAISE(ABORT, 'rbac_default_protected'); END;
CREATE TRIGGER IF NOT EXISTS protect_default_rbac_permissions BEFORE INSERT ON rbac_role_permissions
WHEN NEW.role_id = 1 BEGIN SELECT RAISE(ABORT, 'rbac_default_protected'); END;
CREATE TRIGGER IF NOT EXISTS protect_super_rbac_assignment BEFORE UPDATE ON rbac_user_roles
WHEN NEW.role_id != 1 AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND is_super_admin = 1)
BEGIN SELECT RAISE(ABORT, 'rbac_super_group'); END;
CREATE TRIGGER IF NOT EXISTS protect_last_super_update BEFORE UPDATE ON users
WHEN OLD.is_super_admin = 1 AND OLD.deleted_at IS NULL AND OLD.is_disabled = 0
  AND (OLD.disabled_until IS NULL OR OLD.disabled_until <= CURRENT_TIMESTAMP)
  AND (NEW.is_super_admin = 0 OR NEW.deleted_at IS NOT NULL OR NEW.is_disabled = 1 OR NEW.disabled_until > CURRENT_TIMESTAMP)
  AND NOT EXISTS (SELECT 1 FROM users WHERE id != OLD.id AND is_super_admin = 1 AND deleted_at IS NULL
    AND is_disabled = 0 AND (disabled_until IS NULL OR disabled_until <= CURRENT_TIMESTAMP))
BEGIN SELECT RAISE(ABORT, 'rbac_last_super'); END;
CREATE TRIGGER IF NOT EXISTS protect_last_super_delete BEFORE DELETE ON users
WHEN OLD.is_super_admin = 1 AND OLD.deleted_at IS NULL AND OLD.is_disabled = 0
  AND (OLD.disabled_until IS NULL OR OLD.disabled_until <= CURRENT_TIMESTAMP)
  AND NOT EXISTS (SELECT 1 FROM users WHERE id != OLD.id AND is_super_admin = 1 AND deleted_at IS NULL
    AND is_disabled = 0 AND (disabled_until IS NULL OR disabled_until <= CURRENT_TIMESTAMP))
BEGIN SELECT RAISE(ABORT, 'rbac_last_super'); END;

-- 每个用户最多三次登录；数据库自动淘汰最旧记录，避免依赖定时扫描和前端清理。
CREATE TABLE IF NOT EXISTS user_login_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL CHECK(length(ip) <= 64),
  login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT NOT NULL CHECK(length(user_agent) <= 1024),
  login_probe_id TEXT NOT NULL DEFAULT '',
  webrtc_ips TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(webrtc_ips) AND json_type(webrtc_ips) = 'array' AND json_array_length(webrtc_ips) <= 4 AND length(webrtc_ips) <= 193),
  webrtc_status TEXT NOT NULL DEFAULT 'not_run',
  webrtc_checked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_login_info_recent ON user_login_info(user_id, id DESC);
CREATE TRIGGER IF NOT EXISTS limit_user_login_info
AFTER INSERT ON user_login_info
BEGIN
  DELETE FROM user_login_info WHERE user_id = NEW.user_id AND id NOT IN (
    SELECT id FROM user_login_info WHERE user_id = NEW.user_id ORDER BY id DESC LIMIT 3
  );
END;

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  avatar_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
  dm_key TEXT UNIQUE,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  invited_by INTEGER,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (invited_by) REFERENCES users(id)
);

INSERT OR IGNORE INTO channels (name, description, kind, created_by)
VALUES ('general', '', 'public', NULL);

-- schema 可能会重复执行，幂等回填可顺手修复历史账号缺失的 general 成员关系。
INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
SELECT c.id, u.id, 'member', NULL
FROM channels c
CROSS JOIN users u
WHERE c.name = 'general'
  AND c.kind = 'public'
  AND c.deleted_at IS NULL
  AND u.deleted_at IS NULL;

-- 从数据库入口覆盖所有未来的建号路径，防止新入口忘记同步系统群成员关系。
CREATE TRIGGER IF NOT EXISTS add_new_user_to_general
AFTER INSERT ON users
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
  SELECT id, NEW.id, 'member', NULL
  FROM channels
  WHERE name = 'general'
    AND kind = 'public'
    AND deleted_at IS NULL;
END;

-- general 必须永久保留全部成员，数据库层兜底阻止任何遗漏的删除路径破坏不变量。
CREATE TRIGGER IF NOT EXISTS prevent_general_member_removal
BEFORE DELETE ON channel_members
WHEN EXISTS (
  SELECT 1
  FROM channels
	  WHERE id = OLD.channel_id
	    AND name = 'general'
)
  AND EXISTS (
    SELECT 1
    FROM users
    WHERE id = OLD.user_id
      AND deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GENERAL_MEMBERSHIP_REQUIRED');
END;

-- 名称、公开属性和存活状态共同标识系统群，禁止绕过 API 改名、转私有或软删除。
CREATE TRIGGER IF NOT EXISTS protect_general_channel
BEFORE UPDATE OF name, kind, deleted_at ON channels
WHEN OLD.name = 'general'
  AND (
    NEW.name != 'general'
    OR NEW.kind != 'public'
    OR NEW.deleted_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GENERAL_CHANNEL_REQUIRED');
END;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  sender_id INTEGER,
  content TEXT NOT NULL DEFAULT '',
  attachment_key TEXT,
  attachment_name TEXT,
  attachment_type TEXT,
  attachment_size INTEGER,
  attachment_kind TEXT CHECK (attachment_kind IS NULL OR attachment_kind IN ('voice', 'audio')),
  attachment_duration_ms INTEGER,
  attachment_waveform TEXT,
  sender_kind TEXT NOT NULL DEFAULT 'local' CHECK (sender_kind IN ('local', 'external')),
  external_sender_id TEXT,
  external_sender_name TEXT,
  external_sender_avatar_url TEXT,
  source TEXT NOT NULL DEFAULT 'edgechat',
  source_message_id TEXT,
  source_attachment_id TEXT,
  source_attachment_unique_id TEXT,
  client_message_id TEXT,
  mention_user_ids TEXT NOT NULL DEFAULT '[]',
  reply_to_message_id INTEGER,
  reply_to_sender_id INTEGER,
  bridge_binding_id TEXT,
  bridge_event_id TEXT,
  bridge_sent_at INTEGER,
  source_instance TEXT,
  bridge_target_revision INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  CHECK (
    (sender_kind = 'local' AND sender_id IS NOT NULL)
    OR (sender_kind = 'external' AND sender_id IS NULL)
  ),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_pins (
  channel_id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE,
  pinned_by INTEGER,
  pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS message_reads (
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS site_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registration_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_by INTEGER,
  consumed_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (consumed_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS registration_invite_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_id INTEGER NOT NULL,
  user_id INTEGER,
  used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (invite_id, user_id),
  FOREIGN KEY (invite_id) REFERENCES registration_invites(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 校验和计数必须留在数据库事务内，防止并发注册同时消耗最后一次额度。
CREATE TRIGGER IF NOT EXISTS validate_registration_invite_use
BEFORE INSERT ON registration_invite_uses
BEGIN
  SELECT CASE
    WHEN NEW.user_id IS NULL THEN RAISE(ABORT, 'REGISTRATION_INVITE_USER_REQUIRED')
    WHEN NOT EXISTS (
      SELECT 1
      FROM registration_invites
      WHERE id = NEW.invite_id
        AND deleted_at IS NULL
        AND used_count < max_uses
    ) THEN RAISE(ABORT, 'REGISTRATION_INVITE_UNAVAILABLE')
  END;
END;

CREATE TRIGGER IF NOT EXISTS consume_registration_invite_use
AFTER INSERT ON registration_invite_uses
BEGIN
  UPDATE registration_invites
  SET used_count = used_count + 1,
      consumed_by_user_id = NEW.user_id,
      consumed_at = CASE
        WHEN used_count + 1 >= max_uses THEN CURRENT_TIMESTAMP
        ELSE NULL
      END
  WHERE id = NEW.invite_id;
END;

CREATE TABLE IF NOT EXISTS uploaded_files (
  object_key TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  client_upload_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  installation_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  refresh_token_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS realtime_tickets (
  token_hash TEXT PRIMARY KEY,
  access_token_ciphertext TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_session_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('room', 'inbox')),
  room_kind TEXT CHECK (room_kind IN ('public', 'private', 'dm')),
  room_id INTEGER,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_session_id) REFERENCES device_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_event_compaction (
  channel_id INTEGER PRIMARY KEY,
  compacted_through INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

-- 由数据库在消息写入事务内生成同步游标，HTTP 与 WebSocket 两条提交入口不会产生不同步的事件。
CREATE TRIGGER IF NOT EXISTS record_message_created_event
AFTER INSERT ON messages
BEGIN
  INSERT INTO message_events (channel_id, message_id, event_type)
  VALUES (NEW.channel_id, NEW.id, 'created');
END;

CREATE TRIGGER IF NOT EXISTS record_message_deleted_event
AFTER UPDATE OF deleted_at ON messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT INTO message_events (channel_id, message_id, event_type)
  VALUES (NEW.channel_id, NEW.id, 'deleted');
END;

-- 软删除后立即移除置顶引用；消息保留期仍由 GC 独立决定，不因置顶而延长。
CREATE TRIGGER IF NOT EXISTS clear_pin_after_message_soft_delete
AFTER UPDATE OF deleted_at ON messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM channel_pins WHERE message_id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS pending_r2_delete (
  object_key TEXT PRIMARY KEY,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- GC 按创建时间分页，并对仍在使用的附件和头像执行点查。
CREATE INDEX IF NOT EXISTS idx_gc_uploaded_created
ON uploaded_files(created_at, object_key);

CREATE INDEX IF NOT EXISTS idx_gc_message_attachment
ON messages(attachment_key)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gc_user_avatar
ON users(avatar_key)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gc_channel_avatar
ON channels(avatar_key)
WHERE deleted_at IS NULL;

-- 本地引用必须在写入瞬间仍有上传登记且未进入清理；外部 Bridge 附件没有本地上传归属，仅拦截 pending。
CREATE TRIGGER IF NOT EXISTS prevent_pending_message_attachment_insert
BEFORE INSERT ON messages
WHEN NEW.attachment_key IS NOT NULL
  AND (
    (
      NEW.sender_kind = 'local'
      AND NOT EXISTS (
        SELECT 1
        FROM uploaded_files
        WHERE object_key = NEW.attachment_key
          AND owner_user_id = NEW.sender_id
          AND NOT EXISTS (
            SELECT 1 FROM pending_r2_delete
            WHERE pending_r2_delete.object_key = uploaded_files.object_key
          )
      )
    )
    OR (
      NEW.sender_kind = 'external'
      AND EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE object_key = NEW.attachment_key
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_message_attachment_update
BEFORE UPDATE OF attachment_key ON messages
WHEN NEW.attachment_key IS NOT NULL
  AND (
    (
      NEW.sender_kind = 'local'
      AND NOT EXISTS (
        SELECT 1
        FROM uploaded_files
        WHERE object_key = NEW.attachment_key
          AND owner_user_id = NEW.sender_id
          AND NOT EXISTS (
            SELECT 1 FROM pending_r2_delete
            WHERE pending_r2_delete.object_key = uploaded_files.object_key
          )
      )
    )
    OR (
      NEW.sender_kind = 'external'
      AND EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE object_key = NEW.attachment_key
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_user_avatar_insert
BEFORE INSERT ON users
WHEN NEW.avatar_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = NEW.avatar_key
      AND owner_user_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_user_avatar_update
BEFORE UPDATE OF avatar_key ON users
WHEN NEW.avatar_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = NEW.avatar_key
      AND owner_user_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_channel_avatar_insert
BEFORE INSERT ON channels
WHEN NEW.avatar_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = NEW.avatar_key
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_channel_avatar_update
BEFORE UPDATE OF avatar_key ON channels
WHEN NEW.avatar_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = NEW.avatar_key
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_site_icon_insert
BEFORE INSERT ON site_settings
WHEN NEW.setting_key = 'site_icon_url'
  AND NEW.setting_value GLOB 'r2:*'
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = substr(NEW.setting_value, 4)
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_site_icon_update
BEFORE UPDATE OF setting_value ON site_settings
WHEN NEW.setting_key = 'site_icon_url'
  AND NEW.setting_value GLOB 'r2:*'
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = substr(NEW.setting_value, 4)
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TABLE IF NOT EXISTS telegram_bridge_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_token_ciphertext TEXT NOT NULL,
  webhook_secret_ciphertext TEXT NOT NULL,
  bot_username TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS telegram_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL UNIQUE,
  telegram_chat_title TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS telegram_notification_users (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_chat_id TEXT UNIQUE,
  telegram_name TEXT NOT NULL DEFAULT '',
  pending_token_hash TEXT UNIQUE,
  pending_expires_at TEXT,
  dm_enabled INTEGER NOT NULL DEFAULT 1 CHECK (dm_enabled IN (0, 1)),
  mention_enabled INTEGER NOT NULL DEFAULT 1 CHECK (mention_enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  next_notification_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'
);

CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  channel_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'mention')),
  room_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_notification_due ON telegram_notification_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_telegram_notification_sender ON telegram_notification_outbox(sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_notification_recipient ON telegram_notification_outbox(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_notification_created ON telegram_notification_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_notification_message ON telegram_notification_outbox(channel_id, message_id);
CREATE TABLE IF NOT EXISTS telegram_notification_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_send_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'
);
INSERT OR IGNORE INTO telegram_notification_gate (id) VALUES (1);

-- 期一增项：文本回复链任务记录（一条用户消息只回一次，幂等键 trigger_message_id）
CREATE TABLE IF NOT EXISTS ai_reply_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  trigger_message_id INTEGER NOT NULL UNIQUE,
  recipient_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  replied_message_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_recipient
  ON ai_reply_jobs(recipient_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_status
  ON ai_reply_jobs(status, created_at);

-- TASK-133：Chat 版记忆 A 方案（每用户 SAG 试用号台账 + 文本会话结算记录）
CREATE TABLE IF NOT EXISTS user_memory_accounts (
  user_id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE,
  customer_id TEXT,
  sag_token_cipher TEXT,
  token_key_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'failed')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_memory_accounts_status
  ON user_memory_accounts(status, updated_at);

CREATE TABLE IF NOT EXISTS text_session_reports (
  room_id INTEGER NOT NULL,
  last_message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reported', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  pi_status INTEGER,
  reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempt_at TEXT,
  PRIMARY KEY (room_id, last_message_id)
);

CREATE INDEX IF NOT EXISTS idx_text_session_reports_user
  ON text_session_reports(user_id, reported_at);

-- [打招呼制社交 2026-11-01] 默认互不可见；打招呼→点头→互见可聊（迁移 2026-11-01-greet-contacts）
CREATE TABLE IF NOT EXISTS greet_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'declined')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_greet_pending_by_to
  ON greet_requests(to_user, status);
CREATE INDEX IF NOT EXISTS idx_greet_by_from
  ON greet_requests(from_user, status);

CREATE TABLE IF NOT EXISTS greet_contacts (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  established_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);

INSERT OR IGNORE INTO site_settings (setting_key, setting_value)
VALUES ('site_name', 'Edgechat');

INSERT OR IGNORE INTO site_settings (setting_key, setting_value)
VALUES ('site_icon_url', '');

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages(channel_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages(sender_id, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_source
  ON messages(source, source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_client_message
ON messages(channel_id, sender_id, client_message_id)
WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_reply_attention
ON messages(channel_id, reply_to_sender_id, id)
WHERE reply_to_sender_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_reads_user
  ON message_reads(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_channels_kind
  ON channels(kind, id DESC);

CREATE INDEX IF NOT EXISTS idx_users_username
  ON users(username);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
  ON user_blocks(blocked_id, blocker_id);

CREATE INDEX IF NOT EXISTS idx_registration_invites_active
  ON registration_invites(created_at DESC, deleted_at, consumed_at);

CREATE INDEX IF NOT EXISTS idx_registration_invites_usage
  ON registration_invites(deleted_at, used_count, max_uses, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_registration_invite_uses_invite
  ON registration_invite_uses(invite_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_r2_delete_next_retry
  ON pending_r2_delete(next_retry_at, retry_count);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_owner
  ON uploaded_files(owner_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_files_client_upload
  ON uploaded_files(owner_user_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_refresh_token
  ON device_sessions(refresh_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_user_installation_active
  ON device_sessions(user_id, installation_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_sessions_user_active
  ON device_sessions(user_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_realtime_tickets_expiry
  ON realtime_tickets(expires_at, consumed_at);

CREATE INDEX IF NOT EXISTS idx_message_events_channel_sequence
  ON message_events(channel_id, sequence);

CREATE INDEX IF NOT EXISTS idx_telegram_mappings_channel
  ON telegram_mappings(channel_id, enabled, id);

CREATE TABLE IF NOT EXISTS bridge_instance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instance_bindings (
  id TEXT PRIMARY KEY,
  channel_id INTEGER NOT NULL,
  channel_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('inviter', 'joiner')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'claiming', 'pending', 'activating', 'active', 'revoked')),
  secret TEXT NOT NULL,
  invitation_secret TEXT NOT NULL DEFAULT '',
  peer_instance_id TEXT,
  peer_origin TEXT,
  peer_channel_id INTEGER,
  peer_channel_name TEXT,
  claim_id TEXT,
  expires_at INTEGER NOT NULL,
  local_paused INTEGER NOT NULL DEFAULT 0 CHECK (local_paused IN (0, 1)),
  peer_paused INTEGER NOT NULL DEFAULT 0 CHECK (peer_paused IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0,
  peer_revision INTEGER NOT NULL DEFAULT -1,
  control_pending INTEGER NOT NULL DEFAULT 0,
  control_attempts INTEGER NOT NULL DEFAULT 0,
  control_next_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_error TEXT,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  discarded_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instance_bindings_channel
  ON instance_bindings(channel_id) WHERE status != 'revoked';
CREATE INDEX IF NOT EXISTS idx_instance_bindings_control
  ON instance_bindings(control_next_at) WHERE control_pending = 1;

CREATE TRIGGER IF NOT EXISTS validate_instance_binding_group
BEFORE INSERT ON instance_bindings
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM channels
    WHERE id = NEW.channel_id AND kind IN ('public', 'private') AND deleted_at IS NULL)
    THEN RAISE(ABORT, 'BRIDGE_GROUP_REQUIRED') END;
END;

CREATE TABLE IF NOT EXISTS bridge_outbox (
  binding_id TEXT NOT NULL REFERENCES instance_bindings(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  target_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL DEFAULT ((unixepoch() + 86400) * 1000),
  next_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (binding_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_bridge_outbox_due ON bridge_outbox(next_at, binding_id);

CREATE TABLE IF NOT EXISTS bridge_receipts (
  binding_id TEXT NOT NULL REFERENCES instance_bindings(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_bridge_receipts_expiry ON bridge_receipts(expires_at);

-- 在真实 INSERT 事务内登记，HTTP/WS/移动 API 都不会遗漏，也不会把旧历史补入队列。
CREATE TRIGGER IF NOT EXISTS enqueue_instance_bridge_message
AFTER INSERT ON messages
WHEN NEW.sender_kind = 'local' AND NEW.source = 'edgechat'
  AND NEW.attachment_key IS NULL AND NEW.deleted_at IS NULL
BEGIN
  UPDATE instance_bindings SET discarded_count = discarded_count + 1, last_error = 'queue_full'
  WHERE channel_id = NEW.channel_id AND status = 'active' AND local_paused = 0 AND peer_paused = 0
    AND (SELECT COUNT(*) FROM bridge_outbox WHERE binding_id = instance_bindings.id) >= 1000;
  INSERT INTO bridge_outbox (binding_id, event_id, message_id, sender_id, sender_name, content, target_revision)
  SELECT b.id, lower(hex(randomblob(16))), NEW.id, NEW.sender_id, u.display_name, NEW.content, b.peer_revision
  FROM instance_bindings b JOIN users u ON u.id = NEW.sender_id
  WHERE b.channel_id = NEW.channel_id AND b.status = 'active' AND b.local_paused = 0 AND b.peer_paused = 0
    AND (SELECT COUNT(*) FROM bridge_outbox WHERE binding_id = b.id) < 1000;
END;

-- 接收资格与 receipt 在消息事务中确认，封堵暂停/解绑/重复请求的先查后写竞态。
CREATE TRIGGER IF NOT EXISTS validate_instance_bridge_message
BEFORE INSERT ON messages WHEN NEW.source = 'instance-bridge'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM instance_bindings b JOIN channels c ON c.id = b.channel_id
    WHERE b.id = NEW.bridge_binding_id AND b.channel_id = NEW.channel_id
      AND b.status = 'active' AND b.local_paused = 0 AND b.peer_paused = 0
      AND c.deleted_at IS NULL AND c.kind IN ('public', 'private')
      AND NEW.sender_kind = 'external' AND NEW.attachment_key IS NULL
      AND NEW.bridge_event_id IS NOT NULL
      AND NEW.bridge_target_revision = b.revision
      AND NEW.bridge_sent_at BETWEEN (unixepoch() - 86400) * 1000 AND (unixepoch() + 300) * 1000
  ) THEN RAISE(ABORT, 'BRIDGE_NOT_RECEIVING') END;
  INSERT INTO bridge_receipts (binding_id, event_id, expires_at)
  VALUES (NEW.bridge_binding_id, NEW.bridge_event_id, NEW.bridge_sent_at + 172800000);
END;

-- generation 变更与清空积压同事务；并发重复控制不能再清掉之后产生的新消息。
CREATE TRIGGER IF NOT EXISTS cancel_instance_bridge_generation
AFTER UPDATE OF revision, peer_revision, status ON instance_bindings
WHEN NEW.revision != OLD.revision OR NEW.peer_revision != OLD.peer_revision OR NEW.status = 'revoked'
BEGIN
  UPDATE instance_bindings SET discarded_count = discarded_count +
    (SELECT COUNT(*) FROM bridge_outbox WHERE binding_id = NEW.id) WHERE id = NEW.id;
  DELETE FROM bridge_outbox WHERE binding_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS cancel_instance_bridge_deleted_message
AFTER UPDATE OF deleted_at ON messages WHEN NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE instance_bindings SET discarded_count = discarded_count + 1
    WHERE id IN (SELECT binding_id FROM bridge_outbox WHERE message_id = NEW.id);
  DELETE FROM bridge_outbox WHERE message_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS count_instance_bridge_deleted_message
BEFORE DELETE ON messages
BEGIN
  UPDATE instance_bindings SET discarded_count = discarded_count + 1
    WHERE id IN (SELECT binding_id FROM bridge_outbox WHERE message_id = OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS revoke_instance_bridge_deleted_channel
BEFORE DELETE ON channels
BEGIN
  UPDATE instance_bindings
  SET status = 'revoked', revision = revision + 1, control_pending = (peer_origin IS NOT NULL),
    control_next_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
  WHERE channel_id = OLD.id AND status != 'revoked';
  DELETE FROM bridge_outbox WHERE binding_id IN (SELECT id FROM instance_bindings WHERE channel_id = OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS revoke_instance_bridge_soft_deleted_channel
AFTER UPDATE OF deleted_at, kind ON channels
WHEN NEW.deleted_at IS NOT NULL OR NEW.kind = 'dm'
BEGIN
  UPDATE instance_bindings
  SET status = 'revoked', revision = revision + 1, control_pending = (peer_origin IS NOT NULL),
    control_next_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
  WHERE channel_id = NEW.id AND status != 'revoked';
  DELETE FROM bridge_outbox WHERE binding_id IN (SELECT id FROM instance_bindings WHERE channel_id = NEW.id);
END;
