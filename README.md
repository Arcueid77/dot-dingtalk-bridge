# dot-dingtalk-bridge

把本人钉钉私聊接到原来的 ChatGPT dot。消息通过钉钉 Stream 长连接进入 DotBridge，再由官方 Secure MCP Tunnel 交给 dot；dot 的最终回复发送回同一个私聊。

本仓库负责钉钉收发，共享运行和存储能力由 `dot-bridge-core` 提供。需要同时使用多个聊天应用时，从 [DotBridge 总仓库](https://github.com/Arcueid77/dot-bridge)安装和管理。

使用前需要在钉钉开放平台准备一个启用机器人的应用，选择 **Stream 模式**，取得应用凭据，并明确绑定自己的 `senderStaffId` 和机器人单聊 `conversationId`。这里不要求把钉钉回调端口开放到公网。

当前支持单个绑定用户的文字收发、图文消息中的文字，以及图片、语音、视频、文件的附件类型提示。钉钉若附带语音转写，会把转写文字交给 dot。图片识别、下载原文件、听取原始音频和发送媒体尚未提供。桥目前将每条最终回复限制为 600 个字符，超过时请让 dot 缩短后再提交。

安装配置见[配置与使用](docs/configuration.md)。配置完成后还需在原 dot 中建立真实事件订阅；仅有 Tunnel 连接成功不会让消息自动进入 dot。
