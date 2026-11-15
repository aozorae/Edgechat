# 可选自定义 S3 存储

**默认仍是 Cloudflare 原生 R2，原有配置和部署步骤不变。** 只有需要其他 S3 兼容存储时才使用此选项；无需公开桶、浏览器 CORS 或额外的域名配置。

## GitHub Actions

在仓库 `Settings → Secrets and variables → Actions → Secrets` 添加一个 `EDGECHAT_S3`，值为：

```json
{"endpoint":"https://s3.example.com","bucket":"edgechat","accessKeyId":"YOUR_ACCESS_KEY","secretAccessKey":"YOUR_SECRET_KEY"}
```

将示例替换为服务商提供的 HTTPS S3 Endpoint、**已有桶名**和密钥，再运行 `00 Deploy Worker`。工作流会跳过 R2 的开通检查与创建，通过 Wrangler Secret 注入配置，不删除任何旧桶。无需修改 `wrangler.example.toml`，也不用为 S3 额外授予 Cloudflare R2 权限。

可选字段：`region` 默认 `us-east-1`（服务商要求特定区域时填写；外部 R2 S3 API 使用 `auto`）；`forcePathStyle` 默认 `true`，要求虚拟主机寻址的服务填 `false`；临时凭据可增加 `sessionToken`。Endpoint 不要包含桶名、用户密码或查询参数；网关路径前缀可保留。

## 手动部署

使用实际部署的配置执行 `npx wrangler secret put EDGECHAT_S3 --config wrangler.toml`，在提示中粘贴上述 JSON，然后正常部署。只有完全不使用原生 R2 的特殊部署才移除该配置中的 `[[r2_buckets]]` 块；原生 R2 用户不需要改动。

密钥只保存在 Worker Secret / Actions Secret，不写入源码、`[vars]` 或仓库文件。目标桶凭据只需 `GetObject`、`PutObject`、`DeleteObject`、`ListBucket` 等价权限，不需要建桶或管理员权限。上传、下载、Telegram、统计和定时清理共用该后端；访问权限、上传限制、AES-256-GCM 和私有缓存保持不变。传输要求 HTTPS，签名请求不跟随重定向。服务必须支持 AWS SigV4 和 ListObjectsV2。

## 切换已有实例

此选项**不自动迁移、双读或双写**。先暂停上传和清理任务，备份数据与完整加密密钥环，将所有对象及元数据复制到目标桶，保持原始 object key，再切换配置并恢复任务。否则旧附件会读不到，清理也只针对当前后端。不要删除仍有历史密文引用的加密 key ID。

切回 R2：先将对象复制回原桶，再把同一个 Actions Secret 改为 `r2` 并部署，工作流先恢复 `FILES` 绑定再切换后端。手动部署先恢复 R2 绑定并部署，再用 `wrangler secret put EDGECHAT_S3` 写入 `r2`。**仅删除仓库 Secret 不会删除线上 Worker 的旧 Secret**；缺省时部署保留线上设置。配置错误会明确失败，不悄悄回退，避免文件散落在两处。

## English

Native Cloudflare R2 remains the default with no additional setup. For a special S3-compatible backend, add one **Repository Secret** named `EDGECHAT_S3` containing the JSON above, then run `00 Deploy Worker`. Use an existing private bucket and an HTTPS endpoint without the bucket name, credentials, or query parameters. No public access or browser CORS is needed. Actions skips R2 provisioning and injects the setting with `wrangler secret put`; existing buckets are never deleted.

Only four fields are required. Optional `region` defaults to `us-east-1` (use your provider's region, or `auto` for the R2 S3 API); `forcePathStyle` defaults to `true`, and `false` selects virtual-host addressing; temporary credentials may include `sessionToken`. The service must support AWS SigV4 and ListObjectsV2. Limit credentials to GetObject, PutObject, DeleteObject and ListBucket on the selected bucket. Application authorization, upload restrictions, AES-GCM encryption and private caching are unchanged.

For manual deployment, run `npx wrangler secret put EDGECHAT_S3 --config wrangler.toml`, paste the JSON at the prompt, then deploy normally. Only S3-only deployments should remove their native `[[r2_buckets]]` block. Never place credentials in source or TOML variables.

Existing data is **not automatically migrated, dual-read or dual-written**. Pause uploads and cleanup, back up data and the complete encryption keyring, copy all objects and metadata while preserving keys, then switch and resume. To return to R2, copy objects back and set the same Actions Secret to `r2`; the workflow restores the binding before switching. For manual rollback, deploy the restored R2 binding first, then put the `r2` Secret. Removing the Repository Secret alone does not remove the deployed Worker Secret. Invalid S3 settings fail explicitly rather than silently falling back.
