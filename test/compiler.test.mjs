// 契约编译器：从 canon + 场景生成 9 段契约，并与磁盘上的 contracts/ 对齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixture, CONTRACT_TAGS } from '../lib/canon.mjs';
import { compileContract, compileAll, contractDrift } from '../lib/compiler.mjs';

const FIXTURE = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'fixture-a');

const canon = await loadFixture(FIXTURE);
const byChapter = (ch) => compileContract(canon.sceneById.get(canon.scenes.find((s) => s.chapter === ch).id), canon);

test('六份契约都由编译器生成，9 个标签齐全且不超长', () => {
  const contracts = compileAll(canon);
  assert.equal(contracts.length, 6);
  for (const c of contracts) {
    assert.deepEqual(Object.keys(c.tags), CONTRACT_TAGS, `${c.chapter} 标签不全`);
    assert.ok(c.chars <= 800, `${c.chapter} 契约过长：${c.chars} 字`);
    assert.match(c.markdown, /^# 场景契约 ch\d{3}/);
    assert.match(c.hash, /^[0-9a-f]{40}$/);
  }
});

test('磁盘上的契约与编译器结果没有漂移', () => {
  const drift = contractDrift(canon);
  assert.deepEqual(drift, [], `发现漂移：${JSON.stringify(drift)}`);
});

test('ch002 契约写明改口、忌讳与必须出现的称呼', () => {
  const md = byChapter('ch002').markdown;
  assert.match(md, /本章起改口「阿砚」，不再用「沈先生」/);
  assert.match(md, /忌讳「小砚」/);
  assert.match(md, /必须出现：裴照叫沈砚「阿砚」/);
  assert.match(md, /【知情】.*沈砚、裴照不知情/);
});

test('导入长篇后世界规则上百条时，契约只取最近 4 条且不超长', () => {
  const rules = Array.from({ length: 30 }, (_, i) => ({
    id: `rule_x${i}`,
    text: `规则${i + 1}：这是一条用来测试长度上限的世界规则，内容尽量写长一点。`,
    status: 'confirmed',
    evidence: [{ chapter: 'ch001', offset: i, quote: '规则' }],
  }));
  const clone = { ...canon, worldRules: rules };
  const scene = canon.scenes.find((s) => s.chapter === 'ch002');
  const compiled = compileContract(scene, clone);
  const parts = compiled.tags.世界规则.split('；');
  assert.equal(parts.length, 4, '最多 4 条');
  assert.ok(compiled.chars <= 800, `契约超长：${compiled.chars}`);
});

test('没有声明「谁知道」的秘密不写知情边界（不编「都不知道」）', () => {
  const clone = { ...canon, secrets: canon.secrets.map((s) => ({ ...s, knownBy: [] })) };
  const scene = canon.scenes.find((s) => s.chapter === 'ch002');
  const md = compileContract(scene, clone).markdown;
  assert.match(md, /【知情】在场者之间没有需要隐瞒的知情边界/);
  assert.doesNotMatch(md, /还不知道/);
});

test('ch001 契约仍用公开称呼，且不误报“改口”', () => {
  const md = byChapter('ch001').markdown;
  assert.match(md, /仍用「沈先生」，还没到改口的时候/);
  assert.doesNotMatch(md, /本章起改口/);
});

test('ch005 契约提醒眼睛颜色未裁决，且称呼是沿用', () => {
  const md = byChapter('ch005').markdown;
  assert.match(md, /fc_001/);
  assert.match(md, /浅褐色 \/ 灰蓝色/);
  assert.match(md, /本章不要断言/);
  assert.match(md, /沿用「阿砚」/);
  assert.doesNotMatch(md, /本章起改口/);
});

test('ch004 契约把秘密交给苏鹤亲口说，并区分“已知情/本章才知情”', () => {
  const md = byChapter('ch004').markdown;
  assert.match(md, /苏鹤已知情，可以说/);
  assert.match(md, /沈砚本章才知道/);
  assert.match(md, /本章必须由苏鹤亲口说出/);
});

test('ch003 契约：苏鹤本章才知情且禁言，不重复写两遍', () => {
  const md = byChapter('ch003').markdown;
  assert.match(md, /苏鹤本章才知道，但不能说出口/);
  assert.doesNotMatch(md, /苏鹤知道这件事，但本章不许说出口/);
  assert.doesNotMatch(md, /undefined/);
});

test('契约锚点来自原著证据，不超过 2 条', () => {
  for (const c of compileAll(canon)) {
    const line = c.markdown.split('\n').find((l) => l.startsWith('【锚点】'));
    const count = (line.match(/（ch\d{3}）/g) || []).length;
    assert.ok(count >= 1 && count <= 2, `${c.chapter} 锚点数量异常：${line}`);
  }
});
