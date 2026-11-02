# Telegram 私人通知运行规则

`2.20.1` 起，私人通知仅显示私信或明确群提及的发送者、**正文前 8 个 Unicode 字符**和 EdgeChat 会话链接；超出部分以省略号表示。短于 8 字符的正文会完整显示，短预览仍是交给 Telegram 的明文，并不是端到端加密。附件只提示“有附件”，不显示文件名或下载凭据。站内消息仍加密存储，outbox 不复制正文；出队时重新核对绑定、偏好、成员、拉黑和消息存活。已发送的旧全文副本无法自动撤回，通知预算不阻止聊天消息提交。

查看链接从管理员已配置的 HTTPS Bot Webhook 取站点 origin，使用现有 `notificationRoomKind` / `notificationRoomId` 打开对应会话，不包含 Session、消息正文或附件 key；仍需登录并通过原有权限校验。Telegram 链接预览关闭。旧配置没有有效 Webhook 地址时只提示打开 EdgeChat，不猜测域名；管理员在正确域名重新连接 Bot 可恢复链接。

## 按钮私聊

1. 在 EdgeChat 设置中绑定现有 Bot；已绑定用户无需重新绑定。
2. 在 Bot 私聊输入一次 `/chats`（`/start`、`/help` 同样打开列表），或点击「私聊列表」。
3. 点击姓名按钮，然后回复 Bot 的输入提示，即可作为自己的站内账号发送文字。每页 8 人，只包含本人已有且当前可发送的私聊，不包含群组或全站通讯录。
4. 发送成功后点姓名继续发送、点「私聊列表」切换联系人，或回复原提示继续发送。提示有效期 10 分钟；选择新联系人使旧提示失效。点「取消发送」或输入 `/cancel` 撤销提示。

采用 Telegram 原生回复键盘和 ForceReply，兼容现有只订阅 `message` 的 Webhook，无需重设 Bot 或新增 callback 订阅。普通文字没有回复提示时不会猜测收件人。单条最多 8000 UTF-8 字节，图片/语音/文件请在站内发送。每次发送重新校验绑定、封禁、成员和双向拉黑，通过既有 ChannelRoom 完成加密持久化、广播、未读投影；Telegram 重试复用消息键避免重复入库。

通知偏好只控制被动提醒，关闭提醒仍可主动发私聊；解除绑定同时停用两者，并清除待回复目标。已发送到 Telegram 的副本不随站内消息删除而撤回。

## 预算与合并

- 滚动一分钟最多入队：同一发送者 20 条、同一收件人 5 条、全站 100 条。
- 同一消息最多通知 10 位已连接收件人；全站待处理/发送中记录最多 500 条。超额提醒不入队，不积累稍后补发的洪峰。
- 入队延迟 10 秒，同一收件人、同一提醒类型的到期任务每批最多合并 5 条，显示各条发送者、短预览与会话链接；每个收件人最多每分钟收到一次私人提醒。
- 全站私人提醒及重试最多每秒发起一次 Bot 请求。429 使用 Telegram 的 `parameters.retry_after` 暂停整个私人通知队列；缺少该值时暂停 60 秒。普通失败按尝试次数退避，每条记录最多尝试四次。
- D1 保存预算、租约和共享退避；`TelegramNotifications` DO alarm 调度，既有 15 分钟 cron 只唤醒队列并记录 pending/sending/failed 汇总。终态去重键保留七天后清理。

上述预算针对私人提醒，不包括交互式命令回复或 Telegram 群组桥接；共享 Bot 的其他 API 使用仍可能触发上游限额。多人共同滥用仍可能消耗全站预算，部署者应结合账号管理与队列日志观察。

## 升级与手动部署

GitHub Actions 从 `wrangler.example.toml` 生成配置，自动规划、应用和验证迁移后部署。无需新 Secret、KV 或 DO；已有绑定、偏好和 outbox 保留。`2026-10-31-telegram-direct-messages` 新增每账号最多一条的短时回复目标及重绑清理触发器；过期目标由现有定时清理删除。

手动部署先备份 D1，使用现有迁移规划脚本应用所有待执行迁移（包含 `2026-10-11-telegram-notification-budgets` 和 `2026-10-31-telegram-direct-messages`），再运行 `--verify`。不要对已有数据库只重跑完整 schema，也不要重放已经登记的历史迁移。尚未安装通知调度器的自定义 Wrangler 配置必须增加：

```toml
[[durable_objects.bindings]]
name = "TELEGRAM_NOTIFICATIONS"
class_name = "TelegramNotifications"

[[migrations]]
tag = "v5"
new_sqlite_classes = ["TelegramNotifications"]
```

保留现有 v1-v4 迁移和绑定。后台「安装与维护」包含新 DO 的只读健康检查；检查不触发通知或 alarm。
