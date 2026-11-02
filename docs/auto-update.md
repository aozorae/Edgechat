# 定时同步稳定版与安全更新

`Sync Upstream` 每天 UTC 01:17、13:17（北京时间 09:17、21:17）检查 `aozorae/Edgechat` 默认分支；GitHub 调度可能延迟。上游主仓跳过自身，fork/源码副本更新自己的默认分支。

## 部署者首次配置

1. 先手动同步一次，确保默认分支已有 `.github/workflows/sync-upstream.yml`。
2. 在 Actions 中启用工作流。GitHub 默认禁用新 fork 的定时任务；公开仓库 60 天无活动也可能暂停定时运行，需要重新启用。
3. 推荐添加 Repository Secret `EDGECHAT_SYNC_TOKEN`：使用仅授权当前 fork 的 fine-grained PAT，授予 **Contents: Read and write**、**Workflows: Read and write**。它仅用于 checkout/推送；派发部署使用内置 `GITHUB_TOKEN` 的 Actions 写权限。Classic PAT 对应 `repo` 和 `workflow` 权限，但范围更大，不推荐。
4. 保留原有 Cloudflare Secrets/仓库变量，允许工作流写入默认分支。分支保护、组织策略及令牌过期可能阻止同步，不会强推绕过保护。
5. 手动运行一次 `Actions -> Sync Upstream -> Run workflow` 检查配置，之后由定时任务执行。要停用自动更新，直接 Disable workflow。

未配置同步令牌时，普通源码更新使用内置令牌；更新涉及 Actions 文件时会明确失败，要求配置上述 Secret，远端分支不变。

## 维护者如何标记提交

发布时照常更新 `package.json`、`package-lock.json` 和变更记录。发布提交在正文末尾加一个独立 Git trailer（与标题/正文之间留空行）：

```bash
# 稳定版本
git commit -m "release: stable version" -m "EdgeChat-Update: stable"
git push origin master

# 必须跟进的安全修复
git commit -m "fix: critical security vulnerability" -m "EdgeChat-Update: security"
git push origin master
```

只识别小写 `stable` 和 `security`，两者都会自动合并、部署。正文里随意提到标记不算参数。标记须最终保留在上游默认分支第一父链的提交里：使用 squash/merge PR 时，把它放在最终 squash/merge commit 的尾部，而不只是 PR 标题或分支内部提交。

检查选择**最新标记提交**，一次合并它及此前全部落后提交，带入该提交中的版本号。标记之后尚未发布的开发提交不会被顺带部署。自定义源码采用普通 merge 保留，冲突必须手动解决；“强制安全更新”不是覆盖用户代码、绕过权限或数据库回滚。

## 为什么同步后仍能部署

内置 `GITHUB_TOKEN` 推送不会触发新的 `push` 工作流，因此脚本显式通过 `workflow_dispatch` 派发 `00 Deploy Worker`，从更新后的默认分支拉取代码、测试、迁移并部署。自动合并提交带 `[skip ci]`，即使配置 PAT 也不会额外启动 push 部署；该标记不会阻止显式 dispatch。

当前 SHA 已成功部署或有部署正在运行时不重复派发；派发失败、部署失败或取消后，下次检查会补派。部署记录 fork 当前 SHA，不会记录同步前的旧 SHA。请在 Actions 中分别查看 `Sync Upstream` 和 `00 Deploy Worker`，同步成功不代表后续部署已成功。

## 自动清除消息天数

Worker 环境变量 `MESSAGE_RETENTION_DAYS` 默认 `15` 天，请填写正整数（例如 `30`）。GitHub Actions 部署者在 **Settings -> Secrets and variables -> Actions -> Variables** 添加同名 Repository Variable，然后运行 `00 Deploy Worker`；每次部署都会读取它，因此上游同步不会重置该设置。它不是 Secret。

手动部署在 Wrangler 配置的 `[vars]` 中设置 `MESSAGE_RETENTION_DAYS = "30"`，再部署。Cloudflare 面板也可修改 Worker 的同名文本变量并发布，但 Actions 后续部署以 Repository Variable 为准，未配置则恢复 15 天。只在本机导出同名环境变量不会自动传入线上 Worker。

从 `2.17.2` 起，新安装和未显式配置天数的部署默认保留 15 天。已有 Repository Variable 或实际部署的 Wrangler 配置中显式填写的值（包括 `7`）继续生效；希望改为 15 天时请更新该值后部署。延长保留期不会恢复此前已删除的消息，也不需要迁移或改写消息记录。

每天约 UTC 19:00（北京时间次日 03:00）清理超过保留期的消息与关联附件，按预算分批处理，不保证一轮清完。时间按消息创建时间计算，不按最后查看时间。`0` 不是关闭开关：Worker 对无效值、非正数及小于一天的值回退 15 天；Actions 对非正整数直接报错。缩短保留期会在下一次清理删除更早消息，删除不可恢复，之后改大天数也不能找回。其他软删除数据、孤儿上传和 Telegram 通知投递记录的保留期不变。

参考：[GITHUB_TOKEN 与 dispatch 例外](https://docs.github.com/en/actions/concepts/security/github_token)、[跳过 push 工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)、[令牌权限](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。
