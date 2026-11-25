import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOcrText, ocrImage } from '../lib/windows-ocr.mjs';

test('normalizeOcrText 去掉中文之间的空格，保留换行', () => {
  assert.equal(normalizeOcrText('唐 三\n主 角'), '唐三\n主角');
  assert.equal(normalizeOcrText('A B\n唐 三'), 'A B\n唐三');
});

test('ocrImage 解析 PowerShell JSON；非 Windows 返回不可用', async () => {
  const fakeExec = (cmd, args, options, cb) => {
    cb(null, JSON.stringify({ ok: true, lang: 'zh-Hans-CN', text: '唐 三\n主 角', lines: ['唐 三', '主 角'] }), '');
  };
  const result = await ocrImage('C:/tmp/page.png', { platform: 'win32', execFileImpl: fakeExec });
  assert.equal(result.ok, true);
  assert.equal(result.lang, 'zh-Hans-CN');
  assert.equal(result.text, '唐三\n主角');

  const unavailable = await ocrImage('C:/tmp/page.png', { platform: 'linux' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.available, false);

  const broken = await ocrImage('C:/tmp/page.png', { platform: 'win32', execFileImpl: (c, a, o, cb) => cb(null, 'not json', '') });
  assert.equal(broken.ok, false);
});

test('ocrImage 读取真实中文截图（仅 Windows；无语言包则跳过）', async (t) => {
  if (process.platform !== 'win32') return t.skip('not Windows');
  const file = 'D:/Novel-gate/docs/assets/fanfic-ui/fanfic-avatar-preview.png';
  const result = await ocrImage(file);
  if (!result.available) return t.skip(result.error || 'OCR unavailable');
  assert.equal(result.ok, true);
  assert.match(result.text, /人|形|象|唐|三/);
});
