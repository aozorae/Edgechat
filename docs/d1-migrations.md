# D1 初始化与升级 / D1 Initialization and Upgrades

## 中文

**新安装与旧库升级是两条路径，不是连续执行的两个步骤。** 使用 Node.js 24，在项目根目录执行 `npm ci`，并确认 `wrangler.toml` 的 `DB` 指向网站实际使用的数据库。

- 全新空库：只执行一次完整 schema，之后通过下方规划流程登记迁移基线，再[初始化管理员](admin-bootstrap.md)。schema 不创建账号。
- 已有数据库：先备份，再使用下方规划流程升级。不要用全量 schema 代替增量升级，也不要手动逐个执行 `worker/migrations/*.sql`。
- GitHub Actions 已自动完成初始化、规划、执行和校验，不需要额外手动执行 SQL。

仅全新空库执行：

```bash
npx wrangler d1 execute DB --remote --config wrangler.toml --file worker/schema.sql
```

规划、应用和校验（新库登记基线，旧库只执行适用迁移）：

先设置自己的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`EDGECHAT_D1_DATABASE_ID` 环境变量。数据库 ID 必须与 `wrangler.toml` 的 `DB` binding 一致；规划脚本直接调用 Cloudflare API，不使用 Wrangler 登录状态。Token 需要目标 D1 的读取和写入权限，不要写入源码或配置文件。

```bash
node .github/scripts/prepare-d1-migrations.mjs
npx wrangler d1 execute DB --remote --config wrangler.toml --file .tmp/edgechat-d1-migrations.sql
node .github/scripts/prepare-d1-migrations.mjs --verify
```

**逐条执行，仅在上一条成功后继续。** 规划脚本只读取数据库并生成本地 SQL；只有 `wrangler d1 execute` 会应用计划。完整 schema 对应 `baseline`，已登记迁移对应 `skip`。规划或验证失败时停止发布，不要修改 ledger、删除触发器或强行重跑历史 SQL。

### schema 后误执行历史迁移

`2026-04-05-private-groups.sql` 用于旧版 channels 表升级，包含删除并重建表的语句。最新版 schema 已包含这次升级；重放时可能出现 `error in trigger add_new_user_to_general: no such table: main.channels`，即使绕过触发器也会遇到重复字段等问题。

先停止后续 SQL，保留完整错误日志，执行只读查询并把结果提供给维护者：

```bash
npx wrangler d1 execute DB --remote --config wrangler.toml --command "SELECT type,name FROM sqlite_master WHERE name IN ('channels','channels_new','add_new_user_to_general'); PRAGMA table_info(channels); PRAGMA table_info(channel_members);"
```

不能仅凭报错判断已全部回滚或数据已损坏。未确认实际表结构和备份前，不要清库、删除触发器、重跑 schema 或重命名临时表；旧迁移的临时表不一定包含最新版全部字段。

## English

**Fresh installation and upgrading an existing database are alternative paths, not consecutive steps.** Use Node.js 24, run `npm ci` from the repository root, and confirm that `DB` in `wrangler.toml` points to the website's actual database.

- Empty database: apply `worker/schema.sql` once using the first command above, run the planning/apply/verify commands to record the baseline, then [initialize an administrator](admin-bootstrap.md). The schema does not create accounts.
- Existing database: back up first, then use the planning/apply/verify commands. Do not replace incremental upgrades with the full schema or manually replay `worker/migrations/*.sql`.
- GitHub Actions already handles initialization, planning, application and verification. No extra manual SQL is required.

For the planner, set your own `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EDGECHAT_D1_DATABASE_ID` environment variables. The database ID must match the `DB` binding. The planner calls Cloudflare's API directly, not Wrangler's login session. The token needs read/write access to the target D1; never put it in source or configuration files.

Run each command separately and continue only after success. Planning only reads D1 and writes a local SQL file; `wrangler d1 execute` applies it. A complete schema produces `baseline` decisions; recorded migrations produce `skip`. Stop deployment if planning or verification fails. Do not edit the ledger, remove triggers or force historical SQL to run.

If replaying `2026-04-05-private-groups.sql` after the full schema reports `error in trigger add_new_user_to_general: no such table: main.channels`, stop further SQL and send the read-only query results above and the error log to the maintainer. This old migration rebuilds `channels`; it is not intended for the current schema. The error alone proves neither full rollback nor data loss. Do not reset the database, remove triggers, rerun the schema or rename temporary tables without checking the actual structure and backups. Historical temporary tables may lack current columns.
