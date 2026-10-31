import {MAX_MEDIA_BYTES as MAX_MEDIA} from '@dot-bridge/core/channels/media.js';
export {MAX_MEDIA};

// Fixed DingTalk delivery origins. Generic *.aliyuncs.com would also trust
// arbitrary customer buckets and is intentionally not accepted.
const OSS_ORIGIN = 'wukong-file-im-sz.oss-cn-shenzhen.aliyuncs.com';
export function mediaUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\\]/u.test(value)) throw new Error('DingTalk media URL is invalid.');
  let url;
  try { url = new URL(value); } catch { throw new Error('DingTalk media URL is invalid.'); }
  const path = url.pathname;
  const official = (url.hostname === 'down.dingtalk.com' && /^\/media\/[A-Za-z0-9_@.-]+$/u.test(path)) ||
    (url.hostname === OSS_ORIGIN && /^\/ddmedia(?:\/|%2[fF])[A-Za-z0-9_%./-]+$/u.test(path));
  // The official download service can return an HTTP signed OSS URL. Only this
  // exact bucket is normalized; no HTTP request or redirect is ever followed.
  if (url.protocol === 'http:' && url.hostname === OSS_ORIGIN && !url.port) url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !official ||
      /(?:^|\/)\.{1,2}(?:\/|$)/u.test(decodeURIComponent(path))) throw new Error('DingTalk media URL is invalid.');
  return url.href;
}

export function mediaName(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 255 &&
    !/[\u0000-\u001f\u007f/\\]/u.test(value) && value !== '.' && value !== '..';
}

export function imageMime(data) {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  throw new Error('DingTalk image must be PNG, JPEG or GIF.');
}

export function amrDuration(data) {
  if (data.subarray(0, 6).toString('ascii') !== '#!AMR\n') throw new Error('DingTalk voice requires AMR audio.');
  const sizes = [13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 0, 1];
  let frames = 0;
  for (let offset = 6; offset < data.length;) {
    if ((data[offset] & 0x83) !== 0) throw new Error('DingTalk AMR audio is invalid.');
    const size = sizes[(data[offset] >> 3) & 15];
    if (!size || offset + size > data.length) throw new Error('DingTalk AMR audio is invalid.');
    offset += size;
    frames++;
  }
  if (!frames || frames > 3000) throw new Error('DingTalk voice must be between 20 ms and 60 seconds.');
  return frames * 20;
}

export function validateMediaReply({ media, text }) {
  if (!media || !['image', 'audio', 'file'].includes(media.type) || !Buffer.isBuffer(media.data) ||
      !media.data.length || media.data.length > MAX_MEDIA || !mediaName(media.name) ||
      typeof media.mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(media.mimeType) ||
      (text !== undefined && text !== '')) throw new Error('DingTalk media requires one file up to 5 MiB without a caption.');
  if (media.type === 'image' && imageMime(media.data) !== media.mimeType) throw new Error('DingTalk image type does not match its content.');
  if (media.type === 'audio') {
    if (media.mimeType !== 'audio/amr' || media.data.length > 2 * 1024 * 1024) throw new Error('DingTalk voice requires an AMR file up to 2 MiB.');
    amrDuration(media.data);
  }
}

export function attachmentMime(data, kind, header) {
  if (kind === 'image') return imageMime(data);
  if (kind === 'audio') {
    if (data.subarray(0, 6).toString('ascii') === '#!AMR\n') return 'audio/amr';
    if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
    if (data.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
    if (data.subarray(0, 3).toString('ascii') === 'ID3' || (data[0] === 255 && (data[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
    throw new Error('DingTalk audio format is unsupported.');
  }
  const type = (header ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type) ? type : 'application/octet-stream';
}

export async function readMedia(response) {
  let reader;
  try {
    const declared = response?.headers?.get?.('content-length');
    if (!response?.ok || response.status >= 300 || response.redirected ||
        (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_MEDIA))) throw new Error();
    reader = response.body?.getReader();
    if (!reader) throw new Error();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MEDIA) throw new Error();
      parts.push(Buffer.from(value));
    }
    if (!size) throw new Error();
    return Buffer.concat(parts);
  } catch {
    try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* no raw URL diagnostics */ }
    throw new Error('DingTalk media download failed or exceeded 5 MiB.');
  } finally { reader?.releaseLock(); }
}
