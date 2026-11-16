// canon 对象：加载 ground-truth.json + source.md，建成检查器/lookup 可直接使用的索引。
// 只做确定性处理，不调用 LLM。

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  splitChapters,
  findAll,
  charCount,
  chapterNum,
  compareChapter,
} from './text.mjs';
import { sha1 } from './hash.mjs';

export { sha1 };

export const CONTRACT_TAGS = ['视角', '在场', '称呼', '知情', '世界规则', '时间线', '禁忌', '不确定', '锚点'];

export function contractTags(markdown) {
  return [...markdown.matchAll(/【([^】]+)】/g)].map((m) => m[1]);
}

export function contractLength(markdown) {
  return charCount(markdown);
}

/**
 * 读取夹具目录，返回 { dir, source, raw, chapters, chapterById, canon, contracts, manifest }。
 * canon 内含 characters/facts/secrets/addressRules/worldRules 的索引与冲突断言表。
 */
export async function loadFixture(dir) {
  const base = path.resolve(dir);
  const source = await readFile(path.join(base, 'source.md'), 'utf8');
  const raw = JSON.parse(await readFile(path.join(base, 'ground-truth.json'), 'utf8'));
  const chapters = splitChapters(source);
  const chapterById = new Map(chapters.map((ch) => [ch.id, ch]));

  const contracts = new Map();
  const contractsDir = path.join(base, 'contracts');
  for (const file of (await readdir(contractsDir)).filter((f) => f.endsWith('.md')).sort()) {
    const markdown = await readFile(path.join(contractsDir, file), 'utf8');
    const chapterId = file.replace(/\.md$/, '');
    contracts.set(chapterId, {
      chapter: chapterId,
      file: path.join(contractsDir, file),
      markdown,
      tags: contractTags(markdown),
      length: contractLength(markdown),
      hash: sha1(markdown),
    });
  }

  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(base, 'planted-errors', 'manifest.json'), 'utf8'));
  } catch {
    manifest = null;
  }

  const characters = raw.characters.map((c) => ({ ...c }));
  const charById = new Map(characters.map((c) => [c.id, c]));
  const charByName = new Map(characters.map((c) => [c.name, c]));
  const formToChar = new Map();
  for (const c of characters) {
    formToChar.set(c.name, c);
    for (const a of c.aliases || []) formToChar.set(a, c);
  }

  // 错名：variant -> canonical character
  const typoMap = new Map();
  for (const [variant, correct] of Object.entries(raw.typos || {})) {
    const ch = charByName.get(correct);
    typoMap.set(variant, { variant, correct, charId: ch ? ch.id : null });
  }

  // 事实：把 quote 解析成章节内偏移 + 全书偏移
  const facts = raw.facts.map((f) => {
    const ch = chapterById.get(f.chapter);
    const local = ch ? ch.body.indexOf(f.quote) : -1;
    return {
      ...f,
      localOffset: local,
      offset: local >= 0 ? ch.bodyStart + local : -1,
      found: local >= 0,
    };
  });
  const factById = new Map(facts.map((f) => [f.id, f]));

  // 世界规则：引文同样解析
  const worldRules = (raw.worldRules || []).map((r) => {
    const ch = chapterById.get(r.evidence?.chapter);
    const local = ch && r.evidence ? ch.body.indexOf(r.evidence.quote) : -1;
    return {
      ...r,
      patterns: (r.violationPatterns || []).map((p) => new RegExp(p, 'g')),
      evidenceFound: local >= 0,
      evidenceOffset: local >= 0 ? ch.bodyStart + local : -1,
    };
  });

  // 称呼矩阵：展平为规则列表
  const addressRules = (raw.addressMatrix || []).map((m) => ({
    ...m,
    fromChar: charById.get(m.from) || null,
    toChar: charById.get(m.to) || null,
    fromNum: chapterNum(m.fromChapter),
    retireNum: m.retirePublicFrom ? chapterNum(m.retirePublicFrom) : 0,
    forms: [m.publicForm, m.privateForm, ...(m.taboo || [])].filter(Boolean),
  }));

  // 秘密：knownBy 映射（同时按角色 id 和名字索引；检查器拿到的是说话人名字）
  const secrets = (raw.secrets || []).map((s) => ({
    ...s,
    knownByMap: new Map((s.knownBy || []).flatMap((k) => {
      const ch = charById.get(k.who);
      return ch ? [[k.who, k], [ch.name, k]] : [[k.who, k]];
    })),
    publicNum: chapterNum(s.publicAtChapter || s.dialogueForbiddenBefore || 'ch999'),
    forbiddenNum: s.dialogueForbiddenBefore ? chapterNum(s.dialogueForbiddenBefore) : 0,
  }));

  // 未裁决矛盾中“可被断言的取值”
  const contradictions = (raw.factContradictions || []).map((fc) => {
    const subject = charById.get(fc.subject);
    const variants = new Set();
    for (const v of fc.values || []) {
      variants.add(v);
      variants.add(v.replace(/色$/, ''));
    }
    return { ...fc, subjectChar: subject || null, variants: [...variants] };
  });

  const canon = {
    dir: base,
    fixture: raw.fixture,
    version: raw.version,
    title: raw.title,
    chapters,
    chapterById,
    characters,
    charById,
    charByName,
    formToChar,
    typoMap,
    facts,
    factById,
    factContradictions: raw.factContradictions || [],
    contradictions,
    worldRules,
    secrets,
    addressRules,
    auRules: raw.auRules || [],
    auSignatures: (raw.auRules || []).flatMap((r) => (r.signatures || []).map((s) => ({ sig: s, rule: r }))),
    headcanonSignatures: raw.headcanonSignatures || [],
    terms: raw.terms || [],
    scenes: raw.scenes || [],
    lookupQuestions: raw.lookupQuestions || [],
    source,
    raw,
    contracts,
    manifest,
  };
  canon.sceneById = new Map(canon.scenes.map((s) => [s.id, s]));
  for (const s of canon.scenes) {
    s.contract = contracts.get(s.chapter) || null;
  }
  return canon;
}

/** 结构校验：引文、章节、契约、场景、manifest。返回 { ok, errors, warnings, stats }。 */
export async function validateFixture(canon) {
  const errors = [];
  const warnings = [];
  const stats = {
    chapters: canon.chapters.length,
    characters: canon.characters.length,
    facts: canon.facts.length,
    scenes: canon.scenes.length,
    secrets: canon.secrets.length,
    addressRules: canon.addressRules.length,
    worldRules: canon.worldRules.length,
    contracts: canon.contracts.size,
    plantedCases: canon.manifest?.cases?.length || 0,
    lookupQuestions: canon.lookupQuestions.length,
  };

  // 章节
  const expectedIds = canon.chapters.map((_, i) => `ch${String(i + 1).padStart(3, '0')}`);
  for (const [i, ch] of canon.chapters.entries()) {
    if (ch.id !== expectedIds[i]) errors.push(`章节编号不连续：${ch.id} 应为 ${expectedIds[i]}`);
    if (!ch.body || ch.body.length < 80) errors.push(`${ch.id} 正文过短（${ch.body.length} 字）`);
  }
  if (canon.chapters.length !== 6) errors.push(`章节数应为 6，实际 ${canon.chapters.length}`);

  // 事实引文
  for (const f of canon.facts) {
    if (!f.found) {
      errors.push(`事实 ${f.id} 的引文在 ${f.chapter} 中找不到：${f.quote}`);
      continue;
    }
    const ch = canon.chapterById.get(f.chapter);
    const hits = findAll(ch.body, f.quote).length;
    if (hits !== 1) warnings.push(`事实 ${f.id} 的引文在 ${f.chapter} 出现 ${hits} 次（建议唯一）`);
    const global = canon.source.indexOf(f.quote);
    if (global < 0) errors.push(`事实 ${f.id} 的引文不在 source.md 中`);
  }

  // 世界规则引文
  for (const r of canon.worldRules) {
    if (!r.evidenceFound) errors.push(`世界规则 ${r.id} 的 canon 引文找不到：${r.evidence?.quote}`);
    if (!r.patterns.length) warnings.push(`世界规则 ${r.id} 没有 violationPatterns，无法做确定性检查`);
  }

  // 秘密
  for (const s of canon.secrets) {
    if (!s.signatures?.length) errors.push(`秘密 ${s.id} 没有 signatures`);
    if (!s.knownBy?.length) errors.push(`秘密 ${s.id} 没有 knownBy`);
    for (const k of s.knownBy || []) {
      if (!canon.charById.has(k.who)) errors.push(`秘密 ${s.id} 的 knownBy 指向未知角色 ${k.who}`);
      const ev = k.evidence;
      const ch = ev && canon.chapterById.get(ev.chapter);
      if (!ch || !ev || !ch.body.includes(ev.quote)) {
        errors.push(`秘密 ${s.id} 的 knownBy(${k.who}) 引文找不到：${ev?.quote}`);
      }
    }
  }

  // 称呼矩阵
  for (const m of canon.addressRules) {
    if (!m.fromChar || !m.toChar) errors.push(`称呼规则 ${m.id} 的角色不存在`);
    const ev = m.evidence;
    const ch = ev && canon.chapterById.get(ev.chapter);
    if (!ch || !ev || !ch.body.includes(ev.quote)) {
      errors.push(`称呼规则 ${m.id} 的 evidence 引文找不到：${ev?.quote}`);
    }
    if (m.retireNum && m.retireNum < m.fromNum) {
      errors.push(`称呼规则 ${m.id} 的 retirePublicFrom 早于 fromChapter`);
    }
  }

  // 场景
  const sceneIds = new Set();
  for (const s of canon.scenes) {
    if (sceneIds.has(s.id)) errors.push(`场景 id 重复：${s.id}`);
    sceneIds.add(s.id);
    if (!canon.chapterById.has(s.chapter)) errors.push(`场景 ${s.id} 指向不存在的章节 ${s.chapter}`);
    if (!['canon', 'control'].includes(s.kind)) errors.push(`场景 ${s.id} 的 kind 非法：${s.kind}`);
    if (!['原著向', '私设'].includes(s.tag)) errors.push(`场景 ${s.id} 的 tag 非法：${s.tag}`);
    if (!canon.charById.has(s.pov)) errors.push(`场景 ${s.id} 的 POV 不存在：${s.pov}`);
    for (const who of s.present || []) {
      if (!canon.charById.has(who)) errors.push(`场景 ${s.id} 的在场角色不存在：${who}`);
    }
    if (!canon.charById.has(s.pov) || !(s.present || []).includes(s.pov)) {
      errors.push(`场景 ${s.id} 的 POV 应同时在场`);
    }
    if (!s.contract) errors.push(`场景 ${s.id} 缺少契约文件 ${s.contractFile}`);
    else {
      for (const tag of CONTRACT_TAGS) {
        if (!s.contract.tags.includes(tag)) errors.push(`契约 ${s.contractFile} 缺少段落【${tag}】`);
      }
      if (s.contract.length > 800) errors.push(`契约 ${s.contractFile} 超过 800 字（${s.contract.length}）`);
    }
    for (const rf of s.requiredForms || []) {
      const rule = canon.addressRules.find((m) => m.from === rf.from && m.to === rf.to);
      if (!rule) errors.push(`场景 ${s.id} 的 requiredForms 找不到对应称呼规则：${JSON.stringify(rf)}`);
      else if (!rule.forms.includes(rf.form)) {
        errors.push(`场景 ${s.id} 的 requiredForms「${rf.form}」不在称呼矩阵里`);
      }
    }
    for (const secretId of s.mustReveal || []) {
      if (!canon.secrets.some((x) => x.id === secretId)) errors.push(`场景 ${s.id} 的 mustReveal 指向未知秘密 ${secretId}`);
    }
    if (s.lookupQueries?.length) {
      // 预取检索至少要能命中非空片段，由 verify 的 lookup 统计检查
    }
  }

  // 章节与场景对应：canon 场景各占一章，control 有独立章节
  const canonScenes = canon.scenes.filter((s) => s.kind === 'canon');
  if (canonScenes.length !== 5) errors.push(`canon 场景应为 5 个，实际 ${canonScenes.length}`);
  if (canon.scenes.filter((s) => s.kind === 'control').length !== 1) errors.push('应当恰有 1 个干净对照场景');
  const sceneChapters = canonScenes.map((s) => s.chapter).sort(compareChapter);
  const expectedChapters = ['ch001', 'ch002', 'ch003', 'ch004', 'ch005'];
  if (JSON.stringify(sceneChapters) !== JSON.stringify(expectedChapters)) {
    errors.push(`canon 场景应覆盖 ch001-ch005，实际 ${sceneChapters.join(',')}`);
  }
  if (!canon.scenes.some((s) => s.chapter === 'ch006' && s.kind === 'control')) {
    errors.push('干净对照场景应在 ch006');
  }

  // 秘密的时间线自洽：knownBy 的 fromChapter 不得早于角色登场
  for (const s of canon.secrets) {
    for (const k of s.knownBy || []) {
      const ch = canon.charById.get(k.who);
      if (ch && compareChapter(k.fromChapter, ch.firstChapter) < 0) {
        errors.push(`秘密 ${s.id}：${ch.name} 的知情时间早于登场时间`);
      }
    }
  }

  // lookup 问题的 expected 引文
  for (const q of canon.lookupQuestions) {
    if (!q.call?.question) errors.push(`lookup 问题 ${q.id} 缺少 call.question`);
    if (!q.expected?.length) warnings.push(`lookup 问题 ${q.id} 没有 expected 引文`);
    for (const e of q.expected || []) {
      const ch = canon.chapterById.get(e.chapter);
      if (!ch || !ch.body.includes(e.quote)) {
        errors.push(`lookup 问题 ${q.id} 的 expected 引文在 ${e.chapter} 找不到：${e.quote}`);
      }
    }
  }

  // 契约模板说明：文档写“八段”，模板实际 9 个标签
  warnings.push('开发方案 §6.3 写“固定八段”，但模板列了 9 个标签；本实现按 9 个标签校验（视角/在场/称呼/知情/世界规则/时间线/禁忌/不确定/锚点）');

  // manifest
  const baseDir = canon.dir;
  if (!canon.manifest) {
    warnings.push('未找到 planted-errors/manifest.json，跳过植入错误清单校验');
  } else {
    const cases = canon.manifest.cases || [];
    for (const c of cases) {
      if (!c.id || !c.file) errors.push(`manifest 用例缺少 id/file：${JSON.stringify(c)}`);
      if (!c.scene || !sceneIds.has(c.scene)) errors.push(`用例 ${c.id} 指向未知场景 ${c.scene}`);
      if (!canon.manifest.classes.some((k) => k.key === c.class) && c.class !== 'clean') {
        errors.push(`用例 ${c.id} 的 class 未登记：${c.class}`);
      }
      if (c.class !== 'clean' && !(c.expect || []).length) errors.push(`用例 ${c.id} 没有期望 finding`);
      const full = path.join(baseDir, 'planted-errors', c.file);
      try {
        await stat(full);
      } catch {
        errors.push(`用例 ${c.id} 的文件不存在：${c.file}`);
      }
    }
    const classes = new Set(cases.map((c) => c.class));
    for (const k of canon.manifest.classes) {
      if (!classes.has(k.key)) errors.push(`manifest 登记的类别 ${k.key}（${k.name}）没有对应用例`);
    }
  }

  // 契约总量与长度
  for (const [chapter, c] of canon.contracts) {
    if (!canon.chapterById.has(chapter)) errors.push(`契约 ${chapter}.md 没有对应章节`);
    if (c.length > 800) errors.push(`契约 ${chapter}.md 超长`);
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

/** 取场景契约的纯文本（arm B/C 用）。 */
export function contractText(scene) {
  return scene?.contract?.markdown || '';
}
