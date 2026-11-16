// 提示构造：三臂只差「契约」「检索结果」两块，其余模板必须一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixture } from '../lib/canon.mjs';
import { buildPrompt, sampleId, ARMS } from '../eval/lib/prompts.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const canon = await loadFixture(path.join(ROOT, 'fixtures', 'fixture-a'));
const scene = canon.sceneById.get('scene_2');

const prompts = Object.fromEntries(ARMS.map((arm) => [arm, buildPrompt({ scene, canon, arm, rep: 1 }).text]));

test('三条臂的提示都要求统一输出格式与字数', () => {
  for (const arm of ARMS) {
    const t = prompts[arm];
    assert.match(t, /【标签】原著向/);
    assert.match(t, /【正文】/);
    assert.match(t, /500/);
    assert.match(t, /900/);
    assert.ok(t.includes(scene.instruction), `${arm} 缺场景信息`);
  }
});

test('A 臂没有契约也没有检索结果', () => {
  assert.ok(!prompts.A.includes('【场景契约】'));
  assert.ok(!prompts.A.includes('【预取的原文检索结果】'));
});

test('B 臂有契约、没有检索结果', () => {
  assert.ok(prompts.B.includes('【场景契约】'));
  assert.ok(!prompts.B.includes('【预取的原文检索结果】'));
  assert.ok(prompts.B.includes('阿砚'), 'ch002 契约应包含改口信息');
});

test('C 臂在契约之外还有带出处的检索结果', () => {
  assert.ok(prompts.C.includes('【场景契约】'));
  assert.ok(prompts.C.includes('【预取的原文检索结果】'));
  assert.match(prompts.C, /命中：/);
  assert.match(prompts.C, /- ch\d{3}：/);
});

test('三臂正文（去掉两块附加内容后）除附加块外保持一致', () => {
  const strip = (t) => t
    .replace(/【场景契约】[\s\S]*?(?=\n【预取的原文检索结果】|\n【收尾要求】|$)/, '')
    .replace(/【预取的原文检索结果】[\s\S]*?(?=\n【收尾要求】|$)/, '')
    .replace(/\n{2,}/g, '\n');
  assert.equal(strip(prompts.B), strip(prompts.A));
  assert.equal(strip(prompts.C), strip(prompts.A));
});

test('样本编号稳定', () => {
  assert.equal(sampleId('A', 'scene_1', 1), 'A-scene_1-r01');
  assert.equal(sampleId('C', 'scene_5', 12), 'C-scene_5-r12');
});

test('三臂都把场景前提写成原著向，避免写手自标私设', () => {
  for (const arm of ARMS) {
    const { text } = buildPrompt({ scene, canon, arm });
    assert.match(text, /这是一个【原著向】同人场景/);
    assert.match(text, /第一行写【标签】原著向/);
  }
});

test('场景探针渲染进三臂，并声明契约优先', () => {
  for (const arm of ARMS) {
    const t = prompts[arm];
    assert.match(t, /【这一段必须写到】/, `${arm} 缺探针块`);
    for (const probe of scene.probes) assert.ok(t.includes(probe), `${arm} 缺探针：${probe}`);
    assert.match(t, /以契约为准/);
  }
});
