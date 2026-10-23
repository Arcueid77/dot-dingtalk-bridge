# 配置与使用

先准备钉钉应用，再配置桥和原 dot 的事件订阅。Node.js 需要 `>=24.15` 且 `<25`。本仓库使用锁文件安装依赖：

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

## 钉钉应用

在[钉钉开放平台](https://open.dingtalk.com/)创建或复用自己的应用，启用机器人，使用 Stream 模式接收机器人消息，并按照后台要求发布到本人可用的范围。Stream 通过服务端主动建立长连接，不需要配置入站 Webhook。

图片、语音和文件还会用到「企业内机器人发送消息」权限、应用 accessToken 与媒体上传接口。应用管理员应按后台提示开通所需权限后重新发布。机器人能收到文字，不代表媒体接口的权限也已生效。

## 配对本人私聊

推荐用临时口令配对，这样不用手工寻找用户和私聊编号：

1. 停止同一机器人的旧桥和其他消费者，避免两套程序同时收消息。
2. 以最终运行用户准备受保护的 `app.json`，只放 `clientId`、`clientSecret`，可选 `robotCode`、`corpId`。文件为 `0600`，所在目录为 `0700`；Windows 使用该用户专用 ACL。
3. 以同一用户运行下列命令。`--output` 必须是尚不存在的文件；命令不会覆盖已有绑定。

```sh
node scripts/pair-owner.js \
  --app-credentials-file /var/lib/dot-bridge/private/dingtalk/app.json \
  --output /var/lib/dot-bridge/private/dingtalk/credentials.json \
  --confirm-stopped --confirm-private-storage
```

4. 在五分钟内，从本人和机器人的**单聊**发送屏幕上的完整 `dotbridge-pair:...` 口令。不要把口令发到群聊或转给其他人。配对只认这次口令，不会认领第一个发消息的人。
5. 出现保存成功后，配对程序退出。把下面的 `DINGTALK_CREDENTIALS_FILE` 指向生成的文件，再启动服务和订阅。

命令只显示临时口令及结果，不打印账号身份或应用密钥。不知道是否还有旧实例时，先协调停止旧实例；`--confirm-stopped` 是操作者对此的确认。若超时，修正机器人发布范围或连接问题后重新运行，会生成新的口令。

已有经过核对的绑定资料也可以按下列格式直接准备完整配置：

由应用管理员准备以下私有 JSON 文件。示例中的内容均为占位文字，替换为该应用和本人私聊的真实信息；不要放入 Git，也不要把真实文件发到聊天中。

```json
{
  "clientId": "应用的 AppKey / Client ID",
  "clientSecret": "应用的 AppSecret / Client Secret",
  "ownerId": "本人 senderStaffId",
  "conversationId": "本人和该机器人的单聊 conversationId"
}
```

可选 `robotCode` 默认使用 `clientId`；应用后台提供不同的机器人 Code 时显式填写。可选 `corpId` 用于额外核对每条回调的 `chatbotCorpId`。绑定信息需要来自该应用的真实私聊事件或已有部署配置，桥不会自动认领第一个发消息的人，也不会为获取身份而打印原始事件。

## 私有文件和环境

建议把文件放到运行用户拥有的 `/var/lib/dot-bridge/private/`，数据放到 `/var/lib/dot-bridge/data/dingtalk/`，锁放到 `/var/lib/dot-bridge/data/locks/`。私有目录权限应为 `0700`，配置、密钥和数据库文件为 `0600`，由最终服务用户持有；不要用符号链接或硬链接替代私有文件。Windows 需要按共享 core 的私有文件说明设置当前运行用户专用 ACL。

`dingtalk.env` 的示例：

```dotenv
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
HOST=127.0.0.1
PORT=8790
DINGTALK_TRANSPORT=stream
TUNNEL_SERVICE_KEY_FILE=/var/lib/dot-bridge/private/dingtalk.service-key
DINGTALK_CREDENTIALS_FILE=/var/lib/dot-bridge/private/dingtalk/credentials.json
STORAGE_KEY_FILE=/var/lib/dot-bridge/private/dingtalk.storage-key
DATABASE_PATH=/var/lib/dot-bridge/data/dingtalk/messages.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/data/locks
CALLBACK_TRANSPORT_MODE=standard
CALLBACK_HOSTS=替换为原dot真实订阅回调的精确域名
```

服务 key 和存储 key 需要由部署人员安全准备。存储 key 为 32 字节的标准 Base64 编码；数据库和备份必须保留同一个存储 key。服务 key 不得与聚合路由器或其他渠道共用。不要照着占位内容启动，也不要为回调域名添加通配符。

在本仓库目录启动：

```sh
node --env-file=/var/lib/dot-bridge/private/dingtalk.env scripts/run-live.js --confirm-live
```

需要在服务器长期运行时，使用总仓库生成 systemd 服务。MCP 只监听 loopback；官方 Tunnel 的单个 target 指向总仓库路由器，由路由器访问本渠道，Tunnel 的服务 key 使用路由器自己的文件。

只检查目录而不接入钉钉时，使用 `scripts/run-readiness.js`，将 operation 设为 `readiness`、`DINGTALK_TRANSPORT=disabled`，并移除 provider credentials、storage key、database 的相关变量。这个入口只需要自己的 service key。

## 连接原 dot

按[总仓库运行说明](https://github.com/Arcueid77/dot-bridge/blob/dev/unified-distribution/docs/operations.md)连接官方 Secure MCP Tunnel，并在**原来的 dot**刷新插件。应能发现 `get_dingtalk_message`、`get_dingtalk_attachment`、`reply_to_dingtalk`、`reply_dingtalk_media`、`get_dingtalk_reply_status`、`check_dingtalk_setup` 和 `dingtalk.message.created` 事件。回调地址必须由原 dot 的实际订阅流程提供，确认其精确域名后配置 `CALLBACK_HOSTS`。

随后从本人绑定的钉钉私聊发送一条内容唯一的文字，确认原 dot 收到并在同一私聊只回复一次。群聊、其他用户或其他应用的消息会被忽略。

发消息没有回答时，让原 dot 调用 `check_dingtalk_setup`：`gateway_connected` 表示钉钉连接情况，`subscription_active` 表示原 dot 的有效订阅。订阅失败时查看该工具中的失败阶段和原因，再修正对应问题；不要重复点创建。`CALLBACK_HOSTS` 才是本入口读取的域名配置名。图片、语音和文件的使用见[附件与回复](media.md)。

钉钉的会话回复地址有有效期，桥会同时遵守该期限与本地的消息处理期限。超时、连接中断或结果不明的回复不会自动重发；先查看 `get_dingtalk_reply_status`，不要通过重新提交去猜是否发送成功。更换服务端、应用或存储时，应先停止旧消费者，保留数据库、原存储 key 和订阅状态后再迁移。
