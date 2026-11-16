// 夹具自检：结构、契约、秘密知情表、植入用例登记。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixture, validateFixture, CONTRACT_TAGS } from '../lib/canon.mjs';

const FIXTURE = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'fixture-a');

test('夹具 A 通过校验', async () => {
  const canon = await loadFixture(FIXTURE);
  const v = await validateFixture(canon);
  assert.equal(v.ok, true, `校验错误：\n${v.errors.join('\n')}`);
  assert.equal(canon.chapters.length, 6);
  assert.equal(canon.scenes.length, 6);
  assert.equal(canon.facts.length, 12);
  assert.ok(canon.facts.every((f) => f.found), '每条事实的引文都应能在原文里定位');
  assert.equal(canon.contracts.size, 6);
});

test('每章契约都带 9 个标签且不超长', async () => {
  const canon = await loadFixture(FIXTURE);
  for (const [chapter, c] of canon.contracts) {
    assert.deepEqual(c.tags, CONTRACT_TAGS, `${chapter} 契约标签不全`);
    assert.ok(c.length <= 800, `${chapter} 契约过长：${c.length} 字`);
  }
});

test('“八段”与 9 个标签的文档冲突被记为 warning', async () => {
  const canon = await loadFixture(FIXTURE);
  const v = await validateFixture(canon);
  assert.ok(
    v.warnings.some((w) => w.includes('八段') && w.includes('9')),
    `没有记录文档冲突：${JSON.stringify(v.warnings)}`,
  );
});

test('秘密的 knownBy 同时按 id 与姓名可查', async () => {
  const canon = await loadFixture(FIXTURE);
  const secret = canon.secrets.find((s) => s.id === 'secret_01');
  for (const k of secret.knownBy) {
    assert.ok(secret.knownByMap.get(k.who), `id ${k.who} 查不到`);
    const name = canon.charById.get(k.who).name;
    assert.ok(secret.knownByMap.get(name), `姓名 ${name} 查不到`);
  }
});

test('植入用例登记完整：15 个用例、8 类评价项', async () => {
  const canon = await loadFixture(FIXTURE);
  const m = canon.manifest;
  assert.equal(m.cases.length, 15);
  assert.equal(m.classes.length, 11);
  const official = m.classes.filter((c) => c.v01 !== '补充');
  assert.equal(official.length, 8, '启动卡要求 8 类植入错误');
  for (const c of m.cases) {
    assert.ok(c.expect, `${c.id} 缺 expect`);
    if (c.class === 'clean') continue;
    assert.ok(m.classes.some((k) => k.key === c.class), `${c.id} 的类别 ${c.class} 未登记`);
  }
  const gate = m.classes.filter((c) => c.gate).map((c) => c.key);
  assert.deepEqual(gate.sort(), ['address', 'appearance', 'auLeak', 'knowledge', 'tagDefault']);
});

test('场景覆盖 ch001-ch005，对照在 ch006', async () => {
  const canon = await loadFixture(FIXTURE);
  const canonScenes = canon.scenes.filter((s) => s.kind === 'canon');
  assert.equal(canonScenes.length, 5);
  assert.deepEqual(canonScenes.map((s) => s.chapter), ['ch001', 'ch002', 'ch003', 'ch004', 'ch005']);
  const control = canon.scenes.filter((s) => s.kind === 'control');
  assert.equal(control.length, 1);
  assert.equal(control[0].chapter, 'ch006');
});
