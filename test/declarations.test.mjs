// 作者私设声明的纯函数：收敛形状、增删、限额与错误。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDeclarations, normalizeDeclarations, addAuRule, removeAuRule,
  addHeadcanon, removeHeadcanon, addTypo, removeTypo,
  MAX_SIGNATURES, MAX_HEADCANON,
} from '../lib/declarations.mjs';

test('normalizeDeclarations 收敛形状：补空、去空项、去重、坏数据不炸', () => {
  assert.deepEqual(normalizeDeclarations(null), emptyDeclarations());
  const out = normalizeDeclarations({
    auRules: [
      { name: '回魂钟', signatures: ['回魂', ' 回魂 ', '亡者的声音'], text: ' 钟声 ' },
      { name: '', signatures: ['x'] },
      { name: '无签名', signatures: [] },
    ],
    headcanonSignatures: ['苏鹤是女儿', ' 苏鹤是女儿 ', ''],
    typos: { 沈研: '沈砚', 沈砚: '沈砚', '': 'x' },
  });
  assert.equal(out.auRules.length, 1);
  assert.deepEqual(out.auRules[0].signatures, ['回魂', '亡者的声音']);
  assert.equal(out.auRules[0].id, 'au_001');
  assert.deepEqual(out.headcanonSignatures, ['苏鹤是女儿']);
  assert.deepEqual(out.typos, { 沈研: '沈砚' });
});

test('addAuRule：同名更新签名；缺 name/signatures 报错；签名有上限', () => {
  let data = addAuRule(emptyDeclarations(), { name: '回魂钟', signatures: '回魂，亡者的声音', text: 'AU' });
  assert.equal(data.auRules.length, 1);
  assert.deepEqual(data.auRules[0].signatures, ['回魂', '亡者的声音']);
  data = addAuRule(data, { name: '回魂钟', signatures: ['借钟声'] });
  assert.equal(data.auRules.length, 1);
  assert.deepEqual(data.auRules[0].signatures, ['借钟声']);
  assert.equal(data.auRules[0].text, 'AU', '更新时保留原说明');

  assert.throws(() => addAuRule(emptyDeclarations(), { name: 'x' }), /signatures/);
  assert.throws(() => addAuRule(emptyDeclarations(), { signatures: ['x'] }), /name/);

  const many = Array.from({ length: MAX_SIGNATURES + 5 }, (_, i) => `签名${i}`).join(',');
  const capped = addAuRule(emptyDeclarations(), { name: '多', signatures: many });
  assert.equal(capped.auRules[0].signatures.length, MAX_SIGNATURES);
});

test('removeAuRule：按 id 或 name 删除，找不到报错', () => {
  let data = addAuRule(emptyDeclarations(), { name: '回魂钟', signatures: ['回魂'] });
  data = removeAuRule(data, 'au_001');
  assert.equal(data.auRules.length, 0);
  assert.throws(() => removeAuRule(data, 'au_404'), /没有这条 AU/);
});

test('headcanon：加/去重、按序号或文本删除、上限', () => {
  let data = addHeadcanon(emptyDeclarations(), '苏鹤是沈九的女儿');
  data = addHeadcanon(data, '苏鹤是沈九的女儿');
  assert.equal(data.headcanonSignatures.length, 1);
  data = addHeadcanon(data, '沈砚的母亲还活着');
  data = removeHeadcanon(data, 1);
  assert.deepEqual(data.headcanonSignatures, ['沈砚的母亲还活着']);
  assert.throws(() => removeHeadcanon(data, 9), /没有这条私设/);
  data = removeHeadcanon(data, '沈砚的母亲还活着');
  assert.equal(data.headcanonSignatures.length, 0);

  let big = emptyDeclarations();
  for (let i = 0; i < MAX_HEADCANON; i += 1) big = addHeadcanon(big, `私设 ${i}`);
  assert.throws(() => addHeadcanon(big, '再来一条'), /最多/);
});

test('typos：加/删、不许同字、删不存在报错', () => {
  let data = addTypo(emptyDeclarations(), '沈研', '沈砚');
  assert.deepEqual(data.typos, { 沈研: '沈砚' });
  assert.throws(() => addTypo(data, '沈砚', '沈砚'), /不能一样/);
  assert.throws(() => addTypo(data, '', '沈砚'), /--wrong 与 --right/);
  data = removeTypo(data, '沈研');
  assert.deepEqual(data.typos, {});
  assert.throws(() => removeTypo(data, '沈研'), /没有这个错名/);
});
