// 本作设定（Fic Canon）：形状、增删、契约【本作】段、检查器放过。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyDeltas, normalizeDeltas, addDelta, removeDelta, setPremise,
  deltaSuppresses, DELTA_KINDS,
} from '../lib/deltas.mjs';
import { compileContract, DELTA_TAG } from '../lib/compiler.mjs';
import { runCheck } from '../lib/checker.mjs';

function bareCanon(extra = {}) {
  const characters = [
    { id: 'char_a', name: '沈砚', aliases: [], firstChapter: 'ch001', lastChapter: null, evidence: [] },
    { id: 'char_b', name: '裴照', aliases: [], firstChapter: 'ch001', lastChapter: null, evidence: [] },
  ];
  const charById = new Map(characters.map((c) => [c.id, c]));
  const charByName = new Map(characters.map((c) => [c.name, c]));
  return {
    characters,
    charById,
    charByName,
    formToChar: new Map(characters.flatMap((c) => [[c.name, c], ...(c.aliases || []).map((a) => [a, c])])),
    facts: [],
    factById: new Map(),
    typoMap: new Map(),
    typos: {},
    worldRules: [],
    secrets: [],
    addressRules: [],
    contradictions: [],
    factContradictions: [],
    auRules: [],
    auSignatures: [],
    headcanonSignatures: [],
    terms: characters.map((c) => c.name),
    chapters: [],
    scenes: [],
    source: '',
    ...extra,
  };
}

function scene(extra = {}) {
  return {
    id: 'scene_2',
    chapter: 'ch002',
    kind: 'canon',
    tag: '原著向',
    pov: 'char_a',
    present: ['char_a', 'char_b'],
    register: '第三人称受限',
    timeline: '紧接 ch001 之后',
    requiredForms: [],
    mustReveal: [],
    probes: [],
    contractFile: 'contracts/ch002.md',
    ...extra,
  };
}

test('normalizeDeltas：缺字段补空、去空项、去重 id、限条数', () => {
  const out = normalizeDeltas({
    premise: '  如果裴照在 ch002 就认出了沈砚  ',
    items: [
      { id: 'dl_001', kind: 'relationship', title: ' 裴照与沈砚是恋人 ', statement: ' 本作中两人自 ch002 起是恋人。 ', subjects: '裴照，沈砚', fromChapter: 'ch2' },
      { kind: 'nope', title: '', statement: '缺标题' },
      { kind: 'timeline', title: '时间线提前', statement: '裴照提前知道。', fromChapter: 'ch002' },
      { id: 'dl_001', kind: 'world', title: '重复 id', statement: '应换新 id。' },
    ],
  });
  assert.equal(out.premise, '如果裴照在 ch002 就认出了沈砚');
  assert.equal(out.items.length, 3);
  assert.equal(out.items[0].kind, 'relationship');
  assert.deepEqual(out.items[0].subjects, ['裴照', '沈砚']);
  assert.equal(out.items[0].fromChapter, 'ch002');
  assert.equal(out.items[2].kind, 'world');
  assert.notEqual(out.items[0].id, out.items[2].id);
});

test('addDelta / removeDelta / setPremise：可增删，重复标题合并 suppress', () => {
  let data = emptyDeltas();
  data = setPremise(data, '一句话前提');
  data = addDelta(data, {
    kind: 'relationship',
    title: '裴照与沈砚是恋人',
    statement: '本作中两人自 ch002 起是恋人。',
    subjects: ['裴照', '沈砚'],
    fromChapter: 'ch002',
  });
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, 'dl_001');
  const first = data.items[0];
  data = addDelta(data, {
    kind: 'relationship',
    title: '裴照与沈砚是恋人',
    statement: '本作中两人自 ch002 起是恋人。',
    suppress: [{ detector: 'address', code: 'address_retired', quote: '沈先生', chapter: 'ch002' }],
  });
  assert.equal(data.items.length, 1, '同标题同说明不重复落盘');
  assert.equal(data.items[0].suppress.length, 1);
  assert.equal(data.items[0].id, first.id);
  data = removeDelta(data, 'dl_001');
  assert.equal(data.items.length, 0);
});

test('deltaSuppresses：同 detector/code 且 quote 命中才放过；fromChapter 之前不放过', () => {
  const delta = {
    id: 'dl_001',
    fromChapter: 'ch002',
    suppress: [{ detector: 'address', code: 'address_retired', quote: '沈先生', chapter: 'ch002' }],
  };
  assert.equal(deltaSuppresses(delta, { detector: 'address', code: 'address_retired', quote: '沈先生。', chapter: 'ch002' }), true);
  assert.equal(deltaSuppresses(delta, { detector: 'address', code: 'address_retired', quote: '沈先生', chapter: 'ch001' }), false);
  assert.equal(deltaSuppresses(delta, { detector: 'address', code: 'address_taboo', quote: '沈先生', chapter: 'ch002' }), false);
  assert.equal(deltaSuppresses(delta, { detector: 'address', code: 'address_retired', quote: '裴副队', chapter: 'ch002' }), false);
});

test('compileContract：有本作设定时最前面追加【本作】段，并写明优先于原著', () => {
  const canon = bareCanon({
    premise: '裴照在 ch002 就认出了沈砚。',
    deltas: [
      {
        id: 'dl_001', kind: 'relationship', title: '裴照与沈砚是恋人',
        statement: '本作中两人自 ch002 起是恋人；原著中的上下级关系不再适用。',
        subjects: ['裴照', '沈砚'], fromChapter: 'ch002', suppress: [],
      },
    ],
  });
  const compiled = compileContract(scene(), canon);
  assert.ok(compiled.tags[DELTA_TAG], '应有【本作】段');
  assert.match(compiled.tags[DELTA_TAG], /优先于/);
  assert.match(compiled.tags[DELTA_TAG], /裴照与沈砚是恋人/);
  assert.ok(compiled.markdown.startsWith('# 场景契约 ch002'));
  assert.ok(compiled.markdown.indexOf('【本作】') < compiled.markdown.indexOf('【视角】'), '【本作】应在最前面');
});

test('runCheck：本作设定放过同类 finding，并在 suppressed 里说明按哪条放过', () => {
  const canon = bareCanon({
    deltas: [
      {
        id: 'dl_001', kind: 'other', title: '这一章允许不写标签',
        statement: '本作这一段是仿写练习，标签可以省略。',
        suppress: [{ detector: 'tagDefault', code: 'tag_missing', quote: '' }],
      },
    ],
  });
  const result = runCheck('沈砚走进来。', scene(), canon, { arm: 'C' });
  assert.equal(result.findings.filter((f) => f.code === 'tag_missing').length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].suppressedBy.id, 'dl_001');
  assert.equal(result.summary.suppressed, 1);
});

test('没有本作设定的书仍是原来的 9 段契约', () => {
  const compiled = compileContract(scene(), bareCanon());
  assert.equal(compiled.tags[DELTA_TAG], undefined);
  assert.equal(Object.keys(compiled.tags).length, 9);
});

test('DELTA_KINDS 覆盖所有会在面板里出现的类型', () => {
  for (const kind of ['premise', 'character', 'relationship', 'timeline', 'knowledge', 'world', 'address', 'other']) {
    assert.ok(DELTA_KINDS[kind], `缺类型 ${kind}`);
  }
});
