// 作者私设声明：AU 规则 / 未声明私设（headcanon）/ 错名表。
// 存在 `.dsh-novel-fanfic/<project>/declarations.json`，不进 canon（不参与契约编译），
// 但适配器会把它带进检查器，用来抓「原著向场景里写进了作者私设」。
// 全部是纯函数 + 一次读写，方便单测。

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './canon-store.mjs';

export const DECLARATION_FILE = 'declarations.json';
export const MAX_AU_RULES = 20;
export const MAX_SIGNATURES = 12;
export const MAX_HEADCANON = 50;
export const MAX_TYPOS = 100;

export function emptyDeclarations() {
  return { auRules: [], headcanonSignatures: [], typos: {} };
}

function text(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[,，、;；\s]+/);
  return [];
}

/** 把磁盘上的 JSON 收敛成固定形状（缺字段补空、去空项、限条数）。 */
export function normalizeDeclarations(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const auRules = [];
  for (const row of Array.isArray(src.auRules) ? src.auRules : []) {
    if (!row || typeof row !== 'object') continue;
    const name = text(row.name, 40);
    const signatures = [...new Set(list(row.signatures).map((s) => text(s, 30)).filter(Boolean))].slice(0, MAX_SIGNATURES);
    if (!name || !signatures.length) continue;
    auRules.push({
      id: text(row.id, 40) || `au_${String(auRules.length + 1).padStart(3, '0')}`,
      name,
      text: text(row.text, 200),
      signatures,
    });
    if (auRules.length >= MAX_AU_RULES) break;
  }
  const seen = new Set();
  const headcanonSignatures = [];
  for (const row of Array.isArray(src.headcanonSignatures) ? src.headcanonSignatures : []) {
    const sentence = text(row, 60);
    if (!sentence || seen.has(sentence)) continue;
    seen.add(sentence);
    headcanonSignatures.push(sentence);
    if (headcanonSignatures.length >= MAX_HEADCANON) break;
  }
  const typos = {};
  for (const [wrong, right] of Object.entries(src.typos && typeof src.typos === 'object' ? src.typos : {})) {
    const w = text(wrong, 20);
    const r = text(right, 20);
    if (!w || !r || w === r) continue;
    typos[w] = r;
    if (Object.keys(typos).length >= MAX_TYPOS) break;
  }
  return { auRules, headcanonSignatures, typos };
}

export function declarationFile(projectDir) {
  return path.join(projectDir, DECLARATION_FILE);
}

export async function loadDeclarations(file) {
  try {
    return normalizeDeclarations(await readJson(file, null));
  } catch {
    // 文件坏了就当没声明，不让面板挂掉。
    return emptyDeclarations();
  }
}

export async function saveDeclarations(file, data) {
  const normalized = normalizeDeclarations(data);
  await writeJsonAtomic(file, normalized);
  return normalized;
}

/** 加一条 AU 规则（同一 name 视为更新签名与说明）。 */
export function addAuRule(data, input = {}) {
  const next = normalizeDeclarations(data);
  const name = text(input.name, 40);
  const signatures = [...new Set(list(input.signatures).map((s) => text(s, 30)).filter(Boolean))].slice(0, MAX_SIGNATURES);
  if (!name) throw new Error('AU 规则需要 --name');
  if (!signatures.length) throw new Error('AU 规则需要 --signatures（逗号分隔，至少一个）');
  const existing = next.auRules.find((r) => r.name === name);
  if (existing) {
    existing.signatures = signatures;
    existing.text = text(input.text, 200) || existing.text;
  } else {
    if (next.auRules.length >= MAX_AU_RULES) throw new Error(`AU 规则最多 ${MAX_AU_RULES} 条`);
    next.auRules.push({
      id: `au_${String(next.auRules.length + 1).padStart(3, '0')}`,
      name,
      text: text(input.text, 200),
      signatures,
    });
  }
  return next;
}

export function removeAuRule(data, id) {
  const next = normalizeDeclarations(data);
  const before = next.auRules.length;
  next.auRules = next.auRules.filter((r) => r.id !== id && r.name !== id);
  if (next.auRules.length === before) throw new Error(`没有这条 AU 规则：${id}`);
  return next;
}

/** 加一条「未声明私设」签名句。 */
export function addHeadcanon(data, sentence) {
  const next = normalizeDeclarations(data);
  const value = text(sentence, 60);
  if (!value) throw new Error('私设签名需要 --text');
  if (next.headcanonSignatures.includes(value)) return next;
  if (next.headcanonSignatures.length >= MAX_HEADCANON) throw new Error(`私设签名最多 ${MAX_HEADCANON} 条`);
  next.headcanonSignatures.push(value);
  return next;
}

export function removeHeadcanon(data, indexOrText) {
  const next = normalizeDeclarations(data);
  const at = Number(indexOrText);
  const before = next.headcanonSignatures.length;
  if (Number.isInteger(at) && at >= 1 && at <= before) {
    next.headcanonSignatures.splice(at - 1, 1);
    return next;
  }
  next.headcanonSignatures = next.headcanonSignatures.filter((s) => s !== String(indexOrText));
  if (next.headcanonSignatures.length === before) throw new Error(`没有这条私设：${indexOrText}`);
  return next;
}

export function addTypo(data, wrong, right) {
  const next = normalizeDeclarations(data);
  const w = text(wrong, 20);
  const r = text(right, 20);
  if (!w || !r) throw new Error('错名需要 --wrong 与 --right');
  if (w === r) throw new Error('错名和正确名不能一样');
  if (Object.keys(next.typos).length >= MAX_TYPOS && !next.typos[w]) throw new Error(`错名最多 ${MAX_TYPOS} 条`);
  next.typos[w] = r;
  return next;
}

export function removeTypo(data, wrong) {
  const next = normalizeDeclarations(data);
  const w = text(wrong, 20);
  if (!next.typos[w]) throw new Error(`没有这个错名：${wrong}`);
  delete next.typos[w];
  return next;
}
