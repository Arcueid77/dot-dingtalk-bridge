import WebSocketClient from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { amrDuration, attachmentMime, mediaName, mediaUrl, readMedia, validateMediaReply } from './media.js';
import {channel} from './channel.js';

const GATEWAY = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
const MAX_BODY = 1024 * 1024;
const HTTP_TIMEOUT = 15_000;

function boundedString(value, limit = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
}

function authorizeSend(authorize) {
  if (authorize === undefined) return;
  if (typeof authorize !== 'function') throw new Error('DingTalk send authorization is invalid.');
  const result = authorize();
  if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  if (result !== undefined) throw new Error('DingTalk send authorization must be synchronous.');
}

function requireString(value, limit = 512) {
  if (!boundedString(value, limit)) throw new Error('DingTalk credentials are incomplete or invalid.');
  return value;
}

function sessionUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('DingTalk reply context is invalid.');
  let url;
  try { url = new URL(value); } catch { throw new Error('DingTalk reply context is invalid.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' || url.port ||
      url.username || url.password || url.hash || url.pathname !== '/robot/sendBySession' ||
      [...url.searchParams.keys()].some(key => key !== 'session') ||
      url.searchParams.getAll('session').length !== 1 || !boundedString(url.searchParams.get('session'), 4096)) {
    throw new Error('DingTalk reply context is invalid.');
  }
  return url.href;
}

function connectionUrl(endpoint, ticket) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('DingTalk gateway endpoint is invalid.'); }
  // This host is the public Stream endpoint documented by DingTalk. Do not let
  // a gateway response turn the short-lived ticket into an arbitrary-host token.
  if (url.protocol !== 'wss:' || url.hostname !== 'wss-open-connection.dingtalk.com' ||
      (url.port && url.port !== '443') || url.pathname !== '/connect' || url.search ||
      url.username || url.password || url.hash || !boundedString(ticket, 8192)) {
    throw new Error('DingTalk gateway endpoint is invalid.');
  }
  url.searchParams.set('ticket', ticket);
  return url.href;
}

async function boundedJson(response) {
  if (!response || !response.ok || response.status >= 300 || response.redirected) {
    try { await response?.body?.cancel(); } catch { /* no raw transport diagnostics */ }
    throw new Error('DingTalk request failed.');
  }
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY)) {
    try { await response.body?.cancel(); } catch { /* ignored */ }
    throw new Error('DingTalk response exceeded its limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('DingTalk response is invalid.');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error('DingTalk response exceeded its limit.');
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    try { await reader.cancel(); } catch { /* ignored */ }
    throw new Error('DingTalk response is invalid.');
  } finally { reader.releaseLock(); }
}

function contentParts(data) {
  const content = data.content && typeof data.content === 'object' ? data.content : {};
  const attachments = [];
  const mediaRefs = [];
  function add(kind, item) {
    if (attachments.length >= 10) return;
    const attachment = { kind };
    if (mediaName(item.fileName)) attachment.name = item.fileName;
    attachments.push(attachment);
    const code = item.downloadCode ?? item.pictureDownloadCode;
    mediaRefs.push(boundedString(code, 4096) && ['image', 'audio', 'file'].includes(kind) ? { downloadCode: code } : null);
  }
  let text = '';
  if (data.msgtype === 'text') text = data.text?.content;
  else if (data.msgtype === 'richText' && Array.isArray(content.richText)) {
    const pieces = [];
    for (const item of content.richText.slice(0, 100)) {
      if (typeof item?.text === 'string') pieces.push(item.text);
      if (item?.downloadCode || item?.pictureDownloadCode) add('image', item);
    }
    text = pieces.join('');
  } else if (['image', 'picture', 'audio', 'video', 'file'].includes(data.msgtype)) {
    const kind = ({ picture: 'image', audio: 'audio' })[data.msgtype] ?? data.msgtype;
    add(kind, content);
    // DingTalk may include its own transcription. No audio is downloaded here.
    if (data.msgtype === 'audio' && typeof content.recognition === 'string') text = content.recognition;
  } else return null;
  if (typeof text !== 'string') text = '';
  if (text.length > 20_000 || (!text.trim() && attachments.length === 0)) return null;
  return { text, attachments, mediaRefs };
}

function createTransport({
  credentials, onMessage, signal, fetch = globalThis.fetch,
  WebSocket = WebSocketClient, timing = {},
}, onPairingMessage) {
  if (!credentials || typeof onMessage !== 'function' || typeof fetch !== 'function') {
    throw new Error('DingTalk provider configuration is invalid.');
  }
  const clientId = requireString(credentials.clientId);
  const clientSecret = requireString(credentials.clientSecret, 4096);
  const ownerId = onPairingMessage ? undefined : requireString(credentials.ownerId, 256);
  const conversationId = onPairingMessage ? undefined : requireString(credentials.conversationId, 256);
  const robotCode = requireString(credentials.robotCode ?? clientId);
  const corpId = credentials.corpId === undefined ? undefined : requireString(credentials.corpId);
  const controller = new AbortController();
  const requestTimeout = timing.requestTimeoutMs ?? HTTP_TIMEOUT;
  const retryBase = timing.reconnectMs ?? 1000;
  let socket;
  let runner;
  let started = false;
  let stopped = false;
  let connected = false;
  const tasks = new Set();
  const sends = new Set();
  let access;
  let oapiAccess;

  function abort() {
    controller.abort();
    connected = false;
    socket?.terminate();
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  async function post(url, body, headers = {}) {
    try {
      const response = await fetch(url, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)]),
      });
      return await boundedJson(response);
    } catch { throw new Error('DingTalk request failed.'); }
  }

  async function token(legacy = false) {
    const current = legacy ? oapiAccess : access;
    if (current?.expires > Date.now() + 60_000) return current.value;
    let result;
    if (legacy) {
      const url = new URL('https://oapi.dingtalk.com/gettoken');
      url.searchParams.set('appkey', clientId);
      url.searchParams.set('appsecret', clientSecret);
      try {
        result = await boundedJson(await fetch(url.href, { method: 'GET', redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)]),
        }));
      } catch { throw new Error('DingTalk authentication failed.'); }
      if (result.errcode !== 0) throw new Error('DingTalk authentication failed.');
    } else result = await post('https://api.dingtalk.com/v1.0/oauth2/accessToken', { appKey: clientId, appSecret: clientSecret });
    const value = legacy ? result.access_token : result.accessToken;
    const ttl = legacy ? result.expires_in : result.expireIn;
    if (!boundedString(value, 4096) || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86_400) throw new Error('DingTalk authentication failed.');
    const entry = { value, expires: Date.now() + ttl * 1000 };
    if (legacy) oapiAccess = entry; else access = entry;
    return value;
  }

  function ownMessage(message) {
    if (message?.senderId !== ownerId || message?.conversationId !== conversationId) throw new Error('DingTalk message binding is invalid.');
    if (!Number.isSafeInteger(message.replyContext?.expiresAt) || message.replyContext.expiresAt <= Date.now()) throw new Error('DingTalk reply window has expired.');
    sessionUrl(message.replyContext.sessionWebhook);
  }

  async function track(work) {
    sends.add(work);
    try { return await work; } finally { sends.delete(work); }
  }

  function write(source, payload) {
    if (controller.signal.aborted || source !== socket || source.readyState !== 1) return;
    try { source.send(JSON.stringify(payload), error => { if (error) source.terminate(); }); }
    catch { source.terminate(); }
  }

  function acknowledge(source, frame) {
    write(source, {
      code: 200, headers: { contentType: 'application/json', messageId: frame.headers.messageId },
      message: 'OK', data: JSON.stringify({ response: null }),
    });
  }

  async function handleCallback(source, frame) {
    let data;
    try { data = JSON.parse(frame.data); } catch { return; }
    if (!data || typeof data !== 'object') return;
    // This first version deliberately binds one private conversation. Core
    // checks the same pair again before committing any message.
    if (data.conversationType !== '1' || (!onPairingMessage && (data.senderStaffId !== ownerId || data.conversationId !== conversationId)) ||
        data.robotCode !== robotCode || (corpId && data.chatbotCorpId !== corpId) ||
        (data.senderId && data.senderId === data.chatbotUserId)) {
      acknowledge(source, frame);
      return;
    }
    if (onPairingMessage) {
      if (data.msgtype === 'text' && boundedString(data.senderStaffId, 256) && boundedString(data.conversationId, 256) &&
          !data.isForward && !data.isForwarded && !data.forwarded && !data.forward && !data.quotedMessage) {
        await onPairingMessage({ text: data.text?.content, ownerId: data.senderStaffId, conversationId: data.conversationId,
          ...(Number.isSafeInteger(data.createAt) ? { timestamp: data.createAt } : {}) });
      }
      acknowledge(source, frame);
      return;
    }
    const parts = contentParts(data);
    if (!parts || !boundedString(data.msgId, 256) || !Number.isSafeInteger(data.sessionWebhookExpiredTime)) {
      acknowledge(source, frame);
      return;
    }
    let webhook;
    try { webhook = sessionUrl(data.sessionWebhook); } catch { acknowledge(source, frame); return; }
    const { mediaRefs, ...content } = parts;
    const message = {
      id: data.msgId, senderId: ownerId, conversationId, ...content,
      replyDeadline: data.sessionWebhookExpiredTime,
      replyContext: { sessionWebhook: webhook, expiresAt: data.sessionWebhookExpiredTime, ...(mediaRefs.length ? { mediaRefs } : {}) },
    };
    if (Number.isSafeInteger(data.createAt) && data.createAt > 0) message.timestamp = data.createAt;
    await onMessage(message);
    acknowledge(source, frame);
  }

  async function connection() {
    const gateway = await post(GATEWAY, {
      clientId, clientSecret, ua: 'dot-dingtalk-bridge/0.1.0',
      subscriptions: [{ type: 'CALLBACK', topic: ROBOT_TOPIC }],
    });
    const url = connectionUrl(gateway.endpoint, gateway.ticket);
    if (controller.signal.aborted) return;
    await new Promise(resolve => {
      let idleTimer;
      const source = new WebSocket(url, {
        followRedirects: false, maxPayload: MAX_BODY, handshakeTimeout: requestTimeout,
        perMessageDeflate: false, rejectUnauthorized: true,
      });
      socket = source;
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => source.terminate(), timing.idleTimeoutMs ?? 120_000);
      };
      source.on('open', () => { if (controller.signal.aborted) source.terminate(); else { connected = true; touch(); } });
      source.on('error', () => source.terminate());
      source.on('close', () => {
        clearTimeout(idleTimer);
        if (socket === source) { socket = undefined; connected = false; }
        resolve();
      });
      source.on('message', raw => {
        touch();
        if (controller.signal.aborted || source !== socket || raw.length > MAX_BODY) return;
        let frame;
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        if (!frame || !boundedString(frame.headers?.messageId)) return;
        if (frame.type === 'SYSTEM') {
          if (frame.headers.topic === 'ping' || frame.headers.topic === 'disconnect') {
            write(source, { code: 200, headers: { contentType: 'application/json', messageId: frame.headers.messageId }, message: 'OK', data: frame.data ?? '' });
            if (frame.headers.topic === 'disconnect') source.close();
          }
          return;
        }
        if (frame.type !== 'CALLBACK' || frame.headers.topic !== ROBOT_TOPIC || typeof frame.data !== 'string') return;
        if (tasks.size >= 32) { source.terminate(); return; }
        const task = handleCallback(source, frame).catch(() => source.terminate());
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      });
    });
  }

  async function run() {
    let backoff = retryBase;
    while (!controller.signal.aborted) {
      const before = Date.now();
      try { await connection(); } catch { /* retry connection only; no raw diagnostics */ }
      if (controller.signal.aborted) break;
      if (Date.now() - before > 60_000) backoff = retryBase;
      try { await delay(backoff, undefined, { signal: controller.signal }); } catch { break; }
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  const provider = {
    async start() {
      if (stopped) throw new Error('DingTalk provider has stopped.');
      if (started) return;
      started = true;
      runner = run();
    },
    async stop() {
      stopped = true;
      abort();
      signal?.removeEventListener('abort', abort);
      await runner;
      await Promise.allSettled([...tasks, ...sends]);
    },
    status() { return { connected }; },
    validateMediaReply,
    async readAttachment({ message, attachmentIndex }) {
      ownMessage(message);
      if (controller.signal.aborted) throw new Error('DingTalk provider has stopped.');
      const attachment = message.attachments?.[attachmentIndex];
      const reference = message.replyContext.mediaRefs?.[attachmentIndex];
      if (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0 || !['image', 'audio', 'file'].includes(attachment?.kind) ||
          !boundedString(reference?.downloadCode, 4096)) throw new Error('DingTalk attachment is unavailable.');
      return track((async () => {
        const value = await token();
        const result = await post('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
          downloadCode: reference.downloadCode, robotCode,
        }, { 'x-acs-dingtalk-access-token': value });
        const url = mediaUrl(result.downloadUrl);
        try {
          const response = await fetch(url, { method: 'GET', redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)]),
          });
          const data = await readMedia(response);
          return { data, mimeType: attachmentMime(data, attachment.kind, response.headers.get('content-type')),
            ...(attachment.name ? { name: attachment.name } : {}) };
        } catch { throw new Error('DingTalk media download failed or exceeded 5 MiB.'); }
      })());
    },
    async sendMediaReply({ message, media, text, authorize }) {
      ownMessage(message);
      validateMediaReply({ media, text });
      if (controller.signal.aborted) throw new Error('DingTalk provider has stopped.');
      return track((async () => {
        authorizeSend(authorize);
        const uploadToken = await token(true);
        const url = new URL('https://oapi.dingtalk.com/media/upload');
        url.searchParams.set('access_token', uploadToken);
        url.searchParams.set('type', media.type === 'audio' ? 'voice' : media.type);
        const form = new FormData();
        form.append('media', new Blob([media.data], { type: media.mimeType }), media.name);
        let result;
        authorizeSend(authorize);
        try {
          result = await boundedJson(await fetch(url.href, { method: 'POST', body: form, redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)]),
          }));
        } catch { throw new Error('DingTalk media upload failed.'); }
        if (result.errcode !== 0 || !boundedString(result.media_id, 512) || !/^@?[A-Za-z0-9_.-]+$/u.test(result.media_id)) throw new Error('DingTalk media upload was not confirmed.');
        const value = await token();
        ownMessage(message);
        let msgKey;
        let msgParam;
        if (media.type === 'image') { msgKey = 'sampleImageMsg'; msgParam = { photoURL: result.media_id }; }
        else if (media.type === 'audio') {
          msgKey = 'sampleAudio';
          msgParam = { mediaId: `https://down.dingtalk.com/media/${result.media_id.replace(/^@/u, '')}`, duration: String(amrDuration(media.data)) };
        } else {
          msgKey = 'sampleFile';
          const extension = /\.([A-Za-z0-9]{1,16})$/u.exec(media.name)?.[1]?.toLowerCase() ?? 'file';
          msgParam = { mediaId: result.media_id, fileName: media.name, fileType: extension };
        }
        // The target comes from the persisted owner binding, never a tool argument.
        authorizeSend(authorize);
        const sent = await post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
          robotCode, userIds: [ownerId], msgKey, msgParam: JSON.stringify(msgParam),
        }, { 'x-acs-dingtalk-access-token': value });
        if (!boundedString(sent.processQueryKey, 512) || (Array.isArray(sent.invalidStaffIdList) && sent.invalidStaffIdList.length)) throw new Error('DingTalk media reply was not confirmed.');
        return { providerMessageId: sent.processQueryKey };
      })());
    },
    async sendReply({ message, text, idempotencyKey, authorize }) {
      if (controller.signal.aborted) throw new Error('DingTalk provider has stopped.');
      if (message?.senderId !== ownerId || message?.conversationId !== conversationId ||
          typeof text !== 'string' || !text.trim() || !text.isWellFormed() ||
          text.length > channel.maxReplyText || Buffer.byteLength(text) > 60000) {
        throw new Error('DingTalk reply is invalid or exceeds the single-reply limit.');
      }
      const context = message.replyContext;
      if (!Number.isSafeInteger(context?.expiresAt) || context.expiresAt <= Date.now()) {
        throw new Error('DingTalk reply window has expired.');
      }
      if (text.length > channel.nativeMaxReplyText || Buffer.byteLength(text) > 1800) {
        const data = Buffer.from(text, 'utf8');
        try { return await provider.sendMediaReply({message, media: {type: 'file', data, mimeType: 'text/plain', name: 'answer.txt'}, idempotencyKey, authorize}); }
        finally { data.fill(0); }
      }
      const url = sessionUrl(context.sessionWebhook);
      const work = (async () => {
        authorizeSend(authorize);
        const result = await post(url, { msgtype: 'text', text: { content: text } });
        if (result?.errcode !== 0) throw new Error('DingTalk reply was not confirmed.');
        return {};
      })();
      sends.add(work);
      try { return await work; }
      finally { sends.delete(work); }
    },
  };
  return provider;
}

export function createProvider(options) { return createTransport(options); }

// Enrollment is a separate opt-in consumer with no send/read capability. The
// normal live factory always requires and enforces the persisted owner binding.
export function createEnrollmentProvider(options) {
  if (options?.confirmStopped !== true || typeof options.onPairingMessage !== 'function') throw new Error('DingTalk pairing requires confirmation that the old consumer is stopped.');
  const provider = createTransport({ ...options, onMessage: async () => {} }, options.onPairingMessage);
  return { start: provider.start, stop: provider.stop, status: provider.status };
}
