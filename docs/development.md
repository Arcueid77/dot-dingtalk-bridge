# Provider development

The DingTalk driver owns Stream protocol, original-session text replies and
owner-bound media downloads/uploads/replies.
It uses the documented gateway and callback topic, acknowledges only after core
ingestion succeeds, and leaves persistence, authorization and final-reply state
to `@dot-bridge/core/channels`. It never retries a reply request. Only connection
establishment is retried with bounded backoff.

The bridge uses a conservative initial ceiling of 600 JavaScript characters and
1,800 UTF-8 bytes per final text reply. This is a project limit, not a claim about
the maximum accepted by every DingTalk robot variant. The official reply guide
links the shared custom-robot format but does not itself specify a text ceiling;
the value should only be raised after checking the current endpoint-specific
contract. The complete answer input is now at most 20,000 well-formed JavaScript
characters / 60,000 UTF-8 bytes. Above the native threshold, `sendReply` chooses
one existing file-upload path before any mutation and sends the complete
`answer.txt`. It never changes paths after a send, truncates, retries uncertainty
or splits an answer across independent provider requests.

`ws` is pinned, TLS verification stays enabled, WebSocket redirects are disabled,
frames and JSON response bodies are bounded to 1 MiB, media to 5 MiB, and requests have deadlines.
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
private media references, media formats, upload/token separation, revocation
between upload stages, uncertain replies and shutdown. They never connect a real
account. Account permissions, actual app identity and original-dot delivery need
operator acceptance with an explicitly bound account.

Media and pairing were extended against official references on 2026-10-23; see
the source links in `media.md`. The legacy token is used only for media upload;
the new API token stays on `api.dingtalk.com`. Download codes and signed download
URLs are never part of public attachment metadata. Only the exact known OSS
bucket may be normalized from HTTP to HTTPS, before any network request.

Enrollment uses a separate opt-in provider without send/read methods, requires
the stopped-consumer confirmation, and accepts a fresh 128-bit nonce from this
robot's private chat. The shared core helper writes protected credentials with
atomic no-replace semantics; ordinary live mode always requires an owner binding.

Local Node 24.19.0 verification: `npm run check`, all 18 fixture tests and
`npm pack --dry-run --ignore-scripts` passed with the packaged core 0.5.0. No
real application permission, media delivery or owner pairing was exercised.
