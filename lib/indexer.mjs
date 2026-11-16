// 确定性索引（不调用 LLM）：人物候选、称呼候选、对话归属、章节统计、时间词。
// 口径见开发方案 §5.3：只给 LLM 提案提供锚点，不自动合并人物。

import { findQuotes, splitSentences } from './text.mjs';

const SPEECH_VERBS = '说|道|问|答|喊|叫|笑|低声|开口|点头|摇头|沉默|叹|应';
const TAG = new RegExp(`([\\u4e00-\\u9fa5]{2,3})(?:${SPEECH_VERBS})`, 'g');
const TITLE_NAME = /(队长|副队长|记录员|学徒|守灯人|先生|姑娘|小姐|夫人|大人)([\u4e00-\u9fa5]{2,3})/g;
const TIME_WORDS = /(次日|第二天|三年前|两年前|一年前|昨晚|昨夜|今夜|今晚|冬至|清晨|黄昏|拂晓|夜里|天亮|入夜|傍晚|午后)/g;
const GENERIC = new Set(['他说', '她说', '他们', '她们', '自己', '什么', '怎么', '这样', '那样', '于是', '但是', '然后', '如果', '因为', '所以', '一个', '没有', '知道', '看见', '觉得', '心里', '时候']);
// 人名不会含这些功能字；含了就说明是把句子里的普通词当成了人名（“人都知道”→人都知）。
const NAME_NOISE = /[的了是不都没很就也还才又被把从向对给让和与或而但如因所以么这那谁要会能可觉看想知道说里上下中前后来去到着过地得你我她他它]/;

function sentenceAround(text, offset, radius = 30) {
  const from = Math.max(0, offset - radius);
  const to = Math.min(text.length, offset + radius);
  const sents = splitSentences(text.slice(from, to));
  return sents[0] || text.slice(from, to);
}

export function chapterStats(chapter) {
  const quotes = findQuotes(chapter.body);
  const dialogueChars = quotes.reduce((n, q) => n + q.text.length, 0);
  const timeWords = [...new Set(chapter.body.match(TIME_WORDS) || [])];
  return {
    chapter: chapter.id,
    chars: chapter.body.length,
    dialogueChars,
    dialogueRatio: chapter.body.length ? Math.round((dialogueChars / chapter.body.length) * 1000) / 1000 : 0,
    sentences: splitSentences(chapter.body).length,
    quotes: quotes.length,
    timeWords,
  };
}

// 人物候选：对话提示词高精度（“X说”），职称+姓名次之；统计跨章出场。
export function extractCharacterCandidates(chapters, { minMentions = 2 } = {}) {
  const stats = new Map();
  const bump = (name, chapter, offset, how) => {
    if (!name || name.length < 2 || GENERIC.has(name) || NAME_NOISE.test(name)) return;
    const rec = stats.get(name) || { name, mentions: 0, chapters: new Set(), first: null, ways: new Set(), samples: [] };
    rec.mentions += 1;
    rec.chapters.add(chapter.id);
    rec.ways.add(how);
    if (!rec.first) rec.first = { chapter: chapter.id, offset, quote: sentenceAround(chapter.body, offset) };
    if (rec.samples.length < 3) rec.samples.push({ chapter: chapter.id, offset, quote: sentenceAround(chapter.body, offset) });
    stats.set(name, rec);
  };
  for (const chapter of chapters) {
    TAG.lastIndex = 0;
    let m;
    while ((m = TAG.exec(chapter.body))) {
      bump(m[1], chapter, m.index, 'dialogue_tag');
    }
    TITLE_NAME.lastIndex = 0;
    while ((m = TITLE_NAME.exec(chapter.body))) {
      bump(m[2], chapter, m.index, `title:${m[1]}`);
    }
  }
  return [...stats.values()]
    .filter((r) => r.mentions >= minMentions)
    .sort((a, b) => b.mentions - a.mentions)
    .map((r) => ({
      name: r.name,
      mentions: r.mentions,
      chapters: [...r.chapters].sort(),
      ways: [...r.ways],
      first: r.first,
      samples: r.samples,
    }));
}

export function extractAliasCandidates(chapters, names) {
  const out = [];
  for (const name of names) {
    if (!name || name.length < 2) continue;
    const last = name[name.length - 1];
    const first = name[0];
    const forms = new Set([
      `阿${last}`, `小${last}`, `老${last}`,
      `${first}先生`, `${first}姑娘`, `${first}小姐`, `${first}大人`,
      `${name}先生`, `${name}姑娘`,
    ]);
    for (const chapter of chapters) {
      for (const form of forms) {
        let idx = chapter.body.indexOf(form);
        while (idx >= 0) {
          out.push({
            name, form, chapter: chapter.id, offset: idx,
            quote: sentenceAround(chapter.body, idx),
          });
          idx = chapter.body.indexOf(form, idx + form.length);
        }
      }
    }
  }
  return out;
}

// 引号内是纯称呼（如“阿砚。”）时，向前找 80 字内最近的说/道/问，作为说话人。
export function extractVocatives(chapters, aliasIndex) {
  const pairs = [];
  for (const chapter of chapters) {
    for (const q of findQuotes(chapter.body)) {
      const inner = q.inner.replace(/[。！？!?，,、…\s]/g, '');
      if (!inner || inner.length > 6) continue;
      const target = aliasIndex.get(inner);
      if (!target) continue;
      const before = chapter.body.slice(Math.max(0, q.start - 80), q.start);
      // 1) 紧贴引号的「X说：」；2) 引号后 80 字内的「看见X」「X走过来」。
      const near = before.match(/([\u4e00-\u9fa5]{2,3})(?:说|道|问|答|喊|叫|低声|开口)(?:了|着)?[，,:：]?\s*$/);
      const after = chapter.body.slice(q.end, q.end + 80);
      const cands = [...new Set([...aliasIndex.values()])];
      const seen = cands.map((n) => ({ n, i: after.search(new RegExp(`(?:看见|瞥见|望见|认出)${n}`)) }))
        .filter((h) => h.i >= 0).sort((a, b) => a.i - b.i)[0];
      const first = cands.map((n) => ({ n, i: after.indexOf(n) })).filter((h) => h.i >= 0).sort((a, b) => a.i - b.i)[0];
      const pick = near ? { n: near[1] } : (seen || first);
      if (!pick || NAME_NOISE.test(pick.n)) continue;
      const speaker = pick.n;
      pairs.push({
        from: speaker, to: target, form: inner, chapter: chapter.id, offset: q.start,
        quote: sentenceAround(chapter.body, q.start, 40),
      });
    }
  }
  return pairs;
}

export function analyzeChapters(chapters, { topCharacters = 5 } = {}) {
  const candidates = extractCharacterCandidates(chapters).slice(0, topCharacters);
  const names = candidates.map((c) => c.name);
  const aliases = extractAliasCandidates(chapters, names);
  const aliasIndex = new Map();
  for (const c of candidates) {
    aliasIndex.set(c.name, c.name);
    for (const a of aliases.filter((x) => x.name === c.name)) {
      if (!aliasIndex.has(a.form)) aliasIndex.set(a.form, c.name);
    }
  }
  const vocatives = extractVocatives(chapters, aliasIndex);
  return {
    characters: candidates,
    aliases,
    vocatives,
    stats: chapters.map(chapterStats),
  };
}
