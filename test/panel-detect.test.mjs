import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPanels } from '../lib/panel-detect.mjs';

function canvas(w, h) {
  return new Uint8Array(w * h).fill(255);
}

function fill(gray, w, x0, y0, x1, y1, value = 0) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) gray[y * w + x] = value;
  }
}

test('左右两格：中间白缝切出 2 个面板', () => {
  const w = 100;
  const h = 100;
  const gray = canvas(w, h);
  fill(gray, w, 0, 0, 44, 100);
  fill(gray, w, 56, 0, 100, 100);
  const panels = detectPanels(gray, w, h);
  assert.equal(panels.length, 2);
  assert.deepEqual(panels.map((p) => [p.x, p.y, p.w, p.h]), [[0, 0, 44, 100], [56, 0, 44, 100]]);
});

test('2×2 页：先列后行递归切出 4 格', () => {
  const w = 100;
  const h = 100;
  const gray = canvas(w, h);
  fill(gray, w, 0, 0, 44, 44);
  fill(gray, w, 56, 0, 100, 44);
  fill(gray, w, 0, 56, 44, 100);
  fill(gray, w, 56, 56, 100, 100);
  const panels = detectPanels(gray, w, h);
  assert.equal(panels.length, 4);
  assert.deepEqual(panels.map((p) => [p.x, p.y]), [[0, 0], [56, 0], [0, 56], [56, 56]]);
});

test('全白返回 0；单个黑块返回 1；坏输入报错', () => {
  assert.deepEqual(detectPanels(canvas(50, 50), 50, 50), []);
  const gray = canvas(50, 50);
  fill(gray, 50, 10, 10, 40, 40);
  const one = detectPanels(gray, 50, 50);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], { x: 10, y: 10, w: 30, h: 30 });
  assert.throws(() => detectPanels(new Uint8Array(3), 2, 2), /数量/);
});
