# 登录验证与原生限流 / Login Verification and Rate Limiting

## 中文

`2.19.0` 起，超级管理员可在「后台 → 集成 → 登录验证」设置 Cloudflare Turnstile。默认关闭，不影响已有会话或邀请注册。开启后，每次提交密码都生成新的 `action=login` token，服务端先向 Siteverify 验证，再查询账号和校验密码；密码错误后重试同样重新验证，不按失败次数触发，不新增尝试计数或风控 D1/KV 写入。原有成功登录记录继续保留。

1. 在 Cloudflare Turnstile 创建 Managed 类型小组件，配置实际登录域名。Site Key 可以公开，Secret Key 不能提交到代码、配置文件或数据库。
2. 在项目根目录执行 `npx wrangler secret put EDGECHAT_TURNSTILE_SECRET_KEY --config wrangler.toml`，交互输入 Secret Key。GitHub Actions 用户也可设置同名 Repository Secret，工作流会通过 `wrangler secret put` 注入；未提供时保留线上 Secret，不清空。
3. 在后台填写配套的 Site Key、勾选启用并保存。关闭开关后保存即可恢复无需挑战的登录，Site Key 保留。若误配导致无法登录，可修复 Worker Secret；必要时由部署者仅将 `site_settings` 的 `login_verification` JSON 的 `enabled` 改为 `false`，不要重置数据库。

普通网页、隐身表单及 API v1 密码入口均执行同样的校验。隐身模式开启验证后会按需加载 Cloudflare 脚本/iframe，不再是纯无脚本表单。API v1 capabilities 返回 `loginVerification: { enabled, siteKey }`，登录请求携带 `turnstileToken`；旧原生客户端和 WebMCP 自动登录不具备交互挑战能力，开启后无法新登录。Android 本轮不开发，已有会话恢复/刷新不受影响。demo 仅模拟设置，不调用真实 Turnstile。

### 默认限流

更新手动部署的 `wrangler.toml` 时，从 `wrangler.example.toml` 复制两段 `[[ratelimits]]`：`LOGIN_RATE_LIMITER` 为每 IP 每 60 秒 10 次密码登录；`API_RATE_LIMITER` 为每 IP 每 60 秒 120 次 API 请求。Actions 自动继承模板，不需要额外资源创建或 Secret。使用 Wrangler 4.36.0 或更新版本。

登录额度覆盖普通网页、隐身表单和 API v1；普通 API 额度排除 OPTIONS 与 `/api/integrations/*` 回调。限额耗尽返回 429 和 `Retry-After: 60`。静态资源、文件下载及已建立 WebSocket 的消息帧不受这两项限制。限流与 Turnstile 开关独立，默认生效；未配置 binding 的本地测试跳过原生限流。

计数使用 Cloudflare 原生 Rate Limiting API，不读写 D1/KV。它是各 Cloudflare 地点内最终一致的宽松限制，并非精确的全球计数；共享出口 IP 的用户共用额度。可直接修改模板 `simple.limit` 并重新部署；同账户其他应用应使用不同的 `namespace_id`，避免意外共享计数。

## English

Since `2.19.0`, super administrators can configure Cloudflare Turnstile under **Admin → Integrations → Login Verification**. It is off by default. Each password submission obtains a fresh `action=login` token, verified by Siteverify before account lookup/password hashing. Failed passwords require a new challenge on retry. No failed-attempt counters or additional risk-control D1/KV writes are introduced; existing successful-login records remain.

Create a Managed Turnstile widget for your login hostnames. Inject its secret using `npx wrangler secret put EDGECHAT_TURNSTILE_SECRET_KEY --config wrangler.toml`, or set the same Repository Secret for Actions to inject using `wrangler secret put`. An omitted Repository Secret preserves the deployed value. Enter the matching public Site Key in Admin, enable and save. Disable and save to stop requiring challenges. In a lockout, fix the Worker Secret or explicitly set only `enabled` to `false` in the existing `site_settings.login_verification` JSON; do not reset the database.

Web, stealth-gate and API v1 password logins enforce the same rule. Enabling this feature adds the Cloudflare script/iframe to the otherwise script-free stealth gate. API v1 capabilities exposes `loginVerification: { enabled, siteKey }`; submit a fresh `turnstileToken` with login. Legacy native clients and WebMCP automatic login cannot complete an interactive challenge and cannot start new sessions while enabled. Existing sessions/refresh and invitation registration are unchanged. Android is not updated. Demo only simulates settings.

Copy both `[[ratelimits]]` sections from `wrangler.example.toml` into a manually maintained config: `LOGIN_RATE_LIMITER` allows 10 password logins/IP/60 seconds; `API_RATE_LIMITER` allows 120 API requests/IP/60 seconds, excluding OPTIONS and `/api/integrations/*` callbacks. Actions inherits these bindings automatically; no resource-provisioning step or extra Secret is needed. Use Wrangler 4.36.0+. Rejections return 429 with `Retry-After: 60`. Static assets, file downloads and established WebSocket frames are outside these limits.

Rate limiting is on independently of Turnstile. Cloudflare maintains counters without D1/KV reads or writes. Limits are permissive and eventually consistent per Cloudflare location, not exact global quotas. Shared public IPs share the allowance. Adjust `simple.limit` and redeploy if needed; use distinct `namespace_id` values for unrelated applications on the same account. Local tests without the binding skip the native limiter.
