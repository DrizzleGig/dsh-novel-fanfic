import test from 'node:test';
import assert from 'node:assert/strict';
import { assertImageUrl, fetchImageBase64 } from '../lib/avatar-fetch.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function response(body, { status = 200, type = 'image/png', length = 0 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name === 'content-type') return type;
        if (name === 'content-length') return length ? String(length) : null;
        return null;
      },
    },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

test('allowlist：官方 CDN / Bing 缩略图 / 百度缩略图；拒绝 http/私网/未知域/端口', () => {
  for (const url of [
    'https://lain.bgm.tv/x.jpg',
    'https://s4.anilist.co/x.png',
    'https://media.kitsu.app/x.jpg',
    'https://cdn.myanimelist.net/x.jpg',
    'https://tse1.mm.bing.net/x.jpg',
    'https://th.bing.com/x.jpg',
    'https://img0.baidu.com/x.jpg',
  ]) {
    assert.equal(assertImageUrl(url).hostname.includes('.'), true, url);
  }
  for (const url of [
    'http://s4.anilist.co/x.png',
    'https://127.0.0.1/x.png',
    'https://evil.example/x.png',
    'https://s4.anilist.co:8443/x.png',
    'https://user:pass@s4.anilist.co/x.png',
  ]) {
    assert.throws(() => assertImageUrl(url), /https|allowlist|端口|凭据|无效/);
  }
});

test('下载合法图片：返回 base64/mime/宽高/hash，并强制 redirect:error', async () => {
  let seen = null;
  const result = await fetchImageBase64('https://s4.anilist.co/x.png', {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return response(PNG_1X1);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.base64, PNG_1X1.toString('base64'));
  assert.match(result.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(seen.init.redirect, 'error');
});

test('拒绝非图片/超大/空/坏图/失败状态', async () => {
  await assert.rejects(
    fetchImageBase64('https://s4.anilist.co/x.png', { fetchImpl: async () => response(PNG_1X1, { type: 'text/html' }) }),
    /不是图片/,
  );
  await assert.rejects(
    fetchImageBase64('https://s4.anilist.co/x.png', { fetchImpl: async () => response(PNG_1X1, { length: 6 * 1024 * 1024 }) }),
    /5MB/,
  );
  await assert.rejects(
    fetchImageBase64('https://s4.anilist.co/x.png', { fetchImpl: async () => response(Buffer.alloc(0)) }),
    /图片为空/,
  );
  await assert.rejects(
    fetchImageBase64('https://s4.anilist.co/x.png', { fetchImpl: async () => response(Buffer.from('not image')) }),
    /PNG\/JPEG\/WebP/,
  );
  await assert.rejects(
    fetchImageBase64('https://s4.anilist.co/x.png', { fetchImpl: async () => response(PNG_1X1, { status: 404 }) }),
    /图片请求失败/,
  );
});

test('无 Content-Length 的流式响应也按 5MB 上限截断', async () => {
  const chunks = Array.from({ length: 6 }, () => new Uint8Array(1024 * 1024));
  let cancelled = false;
  const body = {
    getReader() {
      let i = 0;
      return {
        async read() {
          return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined };
        },
        async cancel() { cancelled = true; },
      };
    },
  };
  const fake = {
    ok: true, status: 200,
    headers: { get(name) { if (name === 'content-type') return 'image/png'; return null; } },
    body,
    async arrayBuffer() { throw new Error('should stream'); },
  };
  await assert.rejects(
    fetchImageBase64('https://s4.anilist.co/x.png', { fetchImpl: async () => fake }),
    /5MB/,
  );
  assert.equal(cancelled, true);
});
