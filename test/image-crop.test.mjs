import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cropImage } from '../lib/image-crop.mjs';

test('cropImage 解析 JSON；非 Windows 不可用', async () => {
  const fake = (cmd, args, options, cb) => cb(null, JSON.stringify({ ok: true, width: 10, height: 20, out: 'C:/tmp/out.png' }), '');
  const result = await cropImage('C:/tmp/in.png', { x: 1, y: 2, w: 10, h: 20 }, 'C:/tmp/out.png', { platform: 'win32', execFileImpl: fake });
  assert.equal(result.ok, true);
  assert.equal(result.width, 10);
  const unavailable = await cropImage('C:/tmp/in.png', { x: 0, y: 0, w: 1, h: 1 }, 'C:/tmp/out.png', { platform: 'linux' });
  assert.equal(unavailable.available, false);
});

test('cropImage 真实裁剪（仅 Windows；无 System.Drawing 则跳过）', async (t) => {
  if (process.platform !== 'win32') return t.skip('not Windows');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fanfic-crop-'));
  try {
    const result = await cropImage(
      'D:/Novel-gate/dsh-novel-fanfic/test/fixtures/manga-page.png',
      { x: 40, y: 40, w: 300, h: 200 },
      path.join(dir, 'crop.png'),
      { timeoutMs: 30_000 },
    );
    if (!result.available) return t.skip(result.error || 'unavailable');
    assert.equal(result.ok, true);
    assert.equal((await stat(path.join(dir, 'crop.png'))).size > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
