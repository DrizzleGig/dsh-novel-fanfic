// 纯文本工具：分章、分句、分对话、偏移、复制比对。
// 不依赖任何第三方库，Node ≥ 20。

const PUNCT_RE = /[\s\u3000，。！？；：、,.!?;:""''「」『』（）()《》〈〉【】\[\]—－\-…·~～]/g;

/** 去掉空白与标点，用于“连续 N 字复制”比对。返回 { chars, offsets }，offsets 指向原文下标。 */
export function normalizeWithOffsets(text) {
  const chars = [];
  const offsets = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (PUNCT_RE.test(ch)) {
      PUNCT_RE.lastIndex = 0;
      continue;
    }
    PUNCT_RE.lastIndex = 0;
    chars.push(ch);
    offsets.push(i);
  }
  return { chars, offsets, text: chars.join('') };
}

export function normalize(text) {
  return normalizeWithOffsets(text).text;
}

/** 统计“字数”：去掉空白的字符数（中文按字，英文按字符）。 */
export function charCount(text) {
  return text.replace(/\s/g, '').length;
}

/** 按 `## 第N章 标题` 切章。返回 [{ id, title, heading, body, start, end, offset }] */
export function splitChapters(sourceText) {
  const lines = sourceText.split('\n');
  const chapters = [];
  let current = null;
  let cursor = 0;
  for (const line of lines) {
    const m = line.match(/^##\s+第([一二三四五六七八九十百零〇\d]+)章\s*(.*)$/);
    if (m) {
      if (current) {
        current.body = current.body.replace(/\n+$/, '');
        current.end = cursor;
      }
      current = {
        ordinal: m[1],
        title: m[2].trim(),
        heading: line,
        lines: [],
        start: cursor + line.length + 1,
        end: null,
        body: '',
      };
      chapters.push(current);
      cursor += line.length + 1;
      continue;
    }
    if (current) {
      current.lines.push(line);
      current.body += (current.lines.length > 1 ? '\n' : '') + line;
      cursor += line.length + 1;
    } else {
      cursor += line.length + 1;
    }
  }
  if (current) current.end = cursor;
  chapters.forEach((ch, idx) => {
    ch.id = `ch${String(idx + 1).padStart(3, '0')}`;
    ch.body = ch.body.trim();
    ch.bodyStart = sourceText.indexOf(ch.body, ch.start);
    if (ch.bodyStart < 0) ch.bodyStart = ch.start;
  });
  return chapters;
}

/** 段落 [{ text, offset }]（offset 相对传入文本）。 */
export function splitParagraphs(text) {
  const out = [];
  let idx = 0;
  for (const para of text.split(/\n+/)) {
    const at = text.indexOf(para, idx);
    if (para.trim()) out.push({ text: para, offset: at });
    idx = at + para.length;
  }
  return out;
}

/** 句子 [{ text, offset, end }]（offset/end 相对传入文本，end 不含）。 */
const SENTENCE_CLOSERS = '”」』）】》';

export function splitSentences(text) {
  const out = [];
  let start = 0;
  const push = (from, to) => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(text[a])) a += 1;
    while (b > a && /\s/.test(text[b - 1])) b -= 1;
    if (b > a) out.push({ text: text.slice(a, b), offset: a, end: b });
  };
  for (let i = 0; i < text.length; i += 1) {
    if ('。！？!?'.includes(text[i])) {
      // 句末的右引号/右括号属于这一句，不能甩给下一句
      let end = i + 1;
      while (end < text.length && (SENTENCE_CLOSERS.includes(text[end]) || '。！？!?'.includes(text[end]))) end += 1;
      push(start, end);
      start = end;
      i = end - 1;
    } else if (text[i] === '\n') {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, text.length);
  return out;
}

const QUOTE_PAIRS = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
];

/** 找出段落里的引号内容：返回 [{ text, start, end, inner, innerStart }]（相对传入文本）。 */
export function findQuotes(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const pair = QUOTE_PAIRS.find(([open]) => text[i] === open);
    if (!pair) continue;
    const [open, close] = pair;
    const closeIdx = text.indexOf(close, i + 1);
    if (closeIdx < 0) continue;
    const inner = text.slice(i + 1, closeIdx);
    if (inner.trim()) {
      out.push({ text: text.slice(i, closeIdx + 1), inner, start: i, end: closeIdx + 1, innerStart: i + 1 });
    }
    i = closeIdx;
  }
  return out;
}

/** 出现位置。 */
export function findAll(haystack, needle) {
  const out = [];
  if (!needle) return out;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
}

/** 取上下文：以 start..end 为中心，前后各取 n 个字。 */
export function contextAround(text, start, end, n = 80) {
  const from = Math.max(0, start - n);
  const to = Math.min(text.length, end + n);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

export function chapterNum(chapterId) {
  const m = String(chapterId || '').match(/ch(\d+)/i);
  return m ? Number(m[1]) : 0;
}

export function compareChapter(a, b) {
  return chapterNum(a) - chapterNum(b);
}

/** 解析草稿：首行【标签】x，第二行【正文】，其余为正文。 */
export function parseDraft(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let tag = null;
  let bodyStart = 0;
  let sawBody = false;
  for (let i = 0; i < Math.min(lines.length, 6); i += 1) {
    const line = lines[i].trim();
    if (!tag) {
      const m = line.match(/^【标签】\s*(.+)$/);
      if (m) {
        tag = m[1].trim();
        continue;
      }
    }
    if (!sawBody && /^【正文】\s*$/.test(line)) {
      sawBody = true;
      bodyStart = i + 1;
      break;
    }
  }
  if (!sawBody) {
    // 没有【正文】标记：把标签行之后的内容都当正文
    bodyStart = tag ? 1 : 0;
  }
  const body = lines.slice(bodyStart).join('\n').trim();
  return { tag, body, raw: text };
}

/** 归一化后求最长公共子串长度（用于 copy 检测的辅助断言）。 */
export function longestCommonSubstring(a, b) {
  const A = normalize(a);
  const B = normalize(b);
  let best = 0;
  let prev = new Uint16Array(B.length + 1);
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Uint16Array(B.length + 1);
    for (let j = 1; j <= B.length; j += 1) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 确定性伪随机（用于盲评打乱），返回 [0,1) 生成器。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(list, seed) {
  const rnd = mulberry32(seed);
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
