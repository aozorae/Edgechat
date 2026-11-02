-- 每个绑定账号仅保留一个短时回复目标，不保存消息正文；解绑和重新绑定均撤销旧提示。
CREATE TABLE IF NOT EXISTS telegram_dm_prompts (
  user_id INTEGER PRIMARY KEY REFERENCES telegram_notification_users(user_id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  prompt_message_id INTEGER NOT NULL,
  request_message_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS clear_telegram_prompt_after_rebind
AFTER UPDATE OF telegram_chat_id ON telegram_notification_users
BEGIN
  DELETE FROM telegram_dm_prompts WHERE user_id = NEW.user_id;
END;
