import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGray } from '../lib/image-gray.mjs';

test('loadGray 解析灰度 JSON；非 Windows 不可用', async () => {
  const gray = new Uint8Array([0, 128, 255, 64]);
  const fakeExec = (cmd, args, options, cb) => {
    cb(null, JSON.stringify({
      ok: true, width: 2, height: 2, originalWidth: 20, originalHeight: 20, scale: 0.1,
      gray: Buffer.from(gray).toString('base64'),
    }), '');
  };
  const result = await loadGray('C:/tmp/page.png', { platform: 'win32', execFileImpl: fakeExec });
  assert.equal(result.ok, true);
  assert.equal(result.width, 2);
  assert.equal(result.originalWidth, 20);
  assert.deepEqual(Array.from(result.gray), [0, 128, 255, 64]);

  const unavailable = await loadGray('C:/tmp/page.png', { platform: 'linux' });
  assert.equal(unavailable.available, false);
});

test('loadGray 读取真实图片（仅 Windows；无 System.Drawing 则跳过）', async (t) => {
  if (process.platform !== 'win32') return t.skip('not Windows');
  const result = await loadGray('D:/Novel-gate/docs/assets/fanfic-ui/fanfic-avatar-preview.png', { maxWidth: 60, maxHeight: 60 });
  if (!result.available) return t.skip(result.error || 'unavailable');
  assert.equal(result.ok, true);
  assert.equal(result.width > 0, true);
  assert.equal(result.gray.length, result.width * result.height);
});
