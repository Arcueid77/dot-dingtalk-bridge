# Configure DingTalk

[中文](configuration.md) · [English](configuration.en.md)

Use Node.js >=24.15 and <25. Install the included core artifact and lockfile:

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

## Application and owner pairing

Create/reuse an application in [DingTalk Open Platform](https://open.dingtalk.com/), enable its robot and Stream mode, and publish to the owner's permitted range. Media also uses the application's robot-send and media-upload permissions. The administrator approves and publishes those permissions.

Stop old consumers. As the final service account, save `clientId`, `clientSecret` and optional `robotCode`/`corpId` in protected `app.json`, then run:

```sh
node scripts/pair-owner.js \
  --app-credentials-file /var/lib/dot-bridge/private/dingtalk/app.json \
  --output /var/lib/dot-bridge/private/dingtalk/credentials.json \
  --confirm-stopped --confirm-private-storage
```

Within five minutes send the complete temporary `dotbridge-pair:…` phrase from the owner's DM. The verified match creates the binding and exits. The output must not exist; timeout creates no guessed owner. Keep existing verified credentials during upgrades.

The saved JSON has `clientId`, `clientSecret`, `ownerId` (sender staff ID) and `conversationId`; `robotCode` defaults to `clientId`, with optional `corpId` validating the event's corporation. Keep all real values in private files.

## Private configuration

Linux directories use 0700 and files 0600, owned by the runtime account. Windows uses private ACLs. The account owns data/lock directories. Each channel and router has an independent service key; retain the original 32-byte Base64 storage key with its database.

```dotenv
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
HOST=127.0.0.1
PORT=8801
DINGTALK_TRANSPORT=stream
DINGTALK_CREDENTIALS_FILE=/var/lib/dot-bridge/private/dingtalk/credentials.json
TUNNEL_SERVICE_KEY_FILE=/var/lib/dot-bridge/private/dingtalk/service-key
STORAGE_KEY_FILE=/var/lib/dot-bridge/private/dingtalk/storage-key
DATABASE_PATH=/var/lib/dot-bridge/dingtalk/bridge.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/locks
CALLBACK_TRANSPORT_MODE=standard
CALLBACK_HOSTS=REPLACE_WITH_APPROVED_CALLBACK_HOST
```

8801 is an explicit combination example; the component's built-in port is 8790. Select an available port and keep MCP on loopback.

```sh
node --env-file=/var/lib/dot-bridge/private/dingtalk.env scripts/run-live.js --confirm-live
```

Use the unified distribution for persistent services and one aggregate Tunnel target. Provider-disabled checks use `scripts/run-readiness.js`, operation `readiness` and `DINGTALK_TRANSPORT=disabled`, with provider credentials, storage and database settings removed.

## Original-dot subscription

Refresh the original plugin and reuse/renew `dingtalk.message.created` with `conversation=owner`. Its real subscription supplies the callback. Approve its exact hostname in `CALLBACK_HOSTS` and keep one event task.

The routed public diagnostic tool is `check_dingtalk_readiness`; the direct backend uses `check_dingtalk_setup`. `dotbridge status` handles this mapping. Inspect gateway and subscription state separately, then verify one owner message returns once. [Media](media.en.md) covers formats and expiry.

Session reply references expire. Preserve unknown sends as `uncertain` and review the source DM before manual recovery. Migrating hosts keeps the database/storage key and requires the old consumer to stop first.
