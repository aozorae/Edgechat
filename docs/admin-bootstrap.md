# 首次管理员初始化 / First Administrator Setup

## 中文

**没有默认管理员密码，也没有公开注册入口。** `worker/schema.sql` 只创建数据库结构，不创建用户。`ADMIN_USERNAMES` 仅保留管理员用户名，不能创建账号或设置密码。管理员登录后，在「注册邀请」创建用户或生成邀请链接，其他用户才能注册。

### GitHub Actions 部署

在自己的仓库 `Settings -> Secrets and variables -> Actions -> Secrets` 添加：

| Repository Secret | 填写内容 |
| --- | --- |
| `EDGECHAT_ADMIN_USERNAME` | 自己选择的管理员用户名，例如 `admin` |
| `EDGECHAT_ADMIN_PASSWORD` | 自己设置的强密码，没有系统默认值 |
| `EDGECHAT_ADMIN_DISPLAY_NAME` | 可选显示名，默认使用用户名 |

旧的 `CFCHAT_ADMIN_*` 名称仍兼容，新名称优先。重新运行 `Actions -> 00 Deploy Worker -> Run workflow`，账号初始化成功后，使用上述用户名和密码登录。首次漏配无需重新建库或重复导入 schema。

已有可登录超管时，更新不要求再次提供初始化凭据。只配置用户名或密码其中一项会报错；初始化后仍无有效超管，也会停止发布并给出配置提示。

### 手动部署：SQL 已执行，但无法首次登录

需要 Node.js 24、已执行 `npm ci`，并已用 `wrangler.example.toml` 准备好自己的 `wrangler.toml`，其中 `DB` 必须指向网站实际绑定的 D1。先按 [D1 初始化与升级](d1-migrations.md) 完成数据库准备，再初始化账号：新装执行完整 schema 后只登记基线，不要再逐个执行历史迁移；旧库通过规划脚本升级。Wrangler 使用自己的 Cloudflare 登录或 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 环境变量。

在项目根目录执行。密码通过终端输入，不写进源码、配置或命令历史。

**PowerShell：**

```powershell
$env:EDGECHAT_ADMIN_USERNAME = 'admin'
$env:EDGECHAT_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host '设置管理员密码' -AsSecureString)).Password
npm run admin:bootstrap
$bootstrapExit = $LASTEXITCODE
Remove-Item Env:EDGECHAT_ADMIN_PASSWORD
if ($bootstrapExit -ne 0) { throw '管理员 SQL 生成失败，停止执行' }
# 仅在上一步成功后执行；DB 是 wrangler.toml 中的数据库 binding。
npx wrangler d1 execute DB --remote --config wrangler.toml --file .tmp/edgechat-admin-upsert.sql
```

**Bash / macOS / Linux：**

```bash
export EDGECHAT_ADMIN_USERNAME=admin
read -r -s -p 'Set administrator password: ' EDGECHAT_ADMIN_PASSWORD
export EDGECHAT_ADMIN_PASSWORD
if npm run admin:bootstrap; then
  unset EDGECHAT_ADMIN_PASSWORD
  # 确认配置指向网站使用的 D1。
  npx wrangler d1 execute DB --remote --config wrangler.toml --file .tmp/edgechat-admin-upsert.sql
else
  unset EDGECHAT_ADMIN_PASSWORD
fi
```

`npm run admin:bootstrap` **只生成 SQL，不修改数据库**。生成物在 gitignore 的 `.tmp`，只含密码哈希和随机盐，不含明文密码；执行成功后可删除这个 SQL 文件。线上数据库用 `--remote`；本地 `wrangler dev --local` 用 `--local`，不要混用。

网站已部署时，执行管理员 SQL 后即可登录，无需再次发布 Worker。尚未部署则继续 `npm run deploy`。用户名和密码必须与生成 SQL 时填写的值一致。

### 已有同名账号或忘记密码

初始化脚本**只创建不存在的账号**，重复运行不会重置密码、授予已有普通账号超管身份、解封或恢复已删除账号。修改 Repository Secret 也不会修改已有账号密码。忘记密码或同名普通账号已存在时，请按 [显式超管恢复说明](rbac.md#升级与恢复) 先备份并确认目标，再执行恢复工具；不要清空数据库或开放匿名初始化接口。

## English

**There is no default administrator password and no public sign-up.** `worker/schema.sql` creates tables, not accounts. `ADMIN_USERNAMES` only reserves names; it cannot create an account or set its password. After signing in, an administrator creates users or registration invitation links in the admin panel.

### GitHub Actions

Add `EDGECHAT_ADMIN_USERNAME` (your chosen name, such as `admin`) and `EDGECHAT_ADMIN_PASSWORD` (your own strong password) as Repository Secrets under `Settings -> Secrets and variables -> Actions -> Secrets`. `EDGECHAT_ADMIN_DISPLAY_NAME` is optional. Legacy `CFCHAT_ADMIN_*` names remain supported; new names take precedence.

Run `Actions -> 00 Deploy Worker -> Run workflow` again, then sign in with these credentials. Missing initial credentials do not require recreating the database. Later updates can omit them if an active super administrator already exists. Providing only one credential, or having no active super administrator after initialization, stops deployment with an actionable error.

### Manual Deployment

Use Node.js 24 and run `npm ci`. Configure your own `wrangler.toml` from the template, ensuring its `DB` binding points to the website's actual D1 database. Follow [D1 initialization and upgrades](d1-migrations.md) before creating an account: fresh installations apply the full schema and record a baseline, never replay historical migration files; existing databases use the planner. Authenticate Wrangler using your own Cloudflare login or deployment environment variables.

From the repository root, use the PowerShell or Bash commands above: set `EDGECHAT_ADMIN_USERNAME`, enter `EDGECHAT_ADMIN_PASSWORD` without placing it in shell history, run `npm run admin:bootstrap`, remove the password from the environment, then execute the generated SQL:

```bash
npx wrangler d1 execute DB --remote --config wrangler.toml --file .tmp/edgechat-admin-upsert.sql
```

Only execute SQL if generation succeeded. The npm command generates SQL only; it does not modify D1. The ignored `.tmp` file contains a salted password hash, not the plaintext password; remove it after use. Use `--local` instead of `--remote` for a local Wrangler development database.

If the website is already deployed, sign in immediately after applying the SQL; no Worker redeployment is needed. Otherwise continue with `npm run deploy`. Initial credentials are consumed by the SQL generator, not configured as runtime Worker password variables.

### Existing Accounts and Recovery

Initialization never overwrites an existing account's password, permissions, ban state, deletion state or role. Updating Repository Secrets is not a password reset. For an existing account or lost administrator password, back up the database and follow the explicit recovery procedure in [RBAC maintenance](rbac.md). Do not empty the database or expose anonymous administrator setup.
