-- 保持最后消息时间的 MAX(created_at) 语义，同时让列表查询走存活消息索引。
CREATE INDEX IF NOT EXISTS idx_messages_channel_live_time
  ON messages(channel_id, created_at DESC) WHERE deleted_at IS NULL;
