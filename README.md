# dot-dingtalk-bridge

[English](README.en.md)

把本人钉钉私聊接到原来的 ChatGPT dot。消息通过钉钉 Stream 长连接进入 DotBridge，再由官方 Secure MCP Tunnel 交给 dot；dot 的最终回复发送回同一个私聊。

本仓库负责钉钉收发，共享运行和存储能力由 `dot-bridge-core` 提供。需要同时使用多个聊天应用时，从 [DotBridge 总仓库](https://github.com/Arcueid77/dot-bridge)安装和管理。

使用前需要在钉钉开放平台准备一个启用机器人的应用，选择 **Stream 模式**并发布。运行配对命令后，在本人和机器人的私聊里发送一次临时口令，即可保存本人绑定；不必手工查用户 ID 和会话 ID。这里不要求把钉钉回调端口开放到公网。

支持本人私聊里的文字、图片、语音和文件。dot 可以读取图片、原始语音和文件内容，也可以回复一张图片、一段已有的 AMR 语音或一个文件。平台附带的语音转写仍会保留，便于在 dot 无法直接读取某种音频时使用。视频目前只显示类型提示。

每个附件上限 5 MiB；发送语音需为 AMR、最多 60 秒。每条原消息对应一个最终回复，可以选文字或单个附件；附件暂不附带说明文字。文字回答最多 20,000 字符，超过一条文字的 600 字符时会把完整内容作为一份 `answer.txt` 回复。原生语音发送使用已有 AMR 文件；可选本地合成以 WAV 文件交付。[具体格式与限制](docs/media.md)。

安装配置见[配置与使用](docs/configuration.md)。配置完成后还需在原 dot 中建立真实事件订阅；仅有 Tunnel 连接成功不会让消息自动进入 dot。

可以让 dot 把收到的图片、语音或文件直接发回原私聊，例如“把这张图发回来”。桥会按附件编号读取，不需要来回传递很长的编码文本。仍需符合本渠道的格式和大小限制；无法作为语音发送的已识别音频，可以明确选择作为文件回复。

TXT、Markdown、JSON、CSV 等文本附件会提供可读的文字摘录，支持 UTF-8 和带标记的 UTF-16；过长时明确标记为截断，原文件仍可读取。PDF／Office 摘录复用受保护的 Linux 处理环境，原件继续保留。

运行主机可使用持续开机的 Linux 或 Windows 电脑，Linux 支持 systemd。macOS 尚未验证，欢迎试用并反馈。

## 定时消息

新增主动文字和固定提醒：目标只允许已绑定的本人私聊，主动发送默认关闭。管理员批准后可设置 `DOT_BRIDGE_OUTBOUND=owner-text`；原 dot 通过发送、保存提醒、查询、修改和取消工具管理，不需要重建事件订阅。每条最多 2,000 字符，重复提醒需有结束日期。

详见[定时消息使用指南](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.md)。

## 选项、文件和提醒管理

支持用编号文字回复一组选项，直接回复编号即可继续对话。生成的图片、音频或文件可由具备程序文件读取能力的原 dot 分块上传，经大小与 SHA-256 校验后作为原消息的最终回复。单文件上限 5 MiB，仍需满足本渠道支持的媒体类型与格式。

固定文字提醒支持工作日、固定间隔、暂停、恢复和发送历史。先核对 `check_dingtalk_outbound` 的开关，再按提醒编号与当前版本操作。暂停期间的旧时间点在恢复时跳过。


## 长任务、连续消息与语音

长任务开始时，dot 可调用任务工具取得编号、被动回复截止时间及剩余秒数，再保存完整结果。本人在原私聊发送 `/tasks` 查看编号，用 `/result 编号` 读取已保存的文字。结果按原消息保留期清除。发送结果不明时保留 uncertain，已完成的回复沿用原记录。

受保护交互配置支持 `queue`，例如 `{"mode":"batch","window_ms":750,"max_messages":5}`。`mode` 可选 `independent`、`serial`、`batch`，默认 independent。合并保留每条来源，并以最后一条为回复锚点。附件、引用、已开始处理的来源各自处理，会话与成员范围沿用原隔离规则。

Linux 管理员可安装本地 eSpeak NG 和受保护音频环境，配置 `DOT_BRIDGE_SPEECH_SYNTHESIS=local-espeak`、`DOT_BRIDGE_SPEECH_VOICE=zh`。原 dot 使用 `check_dingtalk_speech` 和 `reply_dingtalk_speech`，单次最多 2000 字符、120 秒。完整文字同时保存在任务记录里。

平台明确拒绝的一次性主动发送，可在本人确认后通过 `retry_dingtalk_outbound` 重试同一编号和当前版本。主动发送开关继续按渠道配置，重复提醒保持原来的编辑和恢复流程。原 dot 任务的停止、重置和审批通过原平台管理。

## 群规则与处理卡片

通过 `DOT_BRIDGE_INTERACTION_POLICY_FILE` 配置指定群。成员支持 owner、allowlist、all，触发支持真实 @、关键词和所有实际收到的消息。回调、会话和成员均由官方 Stream 事件绑定，原 dot 使用唯一 `conversation=configured` 订阅。

处理反馈支持平台表情及撤回。若已有获准的 AI 卡片模板，可在受保护凭据文档中配置 `aiCard.templateId` 和可选 `contentKey`，桥会创建、逐步更新并结束同一张卡片。模板和平台权限由应用管理员准备。语音合成结果以 WAV 文件发送。
