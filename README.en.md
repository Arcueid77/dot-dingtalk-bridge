# DingTalk for DotBridge

[中文](README.md) · [English](README.en.md)

Connect the bound owner's DingTalk bot DM to the existing ChatGPT dot through the official Secure MCP Tunnel. This repository owns DingTalk protocol handling; `dot-bridge-core` owns shared authentication, encrypted state and routing. The [unified distribution](https://github.com/Arcueid77/dot-bridge) installs selected channels together.

Use Node.js >=24.15 and <25 on a continuously available Linux or Windows host. Linux provides systemd operation. macOS is unverified; trials and feedback are welcome.

## Setup

Create or reuse an application/robot in [DingTalk Open Platform](https://open.dingtalk.com/), enable Stream mode and publish to the owner's permitted range. Complete the temporary-phrase owner pairing, protect the resulting credentials and stop the previous consumer.

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node --env-file=/var/lib/dot-bridge/private/dingtalk.env scripts/run-live.js --confirm-live
```

This starts the backend; use the unified entry for the router and persistent services. Refresh the existing Tunnel plugin and reuse/renew `dingtalk.message.created` with `conversation=owner`. Full application, pairing and private-file steps are in [configuration](docs/configuration.en.md).

## Messaging and media

Receive text, images, voice and files. Replies support text, images, existing AMR voice and files. Each source selects one final reply. Complete text is limited to 20,000 characters; above the 600-character native limit, the full answer is delivered as `answer.txt`.

Attachments are at most 5 MiB. AMR replies are at most 60 seconds and 2 MiB; media has no additional caption. Reuse a source attachment by index. Text files include bounded UTF-8/UTF-16 excerpts; protected Linux processing can add PDF/Office extraction and optional local transcription. Original bytes remain available. See [media](docs/media.en.md).

Keep one consumer and preserve the original database, storage key, binding and subscription when upgrading. Inspect gateway and dot subscription state separately. Unknown sends remain `uncertain` for review.

## Owner notifications

Explicit `DOT_BRIDGE_OUTBOUND=owner-text` enables owner-only proactive text and literal reminders. Each message is at most 2,000 characters; recurring reminders require an end date. Dynamic reports come from the original dot's scheduled tasks. See [scheduled messages](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.en.md).

Implementation and validation notes are in [development](docs/development.md). Actual account onboarding and end-to-end results are tracked separately from source tests.

## Choices, uploads and reminder management

Numbered text choices let the user answer with a selection. A dot environment with programmatic file access can upload generated media in bounded encrypted chunks, verify its size and SHA-256, then submit the source-bound final reply. Files are limited to 5 MiB and this provider's supported media types and formats.

Literal reminders support weekdays, fixed intervals, pause, resume and delivery history. Check `check_dingtalk_outbound` before use and supply the saved reminder ID and current revision. Resuming skips old paused occurrences.


## Tasks, consecutive messages and speech

Task tools return a source-bound reference, passive deadline and remaining seconds. The original dot can save one complete text result. The paired owner can use `/tasks` and `/result reference` in the original DM. Source retention applies, and ambiguous delivery stays uncertain.

The protected interaction policy accepts `queue`, for example `{"mode":"batch","window_ms":750,"max_messages":5}`. Modes are `independent`, `serial` and `batch`, defaulting to independent. A batch retains every source and replies through the last source as its anchor. Attachments, quotes and work already started are handled separately, with the existing conversation/member isolation.

Linux operators can install eSpeak NG and the protected audio runtime, then set `DOT_BRIDGE_SPEECH_SYNTHESIS=local-espeak` and `DOT_BRIDGE_SPEECH_VOICE=zh`. The original dot uses `check_dingtalk_speech` and `reply_dingtalk_speech`, limited to 2000 characters and 120 seconds. The full text is also retained in the task record.

An explicitly rejected one-time proactive send can be retried after owner confirmation using `retry_dingtalk_outbound`, its original ID and current revision. The per-channel proactive switch still applies. Recurring reminders keep their edit/resume flow. Hosted-dot stop, reset and approvals use the original platform controls.

## Groups and processing cards

Configure selected groups through `DOT_BRIDGE_INTERACTION_POLICY_FILE`. Membership supports owner, allowlist and all; triggers support verified mentions, keywords and all messages actually delivered by the platform. The Stream event binds the real session and sender. The original dot uses one `conversation=configured` subscription.

Feedback supports platform reactions and recall. If an approved AI-card template is available, configure `aiCard.templateId` and optional `contentKey` in the protected credential document. The bridge creates, progressively updates and finalizes the same card. The application administrator prepares its template and permissions. Synthesized speech is delivered as a WAV file.
