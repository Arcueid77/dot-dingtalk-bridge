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
