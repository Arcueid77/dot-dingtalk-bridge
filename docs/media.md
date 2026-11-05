# 附件与回复

[English](media.en.md)

| 内容 | 发给 dot | dot 回复到本人私聊 |
| --- | --- | --- |
| 文字 | 支持，图文中的文字也会保留 | 最多 20,000 字符；超过原生单条 600 字符时，完整回答作为一份 `answer.txt` 文件回复 |
| 图片 | PNG、JPEG、GIF，可读取图片内容 | PNG、JPEG、GIF |
| 语音 | 可读取 AMR、WAV、MP3、Ogg；保留钉钉转写 | AMR，最多 60 秒、2 MiB |
| 文件 | 可下载原文件；能否提取文字取决于格式 | 支持原文件 |
| 视频 | 只显示附件类型 | 暂不提供 |

单个附件最多 5 MiB。接收消息时只保存附件信息，dot 需要内容时再读取。临时下载码或会话过期后不能读取旧附件，此时请在本人私聊重新发送附件。

dot 使用 `get_dingtalk_message` 查看文字和附件列表，用 `get_dingtalk_attachment` 读取指定附件。原始语音能否直接播放或被理解取决于 dot 对音频格式的支持；转写是文字参考，不能用来判断音色或背景声音。没有配置语音转写服务时也不会另行调用模型 API。

每条原消息只对应一个最终回复。`reply_to_dingtalk` 发送文字；`reply_dingtalk_media` 发送一个附件，直接提供文件内容，不接受外部下载地址、本机路径或另一个收件人。附件回复没有说明文字；需要说明时，应让 dot 选择合适的文字回复。发送语音需要已经存在的 AMR 文件，桥不会自动生成或转换语音。

媒体下载只使用已识别的钉钉 HTTPS 下载地址。钉钉返回已知 OSS 下载节点的 HTTP 地址时，桥会先转换为同一节点的 HTTPS 地址再访问；不会发送 HTTP 请求。遇到尚未识别的官方下载节点会停止读取，需要运维核对，不应通过任意域名或关闭 TLS 校验解决。

媒体回复通过钉钉单聊接口发送，收件人固定为已绑定本人。收到接口回执表示钉钉接受了请求，不表示用户已经阅读。超时或结果不明时，查看 `get_dingtalk_reply_status`，不要自动重发。

实现依据：[机器人接收消息](https://open.dingtalk.com/document/robots/receive-message)、[下载消息文件](https://open.dingtalk.com/document/orgapp/download-the-file-content-of-the-robot-receiving-message)、钉钉官方连接器的[媒体上传与回复](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/src/services/media.ts)和[图片消息格式](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/src/services/messaging.ts)。
