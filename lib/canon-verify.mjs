// canon 自洽性检查：引文必须能在它声称的章节里命中；状态、指向、重复都要过一遍。
// CLI 的 verify 与测试共用这一份，避免两套口径。

import { STATUS } from './canon-store.mjs';
import { locateQuote } from './proposals.mjs';

const BUCKETS = ['characters', 'facts', 'worldRules', 'secrets', 'addresses', 'contradictions'];

export function evidenceOf(row) {
  if (row.evidence?.length) return row.evidence;
  if (row.chapter && row.quote) return [{ chapter: row.chapter, offset: row.offset, quote: row.quote }];
  return [];
}

// chapterTexts: Map<chapterId, string>
export function verifyCanon(canon, chapterTexts, { offsetTolerance = 300 } = {}) {
  const errors = [];
  const warnings = [];
  const ids = new Set();

  for (const bucket of BUCKETS) {
    for (const row of canon[bucket] || []) {
      if (ids.has(row.id)) errors.push(`重复 id：${row.id}`);
      ids.add(row.id);
      if (bucket !== 'contradictions' && !STATUS.includes(row.status)) {
        errors.push(`${row.id} 状态非法：${row.status}`);
      }
      const evs = evidenceOf(row);
      if (bucket !== 'characters' && bucket !== 'contradictions' && !evs.length) {
        errors.push(`${row.id} 没有证据`);
      }
      for (const ev of evs) {
        if (!ev?.chapter || !ev?.quote) {
          errors.push(`${row.id} 证据缺 chapter/quote`);
          continue;
        }
        const body = chapterTexts.get(ev.chapter);
        if (body === undefined) {
          errors.push(`${row.id} 证据章不存在：${ev.chapter}`);
          continue;
        }
        const hit = locateQuote(body, ev.quote);
        if (!hit.found) {
          errors.push(`${row.id} 引文在本章找不到：${ev.quote.slice(0, 24)}…`);
        } else if (Math.abs(hit.offset - (ev.offset ?? 0)) > offsetTolerance) {
          warnings.push(`${row.id} 引文偏移差 ${Math.abs(hit.offset - (ev.offset ?? 0))} 字（${ev.chapter}）`);
        }
      }
    }
  }

  for (const fc of canon.contradictions || []) {
    for (const fid of fc.factIds || []) {
      if (!(canon.facts || []).some((f) => f.id === fid)) errors.push(`${fc.id} 指向不存在的事实 ${fid}`);
    }
    if (!['open', 'resolved'].includes(fc.status)) errors.push(`${fc.id} 状态非法：${fc.status}`);
    if (fc.status === 'resolved' && !fc.resolution) errors.push(`${fc.id} 已裁决但没有 resolution`);
  }

  const seen = new Map();
  for (const f of (canon.facts || []).filter((x) => x.status !== 'rejected')) {
    const key = `${f.subject}|${f.predicate}|${f.object}`;
    if (seen.has(key)) warnings.push(`重复事实：${seen.get(key)} / ${f.id}（${key}）`);
    else seen.set(key, f.id);
  }

  for (const bucket of BUCKETS.filter((b) => b !== 'contradictions')) {
    for (const row of canon[bucket] || []) {
      if (row.status === 'confirmed' && !evidenceOf(row).length) warnings.push(`${row.id} 已确认但没有证据`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
