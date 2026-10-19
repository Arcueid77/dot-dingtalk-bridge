import WebSocketClient from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

const GATEWAY = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
const MAX_BODY = 1024 * 1024;
const HTTP_TIMEOUT = 15_000;

function boundedString(value, limit = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/u.test(value);
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
  let text = '';
  if (data.msgtype === 'text') text = data.text?.content;
  else if (data.msgtype === 'richText' && Array.isArray(content.richText)) {
    const pieces = [];
    for (const item of content.richText.slice(0, 100)) {
      if (typeof item?.text === 'string') pieces.push(item.text);
      if (item?.downloadCode || item?.pictureDownloadCode) attachments.push({ kind: 'image' });
    }
    text = pieces.join('');
  } else if (['image', 'picture', 'audio', 'video', 'file'].includes(data.msgtype)) {
    const kind = ({ picture: 'image', audio: 'audio' })[data.msgtype] ?? data.msgtype;
    const attachment = { kind };
    if (boundedString(content.fileName, 255)) attachment.name = content.fileName;
    attachments.push(attachment);
    // DingTalk may include its own transcription. No audio is downloaded here.
    if (data.msgtype === 'audio' && typeof content.recognition === 'string') text = content.recognition;
  } else return null;
  if (typeof text !== 'string') text = '';
  if (text.length > 20_000 || (!text.trim() && attachments.length === 0)) return null;
  return { text, attachments: attachments.slice(0, 10) };
}

export function createProvider({
  credentials, onMessage, signal, fetch = globalThis.fetch,
  WebSocket = WebSocketClient, timing = {},
}) {
  if (!credentials || typeof onMessage !== 'function' || typeof fetch !== 'function') {
    throw new Error('DingTalk provider configuration is invalid.');
  }
  const clientId = requireString(credentials.clientId);
  const clientSecret = requireString(credentials.clientSecret, 4096);
  const ownerId = requireString(credentials.ownerId);
  const conversationId = requireString(credentials.conversationId);
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

  function abort() {
    controller.abort();
    connected = false;
    socket?.terminate();
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  async function post(url, body) {
    try {
      const response = await fetch(url, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)]),
      });
      return await boundedJson(response);
    } catch { throw new Error('DingTalk request failed.'); }
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
    if (data.conversationType !== '1' || data.senderStaffId !== ownerId || data.conversationId !== conversationId ||
        data.robotCode !== robotCode || (corpId && data.chatbotCorpId !== corpId) ||
        (data.senderId && data.senderId === data.chatbotUserId)) {
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
    const message = {
      id: data.msgId, senderId: ownerId, conversationId, ...parts,
      replyDeadline: data.sessionWebhookExpiredTime,
      replyContext: { sessionWebhook: webhook, expiresAt: data.sessionWebhookExpiredTime },
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

  return {
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
      await Promise.allSettled([...tasks]);
    },
    status() { return { connected }; },
    async sendReply({ message, text }) {
      if (controller.signal.aborted) throw new Error('DingTalk provider has stopped.');
      if (message?.senderId !== ownerId || message?.conversationId !== conversationId ||
          typeof text !== 'string' || !text.trim() || text.length > 600 || Buffer.byteLength(text) > 1800) {
        throw new Error('DingTalk reply is invalid or exceeds the single-reply limit.');
      }
      const context = message.replyContext;
      if (!Number.isSafeInteger(context?.expiresAt) || context.expiresAt <= Date.now()) {
        throw new Error('DingTalk reply window has expired.');
      }
      const url = sessionUrl(context.sessionWebhook);
      const result = await post(url, { msgtype: 'text', text: { content: text } });
      if (result?.errcode !== 0) throw new Error('DingTalk reply was not confirmed.');
      return {};
    },
  };
}
