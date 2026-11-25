import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBook,
  auImpactReport,
  confirmedCanon,
  overviewReport,
  readerQuestionsReport,
  relationsReport,
  timelineReport,
} from '../lib/analysis.mjs';

const book = {
  title: '测试同人',
  sourceId: 'src1',
  stats: { chapters: 2, chars: 100, characters: 2, factions: 1, conflicts: 1, threads: 2, openThreads: 1, rules: 1, facts: 3 },
  coverage: {
    characters: { confirmed: 2, total: 2 },
    facts: { confirmed: 3, total: 3 },
    addresses: { confirmed: 1, total: 1 },
  },
  matrix: { edges: [{ fromName: '唐三', toName: '小舞', publicForm: '小舞', privateForm: '舞儿', fromChapter: 'ch002' }] },
  relations: [{ from: '唐三', to: '小舞', text: '互相保护', chapter: 'ch002', status: 'confirmed' }],
  timeline: [
    { id: 'ch001', title: '开始', factCount: 1, facts: [{ subject: '唐三', predicate: '身份', object: '唐门弟子' }] },
    { id: 'ch002', title: '改口', factCount: 2, facts: [{ subject: '唐三', predicate: '称呼', object: '舞儿' }] },
  ],
  threads: [
    { id: 't1', title: '唐三的秘密', setup: 'ch001', payoff: null, revealed: false },
    { id: 't2', title: '小舞的身份', setup: 'ch001', payoff: 'ch002', revealed: true },
  ],
  conflicts: [{ title: '唐三的秘密', known: [{ name: '唐三' }], unknown: ['小舞'] }],
  characters: [{ name: '唐三', aliases: ['小三'] }, { name: '小舞', aliases: [] }],
};

test('confirmedCanon 过滤 pending/rejected，只留 confirmed', () => {
  const raw = {
    characters: [{ id: 'a', status: 'confirmed' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'rejected' }],
    facts: [{ id: 'f1', status: 'confirmed' }, { id: 'f2', status: 'pending' }],
    worldRules: [{ id: 'w1', status: 'pending' }],
    secrets: [{ id: 's1', status: 'confirmed' }, { id: 's2', status: 'rejected' }],
    addresses: [{ id: 'p1', status: 'confirmed' }],
    contradictions: [{ id: 'x1', status: 'open' }, { id: 'x2', status: 'resolved' }],
    scenes: [{ id: 'keep-me' }],
  };
  const out = confirmedCanon(raw);
  assert.deepEqual(out.characters.map((r) => r.id), ['a']);
  assert.deepEqual(out.facts.map((r) => r.id), ['f1']);
  assert.deepEqual(out.worldRules, []);
  assert.deepEqual(out.secrets.map((r) => r.id), ['s1']);
  assert.deepEqual(out.addresses.map((r) => r.id), ['p1']);
  assert.deepEqual(out.contradictions.map((r) => r.id), ['x1']);
  assert.deepEqual(out.scenes, [{ id: 'keep-me' }]);
});

test('overview 输出统计与覆盖，不把 pending 当事实', () => {
  const text = overviewReport(book, {}, { items: [{ id: 'd1' }], premise: '前提' });
  assert.match(text, /测试同人/);
  assert.match(text, /2 \/ 100 字/);
  assert.match(text, /人物 2\/2/);
  assert.match(text, /本作设定：1 条，有前提/);
});

test('relations 输出称呼表与关系事实', () => {
  const text = relationsReport(book);
  assert.match(text, /唐三/);
  assert.match(text, /舞儿/);
  assert.match(text, /互相保护/);
});

test('timeline 输出事件与未回收伏笔', () => {
  const text = timelineReport(book);
  assert.match(text, /ch001/);
  assert.match(text, /未回收/);
  assert.match(text, /小舞的身份/);
});

test('AU 影响面按人物名/别名命中，未识别显式标出', () => {
  const text = auImpactReport(book, {
    premise: '唐三提前知道',
    items: [
      { kind: 'knowledge', title: '提前知情', statement: '唐三在第二章知道秘密', subjects: '唐三', fromChapter: 'ch002' },
      { kind: 'relationship', title: '陌生关系', statement: '与某人结盟', subjects: '不存在的人', fromChapter: 'ch003' },
    ],
  });
  assert.match(text, /命中人物 唐三/);
  assert.match(text, /未识别/);
  assert.match(text, /提前知道/);
});

test('reader 只给假设，不给事实；未知动作报错', () => {
  const text = readerQuestionsReport(book);
  assert.match(text, /读者视角假设/);
  assert.match(text, /不是事实/);
  assert.match(text, /知情差/);
  assert.throws(() => analyzeBook(book, {}, { items: [] }, 'nope'), /未知分析动作/);
});
