import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createProvider } from '../src/provider.js';

const credentials = { clientId: 'fixture-app', clientSecret: 'fixture-secret', ownerId: 'fixture-owner', conversationId: 'fixture-chat' };
const endpoint = 'wss://wss-open-connection.dingtalk.com/connect';
const webhook = 'https://oapi.dingtalk.com/robot/sendBySession?session=fixture-session';
const topic = '/v1.0/im/bot/messages/get';
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function socketFixture() {
  const instances = [];
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; this.readyState = 0; instances.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
    receive(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
    send(raw, callback) { this.sent.push(JSON.parse(raw)); queueMicrotask(() => callback?.()); }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    close() { this.terminate(); }
  }
  return { Socket, instances };
}

async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Fixture condition timed out.'); await delay(2); }
}

function callback(overrides = {}, id = 'fixture-frame') {
  return {
    type: 'CALLBACK', headers: { topic, messageId: id },
    data: JSON.stringify({ msgId: 'fixture-message', senderStaffId: credentials.ownerId,
      conversationId: credentials.conversationId, conversationType: '1', robotCode: credentials.clientId,
      createAt: 1_700_000_000_000, sessionWebhook: webhook, sessionWebhookExpiredTime: Date.now() + 60_000,
      msgtype: 'text', text: { content: 'Fixture question' }, ...overrides }),
  };
}

test('subscribes only robot callback and acknowledges after durable ingestion', async t => {
  const { Socket, instances } = socketFixture();
  const requests = [];
  const received = [];
  let release;
  const durable = new Promise(resolve => { release = resolve; });
  const provider = createProvider({ credentials, WebSocket: Socket,
    fetch: async (url, options) => { requests.push({ url, options }); return json({ endpoint, ticket: 'fixture-ticket' }); },
    onMessage: async message => { received.push(message); await durable; },
  });
  t.after(() => provider.stop());
  await provider.start();
  await until(() => instances.length === 1);
  const socket = instances[0];
  socket.open();
  assert.equal(provider.status().connected, true);
  assert.equal(socket.url, `${endpoint}?ticket=fixture-ticket`);
  assert.equal(socket.options.followRedirects, false);
  assert.equal(socket.options.rejectUnauthorized, true);
  assert.equal(socket.options.maxPayload, 1024 * 1024);
  assert.equal(requests[0].url, 'https://api.dingtalk.com/v1.0/gateway/connections/open');
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].options.body).subscriptions, [{ type: 'CALLBACK', topic }]);
  socket.receive(callback());
  await until(() => received.length === 1);
  assert.equal(socket.sent.length, 0);
  assert.equal(received[0].text, 'Fixture question');
  assert.equal(received[0].replyContext.sessionWebhook, webhook);
  release();
  await until(() => socket.sent.length === 1);
  assert.equal(socket.sent[0].code, 200);
  assert.equal(socket.sent[0].headers.messageId, 'fixture-frame');
  socket.receive({ type: 'SYSTEM', headers: { messageId: 'fixture-ping', topic: 'ping' }, data: 'heartbeat' });
  assert.equal(socket.sent[1].data, 'heartbeat');
  await provider.stop();
  assert.deepEqual(provider.status(), { connected: false });
});

test('owner, private chat, bot and tenant guards do not deliver other messages', async t => {
  const { Socket, instances } = socketFixture();
  let delivered = 0;
  const provider = createProvider({ credentials: { ...credentials, corpId: 'fixture-corp' }, WebSocket: Socket,
    fetch: async () => json({ endpoint, ticket: 'fixture-ticket' }), onMessage: async () => { delivered++; },
  });
  t.after(() => provider.stop());
  await provider.start(); await until(() => instances.length === 1); const socket = instances[0]; socket.open();
  const base = { chatbotCorpId: 'fixture-corp' };
  for (const invalid of [{ senderStaffId: 'someone-else' }, { conversationId: 'other-chat' }, { conversationType: '2' },
    { robotCode: 'other-app' }, { chatbotCorpId: 'other-corp' }, { senderId: 'bot', chatbotUserId: 'bot' },
    { text: { content: 'x'.repeat(20_001) } }, { sessionWebhook: 'https://evil.example/robot/sendBySession?session=x' }]) {
    socket.receive(callback({ ...base, ...invalid }));
  }
  await delay(10);
  assert.equal(delivered, 0);
  assert.equal(socket.sent.length, 8);
});

test('ingestion failure is not acknowledged and connection can recover', async t => {
  const { Socket, instances } = socketFixture();
  const provider = createProvider({ credentials, WebSocket: Socket, timing: { reconnectMs: 5 },
    fetch: async () => json({ endpoint, ticket: 'fixture-ticket' }),
    onMessage: async () => { throw new Error('Private fixture diagnostics must stay private.'); },
  });
  t.after(() => provider.stop());
  await provider.start(); await until(() => instances.length === 1); const socket = instances[0]; socket.open();
  socket.receive(callback());
  await until(() => socket.readyState === 3);
  assert.equal(socket.sent.length, 0);
  await until(() => instances.length === 2);
  await provider.stop();
  const count = instances.length; await delay(15); assert.equal(instances.length, count);
});

test('attachment metadata and platform transcript never trigger media download', async t => {
  const { Socket, instances } = socketFixture();
  const messages = [];
  let requests = 0;
  const provider = createProvider({ credentials, WebSocket: Socket,
    fetch: async () => { requests++; return json({ endpoint, ticket: 'fixture-ticket' }); },
    onMessage: async message => { messages.push(message); },
  });
  t.after(() => provider.stop());
  await provider.start(); await until(() => instances.length === 1); instances[0].open();
  instances[0].receive(callback({ msgtype: 'audio', content: { recognition: 'Platform transcript', downloadCode: 'never-fetch-this' } }));
  instances[0].receive(callback({ msgtype: 'richText', content: { richText: [{ text: 'Caption' }, { downloadCode: 'never-download', url: 'https://evil.example' }] } }));
  await until(() => messages.length === 2);
  assert.equal(requests, 1);
  assert.equal(messages[0].text, 'Platform transcript');
  assert.deepEqual(messages[0].attachments, [{ kind: 'audio' }]);
  assert.deepEqual(messages[1].attachments, [{ kind: 'image' }]);
  assert.equal(JSON.stringify(messages).includes('download'), false);
});

test('gateway and response policy rejects untrusted endpoint and redirects', async t => {
  for (const response of [json({ endpoint: 'wss://evil.example/connect', ticket: 'fixture-ticket' }),
    new Response('', { status: 302, headers: { location: 'https://evil.example' } }),
    new Response('x'.repeat(1024 * 1024 + 1))]) {
    const { Socket, instances } = socketFixture();
    const provider = createProvider({ credentials, WebSocket: Socket, timing: { reconnectMs: 10_000 },
      fetch: async () => response, onMessage: async () => {},
    });
    t.after(() => provider.stop());
    await provider.start(); await delay(10); assert.equal(instances.length, 0); await provider.stop();
  }
});

test('reply uses stored official session, enforces expiry and size, and never retries uncertain sends', async () => {
  const requests = [];
  const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async (url, options) => {
    requests.push({ url, options }); return json({ errcode: 0 });
  } });
  const message = { senderId: credentials.ownerId, conversationId: credentials.conversationId,
    replyContext: { sessionWebhook: webhook, expiresAt: Date.now() + 60_000 } };
  await provider.sendReply({ message, text: 'Fixture reply' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, webhook);
  assert.deepEqual(JSON.parse(requests[0].options.body), { msgtype: 'text', text: { content: 'Fixture reply' } });
  for (const context of [{ ...message.replyContext, expiresAt: 1 },
    { ...message.replyContext, sessionWebhook: 'https://oapi.dingtalk.com.evil.example/robot/sendBySession?session=x' },
    { ...message.replyContext, sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=fixture' }]) {
    await assert.rejects(provider.sendReply({ message: { ...message, replyContext: context }, text: 'Fixture reply' }));
  }
  await assert.rejects(provider.sendReply({ message: { ...message, senderId: 'other-user' }, text: 'Fixture reply' }));
  await assert.rejects(provider.sendReply({ message, text: '汉'.repeat(7000) }));
  assert.equal(requests.length, 1);
  await provider.stop();
  let attempts = 0;
  const uncertain = createProvider({ credentials, onMessage: async () => {}, fetch: async () => {
    attempts++; throw new Error('fixture-secret and fixture-session');
  } });
  await assert.rejects(uncertain.sendReply({ message, text: 'Fixture reply' }), error => error.message === 'DingTalk request failed.');
  await delay(10); assert.equal(attempts, 1); await uncertain.stop();
});

test('shutdown aborts an in-flight gateway request without opening a socket', async () => {
  const { Socket, instances } = socketFixture();
  let requestStarted = false;
  let aborted = false;
  const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async () => {},
    fetch: async (_url, options) => await new Promise((_resolve, reject) => {
      requestStarted = true;
      options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('fixture-abort')); }, { once: true });
    }),
  });
  await provider.start(); await until(() => requestStarted); await provider.stop();
  assert.equal(aborted, true); assert.equal(instances.length, 0);
  await assert.rejects(provider.start(), /stopped/u);
});

test('shutdown waits until an aborted in-flight reply has settled without retrying', async t => {
  const { Socket, instances } = socketFixture();
  let release;
  const draining = new Promise(resolve => { release = resolve; });
  let sending = false;
  let aborted = false;
  let attempts = 0;
  const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async () => {},
    fetch: async (url, options) => {
      if (url.endsWith('/gateway/connections/open')) return json({ endpoint, ticket: 'fixture-ticket' });
      attempts++;
      sending = true;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          void draining.then(() => reject(new Error('fixture-abort-after-cleanup')));
        }, { once: true });
      });
    },
  });
  t.after(async () => { release(); await provider.stop(); });
  await provider.start(); await until(() => instances.length === 1); instances[0].open();
  const message = { senderId: credentials.ownerId, conversationId: credentials.conversationId,
    replyContext: { sessionWebhook: webhook, expiresAt: Date.now() + 60_000 } };
  const rejected = assert.rejects(provider.sendReply({ message, text: 'Fixture reply' }), /DingTalk request failed/u);
  await until(() => sending);
  let stopped = false;
  const stop = provider.stop().then(() => { stopped = true; });
  await until(() => aborted); await delay(5);
  assert.equal(stopped, false);
  release(); await stop; await rejected;
  assert.equal(stopped, true); assert.equal(attempts, 1);
});
