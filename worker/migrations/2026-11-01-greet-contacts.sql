-- [打招呼制社交] 2026-11-01 老板拍板：默认互不可见，凭用户名发打招呼、对方点头才互见可聊。
CREATE TABLE IF NOT EXISTS greet_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending / accepted / declined
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_greet_pending_by_to ON greet_requests(to_user, status);
CREATE INDEX IF NOT EXISTS idx_greet_by_from ON greet_requests(from_user, status);

-- 互认关系（a<b 存一对）
CREATE TABLE IF NOT EXISTS greet_contacts (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  established_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
