// canon 内核验收：夹具 A 导入 → 确定性索引 → 应用模型提案 → 审阅/拒绝 → 冲突裁决。
// 这一组测试是第 2 步的验收证据：3 人物、≥10 事实、1 秘密、瞳色冲突 1 条且两条事实都保留。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ingestFile, bookTitleOf } from '../lib/ingest.mjs';
import { analyzeChapters } from '../lib/indexer.mjs';
import { paths, loadProject } from '../lib/canon-store.mjs';
import {
  applyProposals, confirmEntries, rejectEntries, resolveContradiction, locateQuote,
} from '../lib/proposals.mjs';
import { verifyCanon } from '../lib/canon-verify.mjs';

const FIXTURE = path.resolve('fixtures/fixture-a');
const SOURCE = path.join(FIXTURE, 'source.md');
const PROPOSALS = path.join(FIXTURE, 'proposals');

async function ingestInto() {
  const root = await mkdtemp(path.join(tmpdir(), 'fanfic-canon-'));
  const result = await ingestFile({ root, project: 't', file: SOURCE, title: '雾港' });
  const p = paths(root, 't').source(result.sourceId);
  const texts = new Map();
  for (const ch of result.index.chapters) texts.set(ch.id, await readFile(p.chapter(ch.id), 'utf8'));
  return { root, result, p, texts };
}

async function applyAllProposals() {
  const env = await ingestInto();
  const { canon } = await loadProject(env.root, 't');
  for (const ch of ['ch001', 'ch002', 'ch003', 'ch004', 'ch005', 'ch006']) {
    const list = JSON.parse(await readFile(path.join(PROPOSALS, `proposals-${ch}.json`), 'utf8'));
    applyProposals(canon, list, env.texts);
  }
  return { ...env, canon };
}

test('导入夹具 A：分章正确、字数与 sha 去重', async () => {
  const env = await ingestInto();
  assert.equal(env.result.duplicate, false);
  assert.equal(env.result.meta.chars, 4023);
  assert.equal(env.result.meta.chapterCount, 7, '6 章正文 + 1 段序');
  const ids = env.result.index.chapters.map((c) => c.id);
  for (const id of ['ch001', 'ch002', 'ch003', 'ch004', 'ch005', 'ch006']) assert.ok(ids.includes(id), id);
  const ch1 = env.result.index.chapters.find((c) => c.id === 'ch001');
  assert.equal(ch1.title, '雾港初逢');
  assert.ok(env.texts.get('ch001').includes('沈砚左眉骨上有一道旧疤'));

  const again = await ingestFile({ root: env.root, project: 't', file: SOURCE });
  assert.equal(again.duplicate, true, '同一文件第二次导入应被 sha256 挡住');
  assert.equal(again.sourceId, env.result.sourceId);
});

test('书名：首行「# 书名」优先，章节标题与普通正文不误认', () => {
  assert.equal(bookTitleOf('# 雾港（合成短篇，夹具 A）\n\n## 第一章 雾港初逢\n', 'D:\\books\\source.md'), '雾港（合成短篇，夹具 A）');
  assert.equal(bookTitleOf('## 第一章 雾港初逢\n正文\n', 'D:\\books\\my-novel.txt'), 'my-novel');
  assert.equal(bookTitleOf('正文第一段。\n# 不是书名\n', 'D:\\books\\b.txt'), 'b');
  assert.equal(bookTitleOf('# 第一章 雾港初逢\n', 'x.md'), 'x', '章节标题不当书名');
});

test('确定性索引：3 个主要人物、职称与称呼候选', async () => {
  const env = await ingestInto();
  const chapters = env.result.index.chapters.map((c) => ({ ...c, body: env.texts.get(c.id) }));
  const analysis = analyzeChapters(chapters);
  const names = analysis.characters.map((c) => c.name);
  for (const name of ['沈砚', '裴照', '苏鹤']) assert.ok(names.includes(name), `${name} 应出现在人物候选里`);
  assert.ok(analysis.characters.find((c) => c.name === '裴照').mentions >= 5);
  const pairs = analysis.vocatives.map((v) => `${v.from}->${v.to}「${v.form}」`);
  assert.ok(pairs.some((x) => x.includes('裴照->沈砚「阿砚」')), `称呼候选应含裴照→沈砚「阿砚」，实际：${pairs.join('；')}`);
  assert.ok(pairs.some((x) => x.includes('裴照->沈砚「沈先生」')));
  assert.equal(analysis.vocatives.every((v) => !/^(你|我|他|她)$/.test(v.form)), true);
});

test('应用提案：人物/事实/规则/秘密/称呼落盘，引文可命中', async () => {
  const { canon, texts } = await applyAllProposals();
  const names = canon.characters.map((c) => c.name);
  for (const name of ['沈砚', '裴照', '苏鹤']) assert.ok(names.includes(name), name);
  assert.ok(canon.facts.length >= 10, `事实应 ≥10，实际 ${canon.facts.length}`);
  assert.ok(canon.worldRules.length >= 2);
  assert.ok(canon.secrets.length >= 1);
  const forms = canon.addresses.map((a) => a.form);
  assert.ok(forms.includes('沈先生') && forms.includes('阿砚'), `称呼应含沈先生/阿砚，实际 ${forms.join('/')}`);
  assert.equal(forms.includes('你'), false, '代词不能当称呼');

  const { ok, errors } = verifyCanon(canon, texts);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('瞳色冲突：只报 1 条、两条事实都保留、裁决不覆盖旧事实', async () => {
  const { canon } = await applyAllProposals();
  const fcs = canon.contradictions;
  assert.equal(fcs.length, 1, `设定矛盾应只有 1 条，实际 ${fcs.length}`);
  const [fc] = fcs;
  assert.equal(fc.predicate, 'eye_color');
  assert.deepEqual(new Set(fc.values), new Set(['浅褐色', '灰蓝色']));
  assert.equal(fc.status, 'open');
  const both = fc.factIds.map((id) => canon.facts.find((f) => f.id === id));
  assert.ok(both.every(Boolean), '冲突指向的两条事实都要在 canon 里');
  assert.ok(both.every((f) => f.status === 'pending'), '裁决前都保持 pending，不能自动合并');
  assert.ok(both[0].evidence[0].quote.includes('浅褐') && both[1].evidence[0].quote.includes('灰蓝'));

  // 「拥有物/关系/身份」可以有多条，不能当矛盾。
  assert.equal(fcs.some((c) => ['possession', 'relationship', 'role'].includes(c.predicate)), false);

  const before = canon.facts.length;
  confirmEntries(canon, both.map((f) => f.id));
  const resolved = resolveContradiction(canon, fc.id, 'later');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution, 'later');
  assert.equal(canon.facts.length, before, '裁决不应删除事实');
  assert.equal(both[0].status, 'rejected', '前章那条被覆盖但保留');
  assert.equal(both[1].status, 'confirmed');
});

test('审阅：确认/拒绝都改状态并留证据', async () => {
  const { canon } = await applyAllProposals();
  const confirmed = confirmEntries(canon, ['char_001', 'fact_001', 'secret_003']);
  assert.deepEqual(confirmed.sort(), ['char_001', 'fact_001', 'secret_003']);
  assert.equal(canon.characters.find((c) => c.id === 'char_001').status, 'confirmed');
  const secret = canon.secrets.find((s) => s.id === 'secret_003');
  assert.ok(secret.evidence.length >= 1);
  const rejected = rejectEntries(canon, ['secret_001']);
  assert.deepEqual(rejected, ['secret_001']);
  assert.equal(canon.secrets.find((s) => s.id === 'secret_001').status, 'rejected');
});

test('提案校验：编造的引文被拒、差 300 字以内自动接受并纠正偏移', async () => {
  const env = await ingestInto();
  const { canon } = await loadProject(env.root, 't');
  const body = env.texts.get('ch001');
  const quote = '沈砚左眉骨上有一道旧疤';
  const real = body.indexOf(quote);
  assert.ok(real >= 0);

  const fake = applyProposals(canon, [
    { kind: 'fact', chapter: 'ch001', offset: 0, quote: '沈砚右眉骨上有一道旧疤', confidence: 0.9, payload: { subject: '沈砚', predicate: 'scar_side', object: '右眉' } },
  ], env.texts);
  assert.equal(fake.applied.length, 0);
  assert.equal(fake.rejected.length, 1);
  assert.match(fake.rejected[0].reason, /quote|引文/);

  const good = applyProposals(canon, [
    { kind: 'fact', chapter: 'ch001', offset: real + 50, quote, confidence: 0.9, payload: { subject: '沈砚', predicate: 'scar_side', object: '左眉' } },
  ], env.texts);
  assert.equal(good.applied.length, 1);
  assert.equal(good.applied[0].entity.offset, real, '偏移应被纠正回真实位置');
});

test('locateQuote 容忍空白差异', () => {
  const body = '灯影里，沈砚的眼睛是浅褐色的，像含着一层旧茶。';
  assert.equal(locateQuote(body, '沈砚的眼睛是浅褐色的').found, true);
  assert.equal(locateQuote(body, ' 沈砚的眼睛是浅褐色的 ').found, true);
  assert.equal(locateQuote(body, '沈砚的眼睛是灰蓝色的').found, false);
});
