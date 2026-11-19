# 富文本编辑器安全边界 / Rich-editor security boundaries

`2.21.1` 修复用户名进入 Vditor 提及补全插入值时未转义的问题。列表展示 `html` 和插入 `value` 都是 HTML 上下文，必须分别转义；`hint.parse: true` 使插入值经过已安装的 Lute 净化出口。不能只校验新用户名而忽略数据库里的存量名称。

编辑器的 Markdown/DOM 转换出口保留原始 HTML 代码块化和远程媒体移除，并由 DOMPurify 白名单限制结构、属性与 URL。禁止为新功能直接开启任意 HTML、内联事件、样式或额外预览脚本。消息展示继续使用独立的 Markdown/DOMPurify 管线，不信任编辑器输出。

新增用户名规则只作用于邀请、管理员建号和初始化，不批量改写历史账号，也不限制存量账号登录。升级无须新迁移、资源或 Secret。已打开的旧网页须刷新；Android 包内置前端，网站升级不会修复旧安装包，当前 Android 开发仍暂停。

修复不自动撤销会话、不删除可疑账号，无法证明历史上未被利用。怀疑泄露时，应由管理员检查异常账号及权限，重置受影响账号密码以失效旧会话；部署凭据管理的密码同时更新 GitHub Repository Secret，避免下次部署恢复旧密码。长期 token 的 localStorage/query 传递仍是独立风险，本次未扩大为认证架构迁移。

## 回归

```bash
npm ci
npm test
npx playwright install --with-deps chromium
npm run test:editor-security
```

Chromium 只挂载本地真实 Vue 编辑组件，覆盖键盘/鼠标选中、存量标记字符串、HTML 实体、显示名、Unicode 与正常提及；另核验两个净化出口和 Markdown 回读。拦截并断言无外部请求，不创建线上账号、不读取真实 token、不复现外传。部署 Actions 自动执行这组检查。

## English

Version `2.21.1` escapes both HTML contexts of Vditor mention hints and routes selected hints through the same Lute sanitizer as drafts. Editor DOM is restricted by DOMPurify; message rendering remains independently sanitized. New-user validation never replaces output encoding for legacy account names.

No migration, cloud resource or Secret is required. Reload existing pages after deployment. Old Android packages bundle their frontend and are not repaired by a website deployment; Android work remains paused. This patch neither revokes existing sessions nor establishes whether prior exploitation occurred. Review suspicious accounts and permissions and reset affected passwords when compromise is suspected. Keep Actions-managed password Secrets in sync.
