-- 2026-10-26 TASK-133：Chat 版记忆接入 A 方案（每用户 SAG 试用号台账 + 文本会话结算记录）
-- 幂等说明：只建新表与索引，可重复执行；回滚=停用后保留表，不涉及存量表。
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

-- 文本会话结算记录：一条 (room_id, last_message_id) 只结算一次，防重复上报
CREATE TABLE IF NOT EXISTS text_session_reports (
  room_id INTEGER NOT NULL,
  last_message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  pi_status INTEGER,
  reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, last_message_id)
);

CREATE INDEX IF NOT EXISTS idx_text_session_reports_user
  ON text_session_reports(user_id, reported_at);
