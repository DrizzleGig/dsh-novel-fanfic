// 受限检索：只在 canon 章节/实体/问题范围内找句子，返回带章节+偏移+原文的片段。
// 找不到就说找不到，不编。

import { charCount, chapterNum, compareChapter, normalize, splitSentences } from './text.mjs';

function buildIndex(canon) {
  if (canon.__lookupIndex) return canon.__lookupIndex;
  const chapters = canon.chapters.map((ch) => {
    const sentences = splitSentences(ch.body).map((s) => ({
      chapter: ch.id,
      chapterNum: chapterNum(ch.id),
      localStart: s.offset,
      offset: ch.bodyStart + s.offset,
      text: s.text,
      norm: normalize(s.text),
    }));
    return { chapter: ch.id, sentences };
  });
  const index = { chapters };
  canon.__lookupIndex = index;
  return index;
}

function termsOf(question) {
  const q = String(question || '').trim();
  if (!q) return [];
  const out = new Set();
  for (const tok of q.split(/[\s，,。！？、；;：:（）()「」“”"'‘’/]+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (t.length <= 6) out.add(t);
    else {
      // 长问句：2 字滑窗（步长 1），保留「阿砚」这类短答案词
      for (let i = 0; i + 2 <= t.length; i += 1) out.add(t.slice(i, i + 2));
    }
  }
  return [...out];
}

function inRange(chNum, range) {
  if (!range || !range.length) return true;
  const [from, to] = range;
  return chNum >= chapterNum(from) && chNum <= chapterNum(to);
}

/**
 * @param {object} canon
 * @param {{entities?: string[], chapterRange?: [string,string], question?: string, window?: number, limit?: number}} params
 */
export function retrieve(canon, params = {}) {
  const index = buildIndex(canon);
  const entities = (params.entities || []).filter(Boolean);
  const question = params.question || '';
  const terms = termsOf(question);
  const window = Math.max(0, Math.min(3, params.window ?? 1));
  const limit = Math.max(1, Math.min(8, params.limit ?? 5));
  const range = params.chapterRange;

  const entityForms = [];
  for (const e of entities) {
    const ch = canon.formToChar.get(e);
    if (ch) entityForms.push(ch.name, ...(ch.aliases || []));
    else entityForms.push(e);
  }
  const loose = (s) => normalize(s).replace(/[“”「」『』]/g, '');
  const entityLoose = new Set(entityForms.map((f) => loose(f)));
  const qNorm = normalize(question);

  const scored = [];
  for (const { chapter, sentences } of index.chapters) {
    const chNum = chapterNum(chapter);
    if (!inRange(chNum, range)) continue;
    for (let si = 0; si < sentences.length; si += 1) {
      const s = sentences[si];
      let score = 0;
      const hitTerms = [];
      const hitEntities = [];
      for (const form of entityForms) {
        if (form && s.text.includes(form)) {
          score += 3;
          hitEntities.push(form);
        }
      }
      for (const t of terms) {
        if (t && s.norm.includes(normalize(t))) {
          score += 1;
          hitTerms.push(t);
        }
      }
      if (qNorm.length >= 3 && s.norm.includes(qNorm)) score += 12;
      // 整句就是一个称呼/名字（「阿砚。」「沈砚。」）：这是答案本身，给高分，
      // 但只认实体表里的词，避免「潮声钟。」这种短句把真正的规则句挤掉。
      if (s.text.length <= 12 && entityLoose.has(loose(s.text))) score += 9;
      if (score > 0) scored.push({ s, si, score, hitTerms, hitEntities });
    }
  }

  scored.sort((a, b) => b.score - a.score || compareChapter(a.s.chapter, b.s.chapter) || a.si - b.si);
  const picked = scored.slice(0, limit);
  const passages = [];
  const used = new Set();
  for (const item of picked) {
    const { chapter, sentences } = index.chapters.find((c) => c.chapter === item.s.chapter);
    const from = Math.max(0, item.si - window);
    const to = Math.min(sentences.length - 1, item.si + window);
    const key = `${chapter}:${from}-${to}`;
    if (used.has(key)) continue;
    used.add(key);
    // 合并与已选片段重叠的窗口
    const existing = passages.find((p) => p.chapter === chapter && !(to < p.from || from > p.to));
    if (existing) continue;
    const seg = sentences.slice(from, to + 1);
    const quote = seg.map((x) => x.text).join('');
    passages.push({
      chapter,
      offset: seg[0].offset,
      quote,
      from,
      to,
      score: item.score,
      why: `命中${item.hitEntities.length ? `实体 ${[...new Set(item.hitEntities)].join('、')}` : ''}${item.hitEntities.length && item.hitTerms.length ? '；' : ''}${item.hitTerms.length ? `问题词 ${[...new Set(item.hitTerms)].join('、')}` : ''}`,
    });
  }

  const best = scored[0]?.score ?? 0;
  const coverage = best >= 6 ? 'full' : best > 0 ? 'partial' : 'none';
  return {
    passages,
    coverage,
    note: coverage === 'none'
      ? `在指定范围内没有找到与「${question || entities.join('、')}」直接相关的原文；不编造。`
      : coverage === 'partial'
        ? '只找到弱相关的片段，引用前请核对上下文。'
        : '',
    query: { entities, question, chapterRange: range || null, window, limit },
  };
}

/** 判断一条检索结果是否命中 ground truth 的 expected（章节 + 引文包含关系）。 */
export function isLookupHit(passage, expected) {
  if (!passage || !expected) return false;
  if (passage.chapter !== expected.chapter) return false;
  const p = normalize(passage.quote);
  const e = normalize(expected.quote);
  return p.includes(e) || e.includes(p);
}

/** 对 fixture 的 10 个预设问题打分。 */
export function scoreLookupQuestions(canon) {
  const rows = canon.lookupQuestions.map((q) => {
    const res = retrieve(canon, { ...q.call, limit: 5, window: 1 });
    const hits = res.passages.filter((p) => (q.expected || []).some((e) => isLookupHit(p, e)));
    const expectedHits = (q.expected || []).filter((e) => res.passages.some((p) => isLookupHit(p, e)));
    return {
      id: q.id,
      question: q.question,
      call: q.call,
      coverage: res.coverage,
      expected: q.expected || [],
      matched: expectedHits,
      hit: expectedHits.length === (q.expected || []).length && (q.expected || []).length > 0,
      passages: res.passages,
      top: res.passages[0] || null,
      hitCount: hits.length,
    };
  });
  const total = rows.length;
  const hits = rows.filter((r) => r.hit).length;
  return {
    rows,
    total,
    hits,
    hitRate: total ? hits / total : 0,
    chars: charCount(canon.source),
  };
}
