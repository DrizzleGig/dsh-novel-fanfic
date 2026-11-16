// 侧边栏视图数据的单测：推导规则是面板的「事实来源」，所以这里逐条钉住口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBook, characterCards, factionCards, addressMatrix, relationEdges,
  worldView, conflictCards, timelineView, threadView, coverageView,
  extractOrg, shortName, countMentions,
} from '../lib/views.mjs';

const characters = [
  { id: 'char_001', name: '沈砚', aliases: ['阿砚'], role: '主角', summary: '守灯人学徒', status: 'confirmed', firstChapter: 'ch001', evidence: [{ chapter: 'ch001', offset: 1, quote: '沈砚把灯搬上栈桥' }] },
  { id: 'char_002', name: '裴照', aliases: [], role: '配角', summary: '巡雾队副队长', status: 'confirmed', firstChapter: 'ch001', evidence: [{ chapter: 'ch001', offset: 2, quote: '裴照没说话' }] },
  { id: 'char_003', name: '苏鹤', aliases: ['苏姑娘'], role: '配角', summary: '档案房记录员', status: 'pending', firstChapter: 'ch002', evidence: [] },
];

const facts = [
  { id: 'fact_001', subject: 'char_001', subjectName: '沈砚', predicate: 'role', object: '长明塔守灯人学徒（已做三年）', chapter: 'ch001', status: 'confirmed', evidence: [{ chapter: 'ch001', offset: 5, quote: '守灯人学徒' }] },
  { id: 'fact_002', subject: 'char_002', subjectName: '裴照', predicate: 'role', object: '巡雾队副队长', chapter: 'ch001', status: 'confirmed', evidence: [{ chapter: 'ch001', offset: 6, quote: '巡雾队副队长' }] },
  { id: 'fact_003', subject: 'char_003', subjectName: '苏鹤', predicate: 'role', object: '档案房掌簿者', chapter: 'ch002', status: 'pending', evidence: [{ chapter: 'ch002', offset: 7, quote: '档案房掌簿者' }] },
  { id: 'fact_004', subject: 'char_001', subjectName: '沈砚', predicate: 'relationship', object: '父亲沈九三年前失踪', chapter: 'ch001', status: 'confirmed', evidence: [{ chapter: 'ch001', offset: 8, quote: '父亲沈九' }] },
  { id: 'fact_005', subject: 'char_001', subjectName: '沈砚', predicate: 'possession', object: '铜哨，母亲遗物', chapter: 'ch001', status: 'confirmed', evidence: [{ chapter: 'ch001', offset: 9, quote: '一枚铜哨' }] },
  { id: 'fact_006', subject: 'char_001', subjectName: '沈砚', predicate: 'residence', object: '长明塔塔脚的旧船屋，已住三年', chapter: 'ch002', status: 'pending', evidence: [{ chapter: 'ch002', offset: 10, quote: '旧船屋' }] },
];

const addresses = [
  { id: 'addr_001', from: 'char_002', to: 'char_001', form: '沈先生', publicForm: '沈先生', privateForm: null, fromChapter: 'ch001', status: 'confirmed', evidence: [{ chapter: 'ch001', offset: 11, quote: '沈先生，' }] },
  { id: 'addr_002', from: 'char_002', to: 'char_001', form: '阿砚', publicForm: '沈砚', privateForm: '阿砚', fromChapter: 'ch002', status: 'pending', evidence: [{ chapter: 'ch002', offset: 12, quote: '“阿砚。”' }] },
  { id: 'addr_003', from: 'char_001', to: 'char_003', form: '苏姑娘', publicForm: '苏姑娘', privateForm: null, fromChapter: 'ch002', status: 'rejected', evidence: [] },
];

const worldRules = [
  { id: 'rule_001', text: '涨雾日封港，船不许离岸。', status: 'confirmed', evidence: [{ chapter: 'ch001', offset: 20, quote: '明日是涨雾日，封港' }] },
  { id: 'rule_002', text: '潮声钟响时不许出声。', status: 'pending', evidence: [{ chapter: 'ch001', offset: 21, quote: '谁也不许出声' }] },
];

const secrets = [
  {
    id: 'secret_001', what: '沈九没有死，苏鹤替他瞒了三年。', status: 'confirmed', publicAtChapter: 'ch004',
    knownBy: [{ who: 'char_003', fromChapter: 'ch003' }, { who: 'char_001', fromChapter: 'ch004' }],
    evidence: [{ chapter: 'ch003', offset: 30, quote: '她替他瞒了三年' }],
  },
];

const canon = { characters, facts, addresses, worldRules, secrets, contradictions: [{ id: 'fc_001', status: 'open' }] };
const chapters = [
  { id: 'ch001', title: '雾港初逢', chars: 700, ordinal: 1 },
  { id: 'ch002', title: '塔下修灯', chars: 760, ordinal: 2 },
  { id: 'ch003', title: '档案房', chars: 470, ordinal: 3 },
];
const texts = {
  ch001: '沈砚把灯搬上栈桥。裴照没说话。沈砚抬头，阿砚这个名字还没人叫过。',
  ch002: '裴照叫了一声“阿砚”。苏姑娘在档案房。',
  ch003: '苏鹤把簿子合上。',
};

test('extractOrg 从身份短语里取机构/地点，去掉“副/队员”这类修饰', () => {
  assert.equal(extractOrg('巡雾队副队长'), '巡雾队');
  assert.equal(extractOrg('巡雾队队员'), '巡雾队');
  assert.equal(extractOrg('长明塔守灯人学徒（已做三年）'), '长明塔');
  assert.equal(extractOrg('档案房掌簿者'), '档案房');
  assert.equal(extractOrg('他是队里的人'), '');
  assert.equal(extractOrg('沈砚的父亲'), '');
});

test('shortName 只取第一个短语', () => {
  assert.equal(shortName('铜哨，母亲遗物，吹三短声'), '铜哨');
  assert.equal(shortName('长明塔塔脚的旧船屋，已住三年'), '长明塔塔脚的旧船屋');
});

test('countMentions 把姓名与别名都算进去', () => {
  assert.equal(countMentions(texts.ch001, ['沈砚']), 2);
  assert.equal(countMentions(texts.ch001, ['沈砚', '阿砚']), 3);
});

test('characterCards 用正文算出提及次数与出场章，并按提及次数排序', () => {
  const cards = characterCards(canon, chapters, texts);
  assert.equal(cards[0].name, '沈砚');
  assert.equal(cards[0].mentions, 4); // 沈砚×3 + 阿砚×1
  assert.deepEqual(cards[0].chapters, ['ch001', 'ch002']);
  assert.equal(cards[0].firstChapter, 'ch001');
  assert.equal(cards[0].lastChapter, 'ch002');
  assert.equal(cards[0].status, 'confirmed');
  const rejected = cards.find((c) => c.name === '苏鹤');
  assert.deepEqual(rejected.chapters, ['ch002', 'ch003']);
});

test('factionCards 从身份事实归纳势力，成员与证据可追溯', () => {
  const chars = characterCards(canon, chapters, texts);
  const factions = factionCards(canon, chars);
  const names = factions.map((f) => f.name).sort();
  assert.deepEqual(names, ['巡雾队', '档案房', '长明塔'].sort());
  const patrol = factions.find((f) => f.name === '巡雾队');
  assert.equal(patrol.kind, '组织');
  assert.equal(patrol.status, 'confirmed');
  assert.deepEqual(patrol.members.map((m) => m.name), ['裴照']);
  const tower = factions.find((f) => f.name === '长明塔');
  assert.deepEqual(tower.members.map((m) => m.name), ['沈砚']);
});

test('addressMatrix 解析姓名、剔除 rejected，并保留公开/私下与改口章', () => {
  const chars = characterCards(canon, chapters, texts);
  const matrix = addressMatrix(canon, chars);
  assert.equal(matrix.edges.length, 2);
  const second = matrix.edges.find((e) => e.id === 'addr_002');
  assert.equal(second.fromName, '裴照');
  assert.equal(second.toName, '沈砚');
  assert.equal(second.publicForm, '沈砚');
  assert.equal(second.privateForm, '阿砚');
  assert.equal(second.fromChapter, 'ch002');
});

test('relationEdges 只留关系事实，并带章节与证据', () => {
  const edges = relationEdges(canon);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, '沈砚');
  assert.match(edges[0].text, /沈九/);
  assert.equal(edges[0].chapter, 'ch001');
});

test('worldView 分出规则/地点/物品/术语，术语不重复', () => {
  const chars = characterCards(canon, chapters, texts);
  const factions = factionCards(canon, chars);
  const world = worldView(canon, chars, factions);
  assert.equal(world.rules.length, 2);
  assert.deepEqual(world.locations.map((l) => l.name), ['长明塔塔脚的旧船屋']);
  assert.deepEqual(world.items.map((i) => i.name), ['铜哨']);
  const names = world.terms.map((t) => t.name);
  assert.ok(names.includes('沈砚'));
  assert.ok(names.includes('巡雾队'));
  assert.ok(names.includes('铜哨'));
  assert.equal(new Set(names).size, names.length);
});

test('conflictCards 由秘密归纳知情双方，并把已拒绝的秘密排除', () => {
  const chars = characterCards(canon, chapters, texts);
  const cards = conflictCards({ ...canon, secrets: [...secrets, { id: 'secret_x', what: '作废', status: 'rejected', knownBy: [] }] }, chars);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].known.map((k) => k.name), ['苏鹤', '沈砚']);
  assert.deepEqual(cards[0].unknown, ['裴照']);
  assert.equal(cards[0].publicAtChapter, 'ch004');
});

test('timelineView 按章归事实、按正文归在场人物', () => {
  const chars = characterCards(canon, chapters, texts);
  const timeline = timelineView(canon, chapters, chars);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].id, 'ch001');
  assert.ok(timeline[0].factCount >= 3);
  assert.ok(timeline[0].present.includes('沈砚'));
  assert.ok(timeline[1].present.includes('苏鹤'));
  assert.equal(timeline[2].factCount, 0);
});

test('threadView 标出埋设章/公开章与是否已回收', () => {
  const threads = threadView(canon, chapters);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].setup, 'ch003');
  assert.equal(threads[0].payoff, 'ch004');
  // ch004 不在本书章节里，所以还没回收。
  assert.equal(threads[0].revealed, false);
});

test('coverageView 统计 confirmed / total（rejected 不计入分母）', () => {
  const chars = characterCards(canon, chapters, texts);
  const factions = factionCards(canon, chars);
  const conflicts = conflictCards(canon, chars);
  const coverage = coverageView(canon, chars, factions, conflicts);
  assert.deepEqual(coverage.characters, { confirmed: 2, total: 3 });
  assert.deepEqual(coverage.facts, { confirmed: 4, total: 6 });
  assert.deepEqual(coverage.addresses, { confirmed: 1, total: 2 });
  assert.deepEqual(coverage.contradictions, { open: 1, total: 1 });
});

test('buildBook 组装全量视图并给出分析进度', () => {
  const book = buildBook({ canon, project: { title: '雾港', sourceId: 'src_x' }, chapters, texts });
  assert.equal(book.title, '雾港');
  assert.equal(book.stats.chapters, 3);
  assert.equal(book.stats.chars, 1930);
  assert.equal(book.stats.characters, 3);
  assert.ok(book.analysis.find((s) => s.key === 'chapters').done);
  assert.ok(book.analysis.find((s) => s.key === 'relations').done);
  assert.equal(book.timeline.length, 3);
  assert.deepEqual(book.matrix.people.map((p) => p.name), ['沈砚', '裴照', '苏鹤']);
});
