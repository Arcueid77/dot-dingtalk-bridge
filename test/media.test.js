import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createProvider } from '../src/provider.js';
import { channel } from '../src/channel.js';
import { MAX_MEDIA, mediaUrl } from '../src/media.js';

const credentials = { clientId: 'fixture-app', clientSecret: 'fixture-secret', ownerId: 'fixture-owner', conversationId: 'fixture-chat' };
const endpoint = 'wss://wss-open-connection.dingtalk.com/connect';
const webhook = 'https://oapi.dingtalk.com/robot/sendBySession?session=fixture-session';
const downloadUrl = 'https://wukong-file-im-sz.oss-cn-shenzhen.aliyuncs.com/ddmedia%2Ffixture.png?Signature=fixture';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const png = Buffer.from('89504e470d0a1a0a0000000049454e44', 'hex');
const amr = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.from([4]), Buffer.alloc(12)]);
const message = (kind = 'image') => ({ senderId: credentials.ownerId, conversationId: credentials.conversationId,
  attachments: [{ kind, name: `fixture.${kind === 'image' ? 'png' : kind === 'audio' ? 'amr' : 'txt'}` }],
  replyContext: { sessionWebhook: webhook, expiresAt: Date.now() + 60_000, mediaRefs: [{ downloadCode: 'fixture-code' }] } });
const media = (type = 'image') => ({ type, data: type === 'image' ? png : type === 'audio' ? amr : Buffer.from('fixture document'),
  mimeType: type === 'image' ? 'image/png' : type === 'audio' ? 'audio/amr' : 'text/plain', name: `fixture.${type === 'image' ? 'png' : type === 'audio' ? 'amr' : 'txt'}` });

test('DingTalk exposes only implemented media capabilities', () => {
  assert.deepEqual(channel.media, { read: ['image', 'audio', 'file'], reply: ['image', 'audio', 'file'] });
  assert.equal(channel.maxMediaReplyText, 0);
});

test('media codes remain private and aligned across rich-text attachments', async t => {
  let socket;
  class Socket extends EventEmitter {
    constructor() { super(); socket = this; this.readyState = 1; }
    send(_body, cb) { cb?.(); }
    terminate() { this.emit('close'); }
  }
  let received;
  const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async value => { received = value; },
    fetch: async () => json({ endpoint, ticket: 'fixture-ticket' }),
  });
  t.after(() => provider.stop()); await provider.start();
  while (!socket) await delay(1);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'CALLBACK', headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'fixture-frame' },
    data: JSON.stringify({ msgId: 'fixture-message', senderStaffId: credentials.ownerId, conversationId: credentials.conversationId,
      conversationType: '1', robotCode: credentials.clientId, sessionWebhook: webhook, sessionWebhookExpiredTime: Date.now() + 60_000,
      msgtype: 'richText', content: { richText: [{ text: 'Caption' }, { downloadCode: 'fixture-one' }, { pictureDownloadCode: 'fixture-two' }] } }) })));
  while (!received) await delay(1);
  assert.deepEqual(received.attachments, [{ kind: 'image' }, { kind: 'image' }]);
  assert.deepEqual(received.replyContext.mediaRefs, [{ downloadCode: 'fixture-one' }, { downloadCode: 'fixture-two' }]);
});

test('image, voice and file are downloaded only by stored code without forwarding credentials to CDN', async t => {
  for (const kind of ['image', 'audio', 'file']) {
    const calls = [];
    const sample = media(kind);
    const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: 'fixture-access', expireIn: 7200 });
      if (url.endsWith('/messageFiles/download')) return json({ downloadUrl });
      return new Response(sample.data, { headers: { 'content-type': sample.mimeType } });
    } });
    t.after(() => provider.stop());
    const result = await provider.readAttachment({ message: message(kind), attachmentIndex: 0 });
    assert.deepEqual(result.data, sample.data);
    assert.equal(result.mimeType, sample.mimeType);
    assert.deepEqual(JSON.parse(calls[1].options.body), { robotCode: credentials.clientId, downloadCode: 'fixture-code' });
    assert.equal(calls[1].options.headers['x-acs-dingtalk-access-token'], 'fixture-access');
    assert.equal(calls[2].options.headers, undefined);
    assert.equal(calls[2].options.redirect, 'error');
    assert.equal(calls.length, 3);
  }
});

test('URL policy rejects impersonation, arbitrary buckets, HTTP, redirects and oversized bodies', async t => {
  assert.equal(mediaUrl(downloadUrl.replace(/^https:/u, 'http:')), downloadUrl);
  for (const url of ['http://down.dingtalk.com/media/file', 'https://down.dingtalk.com.evil.test/media/file',
    'https://down.dingtalk.com@evil.test/media/file', 'https://down.dingtalk.com:444/media/file',
    'https://down.dingtalk.com/private/file', 'https://customer.oss-cn-shenzhen.aliyuncs.com/ddmedia/x',
    'https://127.0.0.1/ddmedia/x', 'https://down.dingtalk.com/media/file#fragment']) assert.throws(() => mediaUrl(url));
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    new Response('x', { headers: { 'content-length': String(MAX_MEDIA + 1) } }), new Response(Buffer.alloc(MAX_MEDIA + 1))]) {
    const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async url => {
      if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: 'fixture-token', expireIn: 7200 });
      if (url.endsWith('/messageFiles/download')) return json({ downloadUrl });
      return response;
    } });
    t.after(() => provider.stop());
    await assert.rejects(provider.readAttachment({ message: message(), attachmentIndex: 0 }), /media download/u);
  }
});

test('download rejects a wrong owner, invalid index and an untrusted service-issued URL before fetching it', async t => {
  let count = 0;
  const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async url => {
    count++;
    return json(url.endsWith('/oauth2/accessToken') ? { accessToken: 'fixture-token', expireIn: 7200 } : { downloadUrl: 'https://evil.test/private' });
  } });
  t.after(() => provider.stop());
  await assert.rejects(provider.readAttachment({ message: { ...message(), senderId: 'other' }, attachmentIndex: 0 }));
  await assert.rejects(provider.readAttachment({ message: message(), attachmentIndex: -1 }));
  assert.equal(count, 0);
  await assert.rejects(provider.readAttachment({ message: message(), attachmentIndex: 0 }), /media URL/u);
  assert.equal(count, 2);
});

test('image, AMR and file upload then send exactly once to the bound owner', async t => {
  for (const type of ['image', 'audio', 'file']) {
    const calls = [];
    const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/gettoken?')) return json({ errcode: 0, access_token: 'fixture-oapi', expires_in: 7200 });
      if (url.includes('/media/upload?')) return json({ errcode: 0, media_id: '@fixture-upload' });
      if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: 'fixture-access', expireIn: 7200 });
      return json({ processQueryKey: 'fixture-reply' });
    } });
    t.after(() => provider.stop());
    assert.deepEqual(await provider.sendMediaReply({ message: message(), media: media(type) }), { providerMessageId: 'fixture-reply' });
    const upload = calls[1];
    assert.ok(upload.options.body instanceof FormData);
    assert.deepEqual(Buffer.from(await upload.options.body.get('media').arrayBuffer()), media(type).data);
    const sent = JSON.parse(calls.at(-1).options.body);
    assert.deepEqual(sent.userIds, [credentials.ownerId]);
    assert.equal(sent.robotCode, credentials.clientId);
    assert.equal(sent.msgKey, { image: 'sampleImageMsg', audio: 'sampleAudio', file: 'sampleFile' }[type]);
    if (type === 'audio') assert.equal(JSON.parse(sent.msgParam).duration, '20');
    assert.equal(calls.length, 4);
    for (const call of calls) assert.equal(call.options.redirect, 'error');
  }
});

test('invalid media is rejected synchronously and uncertain media sends are not retried', async t => {
  let sends = 0;
  const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async url => {
    if (url.includes('/gettoken?')) return json({ errcode: 0, access_token: 'fixture-oapi', expires_in: 7200 });
    if (url.includes('/media/upload?')) return json({ errcode: 0, media_id: '@fixture-upload' });
    if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: 'fixture-access', expireIn: 7200 });
    sends++;
    throw new Error('fixture-private-token must never escape');
  } });
  t.after(() => provider.stop());
  for (const invalid of [{ media: { ...media(), data: Buffer.alloc(MAX_MEDIA + 1) } }, { media: media(), text: 'caption' },
    { media: { ...media(), mimeType: 'image/jpeg' } }, { media: { ...media('audio'), data: Buffer.from('#!AMR\n') } },
    { media: { ...media('file'), name: '../private.txt' } }]) assert.throws(() => provider.validateMediaReply(invalid));
  await assert.rejects(provider.sendMediaReply({ message: message(), media: media() }), error => error.message === 'DingTalk request failed.');
  await delay(10); assert.equal(sends, 1);
});

test('revocation after authentication or upload stops media sending; async authorization fails closed', async t => {
  for (const revokeAt of [1, 2, 3]) {
    const calls = [];
    const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async url => {
      calls.push(url);
      if (url.includes('/gettoken?')) return json({ errcode: 0, access_token: 'fixture-oapi', expires_in: 7200 });
      if (url.includes('/media/upload?')) return json({ errcode: 0, media_id: '@fixture-upload' });
      if (url.endsWith('/oauth2/accessToken')) return json({ accessToken: 'fixture-access', expireIn: 7200 });
      throw new Error('Unexpected final send.');
    } });
    t.after(() => provider.stop());
    let checks = 0;
    await assert.rejects(provider.sendMediaReply({ message: message(), media: media(),
      authorize: () => { if (++checks === revokeAt) throw new Error('revoked'); },
    }), /revoked/u);
    assert.equal(calls.length, [0, 1, 3][revokeAt - 1]);
    const before = calls.length;
    await assert.rejects(provider.sendReply({ message: message(), text: 'fixture', authorize: async () => {} }), /synchronous/u);
    assert.equal(calls.length, before);
  }
});
