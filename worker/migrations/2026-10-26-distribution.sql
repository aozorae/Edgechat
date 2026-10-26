-- 2026-10-26 期一：分发制「邀请人」字段 + 分发总开关
-- 幂等说明：迁移按清单只执行一次；ALTER 不可重入，勿在 schema.sql 重复执行此文件。
ALTER TABLE users ADD COLUMN invited_by INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN invited_at TEXT;

CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by);

-- 存量回填：通过注册链接注册的用户，邀请人 = 该链接的创建人，邀请时间取该用户注册时间
-- （registration_invites.consumed_at 在多次可用链接上可能为空，回退链接创建时间；再回退用户创建时间）
UPDATE users
SET invited_by = (
  SELECT ri.created_by
  FROM registration_invites ri
  WHERE ri.id = users.registration_invite_id
),
invited_at = COALESCE(
  (SELECT COALESCE(ri.consumed_at, ri.created_at)
   FROM registration_invites ri
   WHERE ri.id = users.registration_invite_id),
  users.created_at
)
WHERE invited_by IS NULL
  AND registration_invite_id IS NOT NULL;

-- 期一开关默认值（缺失时服务端按默认 true 处理，这里显式落库便于后台管理页展示）
INSERT OR IGNORE INTO site_settings (setting_key, setting_value) VALUES ('distribution.gateEnabled', '1');
INSERT OR IGNORE INTO site_settings (setting_key, setting_value) VALUES ('distribution.treeVisible', '1');
