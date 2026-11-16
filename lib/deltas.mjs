// 本作设定（Fic Canon）：作者明确要改的原著事实。
//
// 它和 declarations.json 是两件事：
// - declarations 是「检查器要抓的私设签名」（AU 规则 / 私设 / 错名），只用于抓漏；
// - deltas 是「本作正式生效的设定」，会写进契约（【本作】段，优先于原著），
//   并且可以带一条 suppress 指纹：同类 finding 以后不再按原著报错。
//
// 数据落在 `.dsh-novel-fanfic/<project>/deltas.json`，原子写，不进 canon 桶。

import path from 'node:path';
import { readJson, writeJsonAtomic } from './canon-store.mjs';
import { chapterNum, normalize } from './text.mjs';

export const DELTA_FILE = 'deltas.json';
export const MAX_DELTAS = 80;
export const MAX_STATEMENT = 240;
export const MAX_PREMISE = 400;
export const MAX_SUPPRESS = 6;

export const DELTA_KINDS = {
  premise: '本作前提',
  character: '人物改动',
  relationship: '关系改动',
  timeline: '时间线改动',
  knowledge: '知情改动',
  world: '世界规则',
  address: '称呼改动',
  other: '其他改动',
};

const KIND_KEYS = new Set(Object.keys(DELTA_KINDS));

function text(value, max = MAX_STATEMENT) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[,，、;；\s]+/);
  return [];
}

function chapterOf(value) {
  const raw = text(value, 20);
  if (!/^ch\d+$/.test(raw)) return null;
  const n = Number(raw.slice(2));
  return `ch${String(n).padStart(3, '0')}`;
}

function nextId(items) {
  const used = new Set(items.map((row) => row.id));
  let n = items.length + 1;
  let id = `dl_${String(n).padStart(3, '0')}`;
  while (used.has(id)) id = `dl_${String(++n).padStart(3, '0')}`;
  return id;
}

export function emptyDeltas() {
  return { premise: '', items: [] };
}

/** 把磁盘上的 JSON 收敛成固定形状（缺字段补空、去空项、限条数）。 */
export function normalizeDeltas(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const premise = text(src.premise, MAX_PREMISE);
  const items = [];
  const seenIds = new Set();
  for (const row of Array.isArray(src.items) ? src.items : []) {
    if (!row || typeof row !== 'object') continue;
    const title = text(row.title, 60);
    const statement = text(row.statement || row.text, MAX_STATEMENT);
    if (!title || !statement) continue;
    const kind = KIND_KEYS.has(String(row.kind)) ? String(row.kind) : 'other';
    const subjects = [...new Set(list(row.subjects).map((s) => text(s, 30)).filter(Boolean))].slice(0, 8);
    const fromChapter = chapterOf(row.fromChapter);
    const suppress = [];
    for (const entry of Array.isArray(row.suppress) ? row.suppress : []) {
      if (!entry || typeof entry !== 'object') continue;
      const detector = text(entry.detector, 40);
      const code = text(entry.code, 60);
      if (!detector || !code) continue;
      suppress.push({
        detector,
        code,
        quote: text(entry.quote, 160),
        chapter: chapterOf(entry.chapter),
      });
      if (suppress.length >= MAX_SUPPRESS) break;
    }
    let id = text(row.id, 40) || nextId(items);
    while (seenIds.has(id)) id = nextId(items);
    seenIds.add(id);
    items.push({
      id,
      kind,
      title,
      statement,
      subjects,
      fromChapter,
      suppress,
      source: row.source === 'finding' ? 'finding' : 'author',
      createdAt: text(row.createdAt, 40) || new Date().toISOString(),
    });
    if (items.length >= MAX_DELTAS) break;
  }
  return { premise, items };
}

export function deltaFile(projectDir) {
  return path.join(projectDir, DELTA_FILE);
}

export async function loadDeltas(file) {
  try {
    return normalizeDeltas(await readJson(file, null));
  } catch {
    // 文件坏了就当没有本作设定，不让面板挂掉。
    return emptyDeltas();
  }
}

export async function saveDeltas(file, data) {
  const normalized = normalizeDeltas(data);
  await writeJsonAtomic(file, normalized);
  return normalized;
}

function mergeSuppress(target, extra) {
  const seen = new Set((target || []).map((s) => `${s.detector}/${s.code}/${s.quote || ''}/${s.chapter || ''}`));
  for (const entry of extra || []) {
    const key = `${entry.detector}/${entry.code}/${entry.quote || ''}/${entry.chapter || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(entry);
    if (target.length >= MAX_SUPPRESS) break;
  }
}

/**
 * 加一条本作设定。
 * @param {{kind?:string,title:string,statement:string,subjects?:string|string[],fromChapter?:string,source?:string,suppress?:Array}} input
 */
export function addDelta(data, input = {}) {
  const next = normalizeDeltas(data);
  const title = text(input.title, 60);
  const statement = text(input.statement ?? input.text, MAX_STATEMENT);
  if (!title) throw new Error('本作设定需要 title（一句话标题）');
  if (!statement) throw new Error('本作设定需要 statement（正文说明）');
  const kind = KIND_KEYS.has(String(input.kind)) ? String(input.kind) : 'other';
  const subjects = [...new Set(list(input.subjects).map((s) => text(s, 30)).filter(Boolean))].slice(0, 8);
  const fromChapter = chapterOf(input.fromChapter);
  const suppress = [];
  for (const entry of Array.isArray(input.suppress) ? input.suppress : []) {
    if (!entry || typeof entry !== 'object') continue;
    const detector = text(entry.detector, 40);
    const code = text(entry.code, 60);
    if (!detector || !code) continue;
    suppress.push({
      detector,
      code,
      quote: text(entry.quote, 160),
      chapter: chapterOf(entry.chapter),
    });
  }
  const existing = next.items.find((row) => row.kind === kind && row.title === title && row.statement === statement);
  if (existing) {
    mergeSuppress(existing.suppress, suppress);
    return next;
  }
  if (next.items.length >= MAX_DELTAS) throw new Error(`本作设定最多 ${MAX_DELTAS} 条`);
  next.items.push({
    id: nextId(next.items),
    kind,
    title,
    statement,
    subjects,
    fromChapter,
    suppress: suppress.slice(0, MAX_SUPPRESS),
    source: input.source === 'finding' ? 'finding' : 'author',
    createdAt: new Date().toISOString(),
  });
  return next;
}

export function removeDelta(data, id) {
  const next = normalizeDeltas(data);
  const before = next.items.length;
  next.items = next.items.filter((row) => row.id !== id);
  if (next.items.length === before) throw new Error(`没有这条本作设定：${id}`);
  return next;
}

export function setPremise(data, value) {
  const next = normalizeDeltas(data);
  next.premise = text(value, MAX_PREMISE);
  return next;
}

function quoteMatches(a, b) {
  const left = normalize(a || '');
  const right = normalize(b || '');
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

/**
 * 这条本作设定是否要放过某个 finding。
 * suppress 是显式指纹（detector + code + 可选 quote/chapter）；没有指纹就不放过，
 * 只靠契约去影响生成，不在检查器里做「按主题大范围静音」。
 */
export function deltaSuppresses(delta, finding) {
  if (!delta || !finding) return false;
  if (delta.fromChapter && finding.chapter
    && chapterNum(finding.chapter) < chapterNum(delta.fromChapter)) return false;
  for (const entry of delta.suppress || []) {
    if (entry.detector !== finding.detector || entry.code !== finding.code) continue;
    if (entry.chapter && finding.chapter && entry.chapter !== finding.chapter) continue;
    if (entry.quote && !quoteMatches(entry.quote, finding.quote)) continue;
    return true;
  }
  return false;
}

export function describeDelta(row) {
  const label = DELTA_KINDS[row.kind] || DELTA_KINDS.other;
  const scope = row.fromChapter ? `（从 ${row.fromChapter} 起）` : '';
  return `[${label}]${scope} ${row.title}：${row.statement}`;
}
