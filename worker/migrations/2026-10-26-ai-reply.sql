-- 2026-10-26 期一增项：文本回复链（笨笨能回话）任务记录表
-- 幂等说明：本迁移只建新表与索引，可重复执行（CREATE ... IF NOT EXISTS）。
-- 不修改任何存量表结构；回滚 = 保留空表不删（代码停用后无副作用）。
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

-- AI 回复开关默认值（缺失时服务端按默认 true 处理，这里显式落库便于后台展示）
INSERT OR IGNORE INTO site_settings (setting_key, setting_value) VALUES ('aiReply.enabled', '1');
