# Provider development

The DingTalk driver owns only Stream protocol and original-session text replies.
It uses the documented gateway and callback topic, acknowledges only after core
ingestion succeeds, and leaves persistence, authorization and final-reply state
to `@dot-bridge/core/channels`. It never retries a reply request. Only connection
establishment is retried with bounded backoff.

The bridge uses a conservative initial ceiling of 600 JavaScript characters and
1,800 UTF-8 bytes per final text reply. This is a project limit, not a claim about
the maximum accepted by every DingTalk robot variant. The official reply guide
links the shared custom-robot format but does not itself specify a text ceiling;
the value should only be raised after checking the current endpoint-specific
contract. Oversize replies are rejected, never silently truncated or split.

`ws` is pinned, TLS verification stays enabled, WebSocket redirects are disabled,
frames and HTTP response bodies are bounded to 1 MiB, and requests have deadlines.
The gateway-issued endpoint must match the known official public Stream host and
`/connect` path. A provider endpoint change requires reviewing and updating that
allowlist rather than forwarding tickets to an arbitrary host. Session URLs must
match exactly `https://oapi.dingtalk.com/robot/sendBySession?session=...`.

The protocol implementation was written against official references after using
cc-connect to identify the recommended transport. No cc-connect runtime code is
vendored. References consulted on 2026-10-19:

- [Official Stream protocol](https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/stream/protocol.md)
- [Official robot message payloads](https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/bot/message.md)
- [Official Node Stream client](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/client.ts)
- [Official Go text replier](https://github.com/open-dingtalk/dingtalk-stream-sdk-go/blob/main/chatbot/chatbot_replier.go)
- [cc-connect DingTalk provider at the research revision](https://github.com/chenhg5/cc-connect/blob/2dec7173bdd44ec598c3c7e5c7ff00407acfdedf/platform/dingtalk/dingtalk.go)

Run `npm run check` and `npm test`. Fixture tests inject fetch and WebSocket,
including ingress-ACK ordering, owner/chat guards, endpoint/redirect/body limits,
metadata handling, uncertain replies and shutdown. They never connect a real
account. Account permissions, actual app identity and original-dot delivery need
operator acceptance with an explicitly bound account.
