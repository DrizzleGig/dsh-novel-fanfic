// 头像图片下载：只允许已知图片 CDN，拒绝私网/重定向/非图片/超大。
// 搜图结果优先取缩略图 URL（Bing turl / 百度 thumbURL），避免任意站热链。
import { imageInfo } from './avatars.mjs';
import { sha256Buffer } from './hash.mjs';

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const HOST_ALLOWLIST = [
  'lain.bgm.tv',
  's4.anilist.co',
  'media.kitsu.app',
  'cdn.myanimelist.net',
  't.vndb.org',
];
const HOST_SUFFIXES = ['mm.bing.net', 'bing.com', 'baidu.com'];

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  return HOST_ALLOWLIST.includes(host) || HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function assertImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('图片 URL 无效');
  }
  if (url.protocol !== 'https:') throw new Error('只允许 https 图片');
  if (url.username || url.password) throw new Error('图片 URL 不能带凭据');
  if (url.port && url.port !== '443') throw new Error('图片 URL 端口不允许');
  if (!hostAllowed(url.hostname)) throw new Error(`图片域名不在 allowlist：${url.hostname}`);
  return url;
}

export async function fetchImageBase64(rawUrl, options = {}) {
  const url = assertImageUrl(rawUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前宿主没有 fetch');
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(30_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'User-Agent': 'dsh-novel-fanfic/0.4 (local fanfic studio)',
        Accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8',
      },
    });
    if (!res || res.ok === false) throw new Error(`图片请求失败${res?.status ? ` HTTP ${res.status}` : ''}`);
    const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) throw new Error('响应不是图片');
    const length = Number(res.headers?.get?.('content-length') || 0);
    if (length > MAX_BYTES) throw new Error('图片超过 5MB');
    let buffer;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('图片超过 5MB');
        }
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks, total);
    } else {
      buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_BYTES) throw new Error('图片超过 5MB');
    }
    if (!buffer.length) throw new Error('图片为空');
    const info = imageInfo(buffer);
    if (!info) throw new Error('只支持 PNG/JPEG/WebP');
    return {
      ok: true,
      base64: buffer.toString('base64'),
      mime: info.mime,
      width: info.width,
      height: info.height,
      hash: `sha256:${sha256Buffer(buffer)}`,
      sourceUrl: url.toString(),
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('图片请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
