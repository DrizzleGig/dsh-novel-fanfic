// lookup 自检：10 个问题命中率、检索结果可回溯到章节与引文。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixture } from '../lib/canon.mjs';
import { retrieve, isLookupHit, scoreLookupQuestions } from '../lib/lookup.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const canon = await loadFixture(path.join(ROOT, 'fixtures', 'fixture-a'));

test('10 个检索问题全部命中', () => {
  const res = scoreLookupQuestions(canon);
  assert.equal(res.total, 10);
  assert.equal(res.hits, 10, `未命中：${res.rows.filter((r) => !r.hit).map((r) => r.id).join(',')}`);
  assert.ok(res.hitRate >= 0.8);
});

test('每条检索结果都能回溯到原文', () => {
  for (const q of canon.lookupQuestions) {
    const res = retrieve(canon, q.call);
    assert.ok(res.passages.length > 0, `${q.id} 没检索到任何段落`);
    for (const p of res.passages) {
      const chapter = canon.chapterById.get(p.chapter);
      assert.ok(chapter, `${q.id} 返回未知章节 ${p.chapter}`);
      assert.ok(p.quote.length > 0 && p.offset >= 0);
      const squash = (x) => x.replace(/\s+/g, '');
      assert.ok(squash(chapter.body).includes(squash(p.quote)), `${q.id} 的引文在 ${p.chapter} 原文里找不到：${p.quote}`);
    }
  }
});

test('短句别名（阿砚）排得进答案', () => {
  const q = canon.lookupQuestions.find((x) => x.id === 'q02');
  const res = retrieve(canon, q.call);
  assert.ok(res.passages.some((p) => p.quote.includes('阿砚')), `q02 前 5 条：${res.passages.map((p) => p.quote).join(' | ')}`);
  assert.ok(res.passages.some((p) => isLookupHit(p, q.expected[0])), 'q02 期望的 ch002 引文不在结果里');
});

test('世界规则问题命中规则句而不是零散词', () => {
  const q = canon.lookupQuestions.find((x) => x.id === 'q07');
  const res = retrieve(canon, q.call);
  assert.ok(res.passages.some((p) => isLookupHit(p, q.expected[0])), res.passages.map((p) => p.quote).join(' | '));
});

test('空问题不返回段落', () => {
  const res = retrieve(canon, { entities: [], question: '' });
  assert.equal(res.passages.length, 0);
  assert.equal(res.coverage, 'none');
});
