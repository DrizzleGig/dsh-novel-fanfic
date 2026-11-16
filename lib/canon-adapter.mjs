// canon 适配器：把 .dsh-novel-fanfic/<project>/ 的 canon 存储映射成编译器/检查器/检索器
// 认识的那套形状（与 fixtures 的 ground-truth 同构）。只做形状转换与索引，不改任何状态。
//
// 已知边界（v0.1）：
// - 世界观规则的 violationPatterns 只做「规则句里能读出来的禁令」推断（触发词 × 禁止动作，
//   正反两个方向、40 字窗口），读不出来就留空；这是启发式，宁可漏报不硬凑；
// - AU/私设/错名签名来自作者声明（declarations.json，见 lib/declarations.mjs）：
//   适配器不猜，作者声明什么就抓什么；
// - 场景按章生成（POV 取该章事实最多的人物），没有夹具里的探针 handwriting。

import { readFile } from 'node:fs/promises';
import { loadProject } from './canon-store.mjs';
import { normalizeDeclarations, declarationFile, loadDeclarations } from './declarations.mjs';
import { normalizeDeltas, deltaFile, loadDeltas } from './deltas.mjs';
import { chapterNum, compareChapter } from './text.mjs';

const confirmed = (rows) => (rows || []).filter((row) => row && row.status === 'confirmed');

/** 从一句话里拆出可被检查器命中的秘密签名（去标点、≥4 字）。 */
export function deriveSignatures(what) {
  const parts = String(what || '')
    .split(/[，。；、,.;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  return [...new Set(parts)];
}

function sideOf(value) {
  const s = String(value || '');
  if (/左/.test(s) && !/右/.test(s)) return '左';
  if (/右/.test(s) && !/左/.test(s)) return '右';
  return null;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 规则句里常只写一个禁令动作（不许出声），实际违规写法会换词（喊、叫、嚷）。
// 这里补一层同义动作，宁可多点命中、再由检查器的守规矩守卫筛掉。
const ACTION_SYNONYMS = [
  [/出声|说话|开口|吭声|喊|叫/, ['出声', '说话', '开口', '吭声', '喊', '叫', '嚷']],
  [/走动|迈步|跑|奔|离开/, ['走动', '迈步', '跑', '奔跑', '起身', '离开', '挪步']],
  [/离岸|出港|开船|解缆|出海|起锚/, ['离岸', '出港', '开船', '解缆', '出海', '起锚']],
  [/点灯|掌灯/, ['点灯', '掌灯', '点火']],
  [/开门|开窗/, ['开门', '开窗']],
];

const TRIGGER_SYNONYMS = {
  潮声钟响: ['潮声钟响', '钟响', '钟声'],
  涨雾日: ['涨雾日', '涨雾'],
};

/** 规则原句里的触发词归一：去「时/的时候/之时」尾巴、去掉「明日是」这类前缀。 */
function normalizeTrigger(raw) {
  return String(raw || '')
    .replace(/(?:的时候|之时|时)$/, '')
    .replace(/^(?:明日|今日|今晚|当天)?(?:是|为)/, '')
    .trim();
}

/** 把触发词塞进集合（含同义词表与结尾「钟响→钟声」这类常见换词）。 */
function addTrigger(set, raw) {
  const trigger = normalizeTrigger(raw);
  if (trigger.length < 2 || trigger.length > 10) return;
  set.add(trigger);
  for (const synonym of TRIGGER_SYNONYMS[trigger] || []) set.add(synonym);
  if (trigger.endsWith('钟响')) set.add(`${trigger.slice(0, -2)}钟声`);
  if (trigger.length >= 3) set.add(trigger.slice(-2));
}

/**
 * 从一条世界观规则的原句里推断违规正则（RegExp[]）。
 * 结构：触发词（潮声钟响）× 禁止动作（出声），正反两个方向、40 字窗口。
 * 读不出触发词或动作就返回空数组——不为未知规则硬造模式。
 */
export function worldRulePatterns(text) {
  const src = String(text || '');
  const triggers = new Set();
  const actions = new Set();

  const triggerMatch = /([\u4e00-\u9fa5]{2,10}?)(?:的时候|之时|那天|当晚)/.exec(src);
  if (triggerMatch) addTrigger(triggers, triggerMatch[1]);

  const banned = /(?:不许|不得|不准|禁止|不能|不可以)([\u4e00-\u9fa5]{2,6})/g;
  let m;
  while ((m = banned.exec(src)) !== null) {
    const verb = m[1];
    actions.add(verb);
    for (const [test, add] of ACTION_SYNONYMS) {
      if (test.test(verb)) add.forEach((action) => actions.add(action));
    }
    if (triggers.size === 0) {
      // 没有「……的时候」这类触发词：从禁令前半句里取最后两个短语（如「涨雾日，封港。船不许离岸」→ 涨雾日、封港）。
      const prefix = src.slice(0, m.index);
      const segments = prefix.split(/[。！？；]/).filter((segment) => segment.trim());
      const tail = (segments.slice(-2).join('，') || '').split(/[、，,\s]+/);
      for (const token of tail) addTrigger(triggers, token);
    }
  }

  if (triggers.size === 0 || actions.size === 0) return [];
  const triggerAlt = [...triggers].map(escapeRe).join('|');
  const actionAlt = [...actions].map(escapeRe).join('|');
  return [
    new RegExp(`(?:${triggerAlt})[^。！？\\n]{0,40}?(?:${actionAlt})`, 'g'),
    new RegExp(`(?:${actionAlt})[^。！？\\n]{0,40}?(?:${triggerAlt})`, 'g'),
  ];
}

/**
 * 把 canon 存储 + 章节正文映射成 ground-truth 形状。
 * @param {{project: object, canon: object, index: object|null, paths: object}} loaded
 * @param {Array<{id:string,title:string,body:string,ordinal:number}>} chapters
 */
export function adaptCanon(loaded, chapters) {
  const store = loaded.canon || {};
  const project = loaded.project || {};

  const characters = confirmed(store.characters).map((row) => ({
    id: row.id,
    name: row.name,
    aliases: [...(row.aliases || [])],
    tabooForms: [],
    firstChapter: row.firstChapter || null,
    lastChapter: row.lastChapter || null,
    evidence: row.evidence || [],
  }));
  const charById = new Map(characters.map((row) => [row.id, row]));
  const charByName = new Map(characters.map((row) => [row.name, row]));
  const formToChar = new Map();
  for (const ch of characters) {
    formToChar.set(ch.name, ch);
    for (const alias of ch.aliases || []) formToChar.set(alias, ch);
  }

  // 作者私设声明（AU / 私设 / 错名）：不进 canon、不参与契约，只喂检查器。
  const declarations = normalizeDeclarations(loaded.declarations || {});
  // 本作设定（Fic Canon）：进契约的【本作】段，优先于原著；带 suppress 的还会让检查器放过同类 finding。
  const deltaData = normalizeDeltas(loaded.deltas || {});
  const typoMap = new Map();
  for (const [variant, correct] of Object.entries(declarations.typos)) {
    const ch = charByName.get(correct);
    typoMap.set(variant, { variant, correct, charId: ch ? ch.id : null });
  }

  const facts = confirmed(store.facts).map((row) => ({
    id: row.id,
    subject: row.subjectName || row.subject,
    subjectId: row.subject,
    predicate: row.predicate,
    object: row.object,
    chapter: row.chapter,
    offset: row.offset,
    quote: row.quote,
    status: row.status,
    evidence: row.evidence || [],
  }));
  const factById = new Map(facts.map((row) => [row.id, row]));

  // 外观事实 → characters[].appearance（只收已确认的位置类事实）
  for (const fact of facts) {
    if (fact.predicate !== 'scar_side') continue;
    const side = sideOf(fact.object);
    if (!side) continue;
    const ch = charByName.get(fact.subject);
    if (!ch) continue;
    ch.appearance = { ...(ch.appearance || {}), scarSide: { value: side, factId: fact.id } };
  }

  const contradictions = (store.contradictions || [])
    .filter((row) => row && row.status !== 'resolved')
    .map((row) => {
      const subjectChar = charById.get(row.subject) || charByName.get(row.subject) || null;
      const values = [...(row.values || [])];
      const variants = new Set();
      for (const value of values) {
        variants.add(value);
        variants.add(String(value).replace(/色$/, ''));
      }
      return {
        id: row.id,
        subject: subjectChar?.id || row.subject,
        subjectChar,
        predicate: row.predicate,
        values,
        variants: [...variants],
        chapters: [...(row.chapters || [])],
        factIds: [...(row.factIds || [])],
        status: row.status,
        evidence: row.evidence || [],
      };
    });

  const secrets = confirmed(store.secrets).map((row) => {
    const knownBy = (row.knownBy || []).map((k) => ({ ...k, evidence: row.evidence }));
    const knownByMap = new Map();
    for (const k of knownBy) {
      const who = charById.get(k.who);
      knownByMap.set(k.who, k);
      if (who) knownByMap.set(who.name, k);
    }
    const publicNum = row.publicAtChapter ? chapterNum(row.publicAtChapter) : 0;
    return {
      id: row.id,
      what: row.what,
      signatures: deriveSignatures(row.what),
      knownBy,
      knownByMap,
      publicAtChapter: row.publicAtChapter || null,
      publicNum,
      forbiddenNum: publicNum,
      evidence: row.evidence || [],
    };
  });

  // 称呼：同一对人物可能有多条（先公后私），合成一条带改口时点的规则
  const groups = new Map();
  for (const row of confirmed(store.addresses)) {
    const key = `${row.from}>${row.to}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const addressRules = [];
  const formOf = (s) => String(s || '').split(/[（(]/)[0].trim();
  for (const rows of groups.values()) {
    const sorted = [...rows].sort((a, b) => chapterNum(a.fromChapter) - chapterNum(b.fromChapter));
    // 忌讳里可能带「为什么算忌讳」的括号说明；只留称呼本身。
    const taboo = [...new Set(sorted.flatMap((row) => (row.taboo || []).map(formOf)).filter(Boolean))];
    // 提取器有时把被拒绝的叫法写成第一条；公称呼要跳过这些忌讳写法。
    const usable = sorted.filter((row) => !taboo.includes(formOf(row.form)));
    const pool = usable.length ? usable : sorted;
    const first = pool[0];
    const last = pool[pool.length - 1];
    const publicForm = first.form;
    const candidate = last.form !== first.form ? last.form : (last.privateForm || null);
    const privateForm = candidate && candidate !== publicForm ? candidate : null;
    const changed = Boolean(privateForm);
    addressRules.push({
      id: first.id,
      from: first.from,
      to: first.to,
      fromChar: charById.get(first.from) || null,
      toChar: charById.get(first.to) || null,
      publicForm,
      privateForm: privateForm || null,
      fromChapter: first.fromChapter,
      retirePublicFrom: changed ? last.fromChapter : null,
      fromNum: chapterNum(first.fromChapter),
      retireNum: changed ? chapterNum(last.fromChapter) : 0,
      taboo,
      forms: [...new Set([publicForm, privateForm, ...taboo].filter(Boolean))],
      evidence: first.evidence || null,
    });
  }

  const worldRules = confirmed(store.worldRules).map((row) => ({
    id: row.id,
    name: row.id,
    text: row.text,
    evidence: row.evidence || null,
    patterns: worldRulePatterns(row.text),
  }));

  const chapterById = new Map(chapters.map((ch) => [ch.id, ch]));
  const realChapters = chapters.filter((ch) => ch.id !== 'ch000');

  // 场景：按章生成，POV = 该章事实最多的人物；在场 = 该章有事实的人物
  const scenes = realChapters.map((chapter, index) => {
    const inChapter = facts.filter((fact) => fact.chapter === chapter.id);
    const refs = new Set();
    const counter = new Map();
    for (const fact of inChapter) {
      const id = fact.subjectId || charByName.get(fact.subject)?.id;
      if (!id || !charById.has(id)) continue;
      counter.set(id, (counter.get(id) || 0) + 1);
      refs.add(id);
    }
    // 称呼引文落在本章 → 说话双方都在场（只看本章的证据，不能把「以前所有说过话的人」都算进来）
    for (const rule of addressRules) {
      if (rule.evidence?.chapter !== chapter.id) continue;
      if (rule.from) refs.add(rule.from);
      if (rule.to) refs.add(rule.to);
    }
    for (const secret of secrets) {
      if (secret.evidence?.chapter !== chapter.id) continue;
      for (const k of secret.knownBy || []) if (k.who) refs.add(k.who);
    }
    const present = [...refs].filter((id) => charById.has(id));
    const candidates = present.length ? present : characters.map((c) => c.id).slice(0, 3);
    // POV：先看本章正文里谁的名字出现最多（叙述主体通常就是被点名最多的人），
    // 名字一次都没出现时才退回「本章事实最多的人」。
    const body = chapter.body || '';
    const nameHits = new Map();
    for (const ch of characters) {
      let hits = 0;
      for (const form of [ch.name, ...(ch.aliases || [])]) {
        if (!form) continue;
        let at = 0;
        while ((at = body.indexOf(form, at)) >= 0) {
          hits += 1;
          at += form.length;
        }
      }
      if (hits) nameHits.set(ch.id, hits);
    }
    const byName = [...nameHits.entries()].sort((a, b) => b[1] - a[1] || (counter.get(b[0]) || 0) - (counter.get(a[0]) || 0));
    const pov =
      byName[0]?.[0] || [...counter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || candidates[0] || null;
    if (!pov) return null;
    if (!present.includes(pov)) present.unshift(pov);
    const prev = realChapters[index - 1];
    return {
      id: `scene_${index + 1}`,
      chapter: chapter.id,
      kind: 'canon',
      tag: '原著向',
      pov,
      present,
      register: '第三人称受限',
      instruction:
        `第 ${index + 1} 章「${chapter.title || chapter.id}」。视角：${charById.get(pov)?.name || pov}；`
        + `在场：${present.map((id) => charById.get(id)?.name || id).join('、')}。`
        + '按已确认 canon 写这一章，不引入新设定。',
      timeline: prev ? `紧接 ${prev.id}（${prev.title || prev.id}）之后` : '全书开头',
      minChars: 400,
      maxChars: 900,
      requiredForms: [],
      mustReveal: [],
      probes: [],
      contractFile: `contracts/${chapter.id}.md`,
    };
  }).filter(Boolean);

  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const source = realChapters.map((ch) => ch.body).join('\n\n');

  return {
    project,
    chapters,
    chapterById,
    characters,
    charById,
    charByName,
    formToChar,
    facts,
    factById,
    typoMap,
    typos: declarations.typos,
    worldRules,
    secrets,
    addressRules,
    contradictions,
    factContradictions: contradictions,
    deltas: deltaData.items,
    premise: deltaData.premise,
    deltaData,
    auRules: declarations.auRules,
    auSignatures: declarations.auRules.flatMap((rule) => (rule.signatures || []).map((sig) => ({ sig, rule }))),
    headcanonSignatures: declarations.headcanonSignatures,
    terms: characters.flatMap((c) => [c.name, ...(c.aliases || [])]),
    scenes,
    sceneById,
    lookupQuestions: [],
    source,
    raw: null,
    contracts: new Map(),
    manifest: null,
  };
}

/** 读项目 + 章节正文，返回适配后的 canon（与 fixtures 的 canon 同构）。 */
export async function loadProjectCanon(root, project) {
  const loaded = await loadProject(root, project);
  if (!loaded.index) throw new Error('项目还没有导入原著：先 /fic import <文件> 或运行 fanfic-canon import');
  const sourceId = loaded.project.sourceId;
  const chapters = [];
  let cursor = 0;
  for (const meta of loaded.index.chapters || []) {
    const body = await readFile(loaded.paths.source(sourceId).chapter(meta.id), 'utf8');
    chapters.push({ ...meta, body, start: cursor, bodyStart: cursor, end: cursor + body.length });
    cursor += body.length + 2; // 与 join('\n\n') 的 source 对齐
  }
  if (!chapters.length) throw new Error('项目没有可用的章节');
  loaded.declarations = await loadDeclarations(declarationFile(loaded.paths.dir));
  loaded.deltas = await loadDeltas(deltaFile(loaded.paths.dir));
  const canon = adaptCanon(loaded, chapters);
  if (!canon.scenes.length) throw new Error('canon 里还没有足够的事实来生成场景：先确认至少一个人物与几条事实');
  return { ...loaded, canon, adapted: true };
}

