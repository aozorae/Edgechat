# 用户组与后台权限（2.14.1）

用户组是后台权限组，与聊天群组无关。首版每人一组，无继承、叠加或个人授权。固定普通组无后台权限，新建和邀请注册默认进入普通组。超管身份来自独立 `users.is_super_admin`，组名或全选权限不能产生超管。

## 使用与边界

超管在「用户组与权限」创建组，按模块勾选权限，再从用户列表或组成员页分配账号；创建用户也可直接选组。勾选写权限自动带上读取依赖，取消读取同时取消依赖操作。组可停用，停用只撤销后台能力，不封禁聊天。有成员（含软删除账号）的组不能删除，先迁移成员。

子管理员仅能管理未受保护的普通账号，不能重置他人密码、修改登录身份、分组或安全配置。曾任管理员的账号降回普通组仍受保护，超管可明确解除保护。最后一名有效超管不能被删除、永久/临时封禁或降级；后台禁止自我删除/封禁。

用户组修改与成员分配使用版本冲突检测，409 时刷新后重新确认，不自动覆盖。撤权不自动销毁既有邀请与桥接，分组成功会提示剩余资源，超管需另行复核。

**单独的产品变化**：后台身份不再赋予读取非成员私有群/私信、下载其中附件、群管理或置顶/删除消息的能力，HTTP、v1 和旧 WebSocket 均按真实成员/群主判断。公开资源沿用原规则。子管理员桥接须为群主；超管保留之前的全站桥接操作，没有同时引入“超管也必须群主”的新要求。部署者及能恢复账号的超管仍在信任边界内，不承诺端到端保密。

## 维护入口

- `shared/admin-permissions.ts`：21 个稳定权限 key、名称、说明、依赖和风险；前后端共用。全选保存明确 key，升级新增权限不会自动加入旧组。
- `worker/src/rbac/policies.ts`：接口 method/path、所需全部权限、字段白名单与目标范围；未知后台路由默认拒绝，测试核验路由覆盖。
- `worker/src/rbac/authorization.ts`：权威快照、统一范围与 `runAuthorizedBatch`；既有数据层通过 `authorizedDatabase` 复用事务授权，不各写一套规则。
- `frontend/src/authorization.ts`：页面与目录权限关联；按钮使用同一 key，模块只发起已授权请求。

新增功能只需登记目录权限、接口策略（包括字段与范围）、页面/按钮关联和对应测试。不增加旧 `isAdmin` 兜底。兼容 `isAdmin/is_admin` 只代表超管，子管理员入口使用 `canAccessAdmin`。

后台每请求从 D1 主库读取最新身份/组/权限，只在请求内复用，不缓存跨请求的允许决策。写入同一个 D1 batch 内以约束失败中止整批，业务、版本和审计原子提交。普通聊天不加载后台权限集合。通知最多唤醒 100 个组成员，漏通知时仍由服务端拒绝，前端在恢复前台/403/切换路由时刷新。

撤权提交后开始的授权检查会拒绝已撤能力；写事务也复验。已完成响应无法收回。Telegram 等外部网络副作用不属于 D1 事务，先接受意图并记录审计，网络失败沿用业务错误/补偿；已持久接受任务不保证因随后撤权而取消。存储扫描每页 1000、最多 100 页、每账号每分钟一次开始；超过上限本轮不发布完整快照。审计不保存凭据/正文，无网页删除入口；追加时最多清理 100 条，保留最近 90 天且最多约 10000 条，过期积压渐进淘汰。

## 升级与恢复

新安装尚无任何账号时，先完成[首次管理员初始化](admin-bootstrap.md)，不要使用已有账号恢复工具代替首次创建。没有默认管理员密码，`ADMIN_USERNAMES` 不能创建账号。

发布前备份 D1，核对旧 `is_admin=1` 账号和有效状态。公开基线该字段只代表全权管理员；若自行改造过子管理员，必须先自行辨别，不能直接运行本映射。迁移保留封禁、删除、密码和业务数据，不自动解封。

GitHub Actions 沿用 `prepare-d1-migrations.mjs` 规划、执行及 `--verify`，先迁移再发布。新装由全量 schema 初始化并登记基线；旧实例执行 `2026-10-06-rbac` 一次。**不要直接重复执行原始 ALTER SQL**，迁移 ledger/checksum 负责幂等，重复部署不会从旧标记重新提权，也不会覆盖已配置权限。无新增资源/Secret，不修改 Android。

手动部署使用已有环境中的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`EDGECHAT_D1_DATABASE_ID`：

```bash
npx wrangler d1 export cfchat-db --remote --output .tmp/rbac-backup.sql
node .github/scripts/prepare-d1-migrations.mjs
npx wrangler d1 execute cfchat-db --remote --file .tmp/edgechat-d1-migrations.sql
node .github/scripts/prepare-d1-migrations.mjs --verify
npm run deploy
```

手动管理员初始化只在账号不存在时创建。Actions 从 `2.20.2` 起会以当前 `EDGECHAT_ADMIN_PASSWORD` Secret 同步同名有效超管密码；忘记密码时更新 Secret 并重新运行部署即可，详见[管理员密码恢复](admin-bootstrap.md)。不会自动提权、解封或恢复已删除账号。需要恢复身份或账号状态时，部署者先备份并确认恢复目标为自己的账号，通过环境变量提供已有用户 ID 和新密码：

```bash
node .github/scripts/generate-admin-recovery-sql.mjs --confirm-super-admin-recovery
npx wrangler d1 execute cfchat-db --remote --file .tmp/edgechat-admin-recovery.sql
```

工具读取 `EDGECHAT_RECOVER_USER_ID` 与 `EDGECHAT_RECOVER_PASSWORD`，只生成本地 SQL，不自动部署；显式执行会恢复该账号为超管、普通组、可登录状态，并使旧会话失效及写审计。不要在网页或普通 CI 自动执行恢复工具。不要把密码或部署 Token 写入源码/配置，生成物仅放 gitignore 的 `.tmp`。

紧急止损可由超管停用管理组。优先前向修复；不要回退至不理解 RBAC 的旧代码，它会恢复旧聊天管理员放行语义。

首版按产品收敛后置批量分组、复制组、独立权限预览与二次密码验证；基础组管理、单用户分配、即时撤权和审计已实现。

`2.14.1` 的扫描入口为 `POST /api/admin/storage/scan`（空 JSON body，游标仍用 query），以保证快照写入沿用 Cookie 同源校验；旧 GET 入口拒绝。后台错误响应也使用 `private, no-store`。该补丁无新迁移。
