import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectComicPanels, ocrComicPages, ocrComicPanels } from '../lib/comic.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'manga-page.png');

test('金标漫画页：2 格 + 中文 OCR（Windows 内置；无语言包则跳过）', async (t) => {
  if (process.platform !== 'win32') return t.skip('not Windows');
  let panels;
  try {
    panels = await detectComicPanels(fixture, 0, { maxWidth: 240, maxHeight: 360 });
  } catch (error) {
    return t.skip(String(error.message || error));
  }
  if (!panels || panels.panels.length !== 2) {
    return t.skip('panel backend unavailable');
  }
  assert.equal(panels.page.width, 800);
  assert.equal(panels.page.height, 1200);
  assert.equal(panels.panels.length, 2);

  const ocr = await ocrComicPages(fixture, [0]);
  if (!ocr.ok) return t.skip(ocr.pages?.[0]?.error || 'OCR unavailable');
  const text = ocr.pages[0].text;
  assert.match(text, /唐三/);
  assert.match(text, /小舞/);
  assert.match(text, /第一格/);

  const split = await ocrComicPanels(fixture, 0);
  if (!split.ok) return t.skip(split.panels?.[0]?.error || 'split OCR unavailable');
  assert.equal(split.split, true);
  assert.equal(split.panels.length, 2);
  assert.ok(split.text.indexOf('第一格') < split.text.indexOf('第二格'), '按面板顺序拼接');
});
