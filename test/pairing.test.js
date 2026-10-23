import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createEnrollmentProvider, createProvider } from '../src/provider.js';
import { createPairingChallenge } from '@dot-bridge/core/channels/pairing.js';

test('DingTalk enrollment is explicit, private, bot-bound and separate from live replies', async t => {
  const credentials = { clientId: 'fixture-app', clientSecret: 'fixture-secret', corpId: 'fixture-corp' };
  assert.throws(() => createProvider({ credentials, onMessage: async () => {} }), /credentials/u);
  assert.throws(() => createEnrollmentProvider({ credentials, onPairingMessage: async () => {} }), /stopped/u);
  let socket;
  class Socket extends EventEmitter {
    constructor() { super(); socket = this; this.readyState = 1; this.sent = []; }
    send(raw, callback) { this.sent.push(JSON.parse(raw)); callback?.(); }
    terminate() { this.emit('close'); }
  }
  const candidates = [];
  const challenge = createPairingChallenge();
  const provider = createEnrollmentProvider({ credentials, confirmStopped: true, WebSocket: Socket,
    onPairingMessage: async value => { candidates.push(value); challenge.accept(value); }, fetch: async () => new Response(JSON.stringify({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'fixture-ticket' })),
  });
  t.after(() => provider.stop()); await provider.start();
  while (!socket) await delay(1);
  const callback = extra => ({ type: 'CALLBACK', headers: { messageId: 'fixture-frame', topic: '/v1.0/im/bot/messages/get' },
    data: JSON.stringify({ robotCode: credentials.clientId, chatbotCorpId: credentials.corpId, conversationType: '1',
      senderStaffId: 'fixture-owner', conversationId: 'fixture-chat', msgtype: 'text', text: { content: challenge.phrase },
      createAt: Date.now(), ...extra }) });
  for (const invalid of [{ robotCode: 'other' }, { chatbotCorpId: 'other' }, { conversationType: '2' },
    { senderStaffId: '' }, { msgtype: 'picture' }, { isForwarded: true }, { quotedMessage: {} },
    { senderId: 'fixture-bot', chatbotUserId: 'fixture-bot' }]) socket.emit('message', Buffer.from(JSON.stringify(callback(invalid))));
  socket.emit('message', Buffer.from(JSON.stringify(callback({}))));
  await delay(5);
  assert.equal(candidates.length, 1);
  assert.deepEqual(challenge.result(), { ownerId: 'fixture-owner', conversationId: 'fixture-chat' });
  assert.deepEqual(Object.keys(candidates[0]).sort(), ['conversationId', 'ownerId', 'text', 'timestamp']);
  assert.equal(provider.sendReply, undefined);
  assert.equal(provider.sendMediaReply, undefined);
  assert.equal(provider.readAttachment, undefined);
  assert.ok(socket.sent.every(frame => frame.code === 200));
});

test('pairing CLI refuses missing confirmations before loading private input', () => {
  const result = spawnSync(process.execPath, ['scripts/pair-owner.js', '--app-credentials-file', 'not-read.json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /No private files were read/u);
  assert.equal(result.stderr, '');
});
