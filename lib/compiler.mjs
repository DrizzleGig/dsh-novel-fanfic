// 场景契约编译器：从 canon + 场景生成 9 段式契约，替代手写 contracts/*.md。
// 契约只回答「这一段不能写错什么」：视角、在场、称呼、知情边界、世界规则、时间线、禁忌、未定项、锚点。
// 不写剧情建议，不替作者做文学决定。

import { sha1 } from './hash.mjs';
import { DELTA_KINDS } from './deltas.mjs';

export const CONTRACT_TAGS = ['视角', '在场', '称呼', '知情', '世界规则', '时间线', '禁忌', '不确定', '锚点'];
export const DELTA_TAG = '本作';

const PREDICATE_LABEL = {
  eye_color: '眼睛颜色',
  eyeColor: '眼睛颜色',
  scar_side: '疤的位置',
  age: '年龄',
  role: '身份',
};

const AU_LIMIT = 3;
const ANCHOR_LIMIT = 2;
const ANCHOR_QUOTE_MAX = 34;

function brief(text, max = ANCHOR_QUOTE_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function chNumOf(chapter) {
  const m = /^ch(\d+)$/.exec(chapter || '');
  return m ? Number(m[1]) : 0;
}

function stripEnd(text) {
  return String(text || '').replace(/[。；;，,\s]+$/g, '');
}

function joinNames(names) {
  return names.length ? names.join('、') : '（无）';
}

function addressSection(scene, canon, chNum) {
  const present = new Set(scene.present || []);
  const lines = [];
  for (const rule of canon.addressRules || []) {
    if (!present.has(rule.from) || !present.has(rule.to)) continue;
    const from = rule.fromChar.name;
    const to = rule.toChar.name;
    const retire = rule.retireNum && rule.retireNum > 0 ? rule.retireNum : null;
    let line = `${from}→${to}：`;
    if (retire && chNum === retire) {
      line += `本章起改口「${rule.privateForm}」，不再用「${rule.publicForm}」`;
    } else if (retire && chNum > retire) {
      line += `沿用「${rule.privateForm}」，不再用「${rule.publicForm}」`;
    } else if (retire && chNum < retire) {
      line += `仍用「${rule.publicForm}」，还没到改口的时候`;
    } else {
      line += rule.privateForm ? `「${rule.publicForm}」（私下可「${rule.privateForm}」）` : `「${rule.publicForm}」`;
    }
    if (rule.taboo && rule.taboo.length) line += `；忌讳「${rule.taboo.join('」「')}」绝对不许用`;
    lines.push(line);
    if (lines.length >= 5) break;
  }
  for (const req of scene.requiredForms || []) {
    const from = canon.charById.get(req.from)?.name || req.from;
    const to = canon.charById.get(req.to)?.name || req.to;
    lines.push(`必须出现：${from}叫${to}「${req.form}」`);
  }
  return lines.length ? lines.join('；') + '。' : '在场者之间没有必须遵守的称呼变化。';
}

function knowledgeSection(scene, canon, chNum) {
  const present = new Set(scene.present || []);
  const parts = [];
  for (const secret of canon.secrets || []) {
    // 没有声明「谁知道」的秘密不写知情边界：与其编一句「都不知道」，不如不说。
    if (!(secret.knownBy || []).length) continue;
    // 只写和在场者有关的秘密：一个在场者都不知道、也不是本章埋的秘密，写进来只是噪音。
    const relevant = (secret.knownBy || []).some((k) => present.has(k.who)) || secret.evidence?.chapter === scene.chapter;
    if (!relevant) continue;
    const known = new Map();
    for (const k of secret.knownBy || []) {
      const char = canon.charById.get(k.who) || { id: k.who, name: k.who };
      known.set(char.id, { name: char.name, num: chNumOf(k.fromChapter), from: k.fromChapter });
    }
    const forbiddenBefore = Number.isFinite(secret.forbiddenNum) ? secret.forbiddenNum : 0;
    const knowNow = [];
    const knowFromThis = [];
    const knowButSilent = [];
    const learnSilent = [];
    const unknown = [];
    for (const id of present) {
      const char = canon.charById.get(id);
      const name = char?.name || id;
      const k = known.get(id);
      const gated = forbiddenBefore > chNum;
      if (!k || k.num > chNum) {
        unknown.push(name);
      } else if (k.num === chNum) {
        if (gated) learnSilent.push(name);
        else knowFromThis.push(name);
      } else if (gated) {
        knowButSilent.push(name);
      } else {
        knowNow.push(name);
      }
    }
    // 每条秘密合成一句，并带上秘密的短标签：多条秘密混在一起时，
    // 「X 已知情」/「Y 还不知道」必须能看出说的是哪件事。
    const seg = [];
    if (knowButSilent.length) seg.push(`${joinNames(knowButSilent)}知道但不能说，只能暗示或回避`);
    if (knowNow.length) seg.push(`${joinNames(knowNow)}已知情，可以说`);
    if (learnSilent.length) seg.push(`${joinNames(learnSilent)}本章才知道，但不能说出口`);
    if (knowFromThis.length) seg.push(`${joinNames(knowFromThis)}本章才知道`);
    if (unknown.length) seg.push(`${joinNames(unknown)}不知情，不得说出、想到或听见`);
    if ((scene.mustReveal || []).includes(secret.id)) {
      const teller =
        (secret.knownBy || [])
          .filter((k) => present.has(k.who) && chNumOf(k.fromChapter) <= chNum)
          .map((k) => canon.charById.get(k.who)?.name || k.who)[0] || '知情的一方';
      seg.push(`本章必须由${teller}亲口说出`);
    }
    if (!seg.length) continue;
    const label = String(secret.what || '').slice(0, 12);
    parts.push(label ? `「${label}…」${seg.join('，')}` : seg.join('，'));
    if (parts.length >= 3) break;
  }
  const unique = [...new Set(parts)].slice(0, 4);
  return unique.length ? unique.join('；') + '。' : '在场者之间没有需要隐瞒的知情边界。';
}

// 世界规则只挑「本章及前两章」的，再补几条最早的，最多 4 条、每条截到 70 字：
// 长篇导入后规则可能有上百条，全塞进契约既超长又没有针对性。
function worldRuleSection(scene, canon, chNum) {
  const all = (canon.worldRules || []).map((r) => stripEnd(r.text)).filter(Boolean);
  if (!all.length) return '（无）';
  const near = [];
  for (const rule of canon.worldRules || []) {
    const text = stripEnd(rule.text);
    if (!text) continue;
    const ch = rule.evidence?.chapter || rule.chapter || '';
    const n = chNumOf(ch);
    if (Number.isFinite(n) && n <= chNum && chNum - n <= 2) near.push(text);
  }
  const picked = [];
  const seen = new Set();
  for (const text of [...near, ...all]) {
    const clipped = text.length > 70 ? `${text.slice(0, 70)}…` : text;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    picked.push(clipped);
    if (picked.length >= 4) break;
  }
  return picked.join('；');
}

/** 契约硬上限：IA 写的是 ≤800 字。段本身有上限，这里再兜一层（按 世界规则→知情→称呼 顺序削句）。 */
const CONTRACT_BUDGET = 800;/**
 * 有任务卡时契约标题下那一行元数据。它也算进 800 字预算（fitBudget 会预留它的长度），
 * 所以 conductor 按 800 字裁剪时不会把【锚点】整段切掉。
 */
function missionHeader(mission) {
  const bits = ['任务卡：有'];
  if (mission.beats?.length) bits.push(`${mission.beats.length} 个节拍`);
  if (mission.openQuestions?.length) bits.push(`${mission.openQuestions.length} 项开放`);
  if (mission.goal) bits.push(`目标「${brief(stripEnd(mission.goal), 40)}」`);
  return `> ${bits.join('　')}`;
}

function fitBudget(tags, reserve = 0) {
  const budget = CONTRACT_BUDGET - Math.max(0, reserve);
  const size = () => Object.values(tags).reduce((n, v) => n + String(v || '').length + 6, 80);
  for (const key of ['世界规则', '知情', '称呼']) {
    if (size() <= budget) break;
    const parts = String(tags[key] || '').split('；');
    while (parts.length > 1 && size() > budget) {
      parts.pop();
      tags[key] = `${parts.join('；')}…`;
    }
  }
  // 本作设定是最后才削的：先保住「优先于原著」和第一条/前提，再削后面的条目。
  if (size() > budget && tags['本作']) {
    const parts = String(tags['本作']).split('；');
    while (parts.length > 2 && size() > budget) {
      parts.pop();
      tags['本作'] = `${parts.join('；')}…`;
    }
  }
  return tags;
}

function timelineSection(scene, canon, chNum) {
  if (scene.timeline) return scene.timeline;
  const prev = canon.chapters[chNum - 2];
  const tail = prev ? `紧接${prev.id}（${prev.title}）之后` : '全书开头';
  return `${tail}；只写此刻与此前已经发生的事，不写以后的情节。`;
}

function tabooSection(scene, canon) {
  const au = [...new Set((canon.auRules || []).flatMap((r) => r.signatures || []))].slice(0, AU_LIMIT);
  const parts = [];
  if (au.length) parts.push(`不得出现「${au.join('」「')}」这类非原著的 AU 设定`);
  parts.push(`首行标签必须是「${scene.tag || '原著向'}」`);
  parts.push('不得连续照抄原著 20 字以上');
  return parts.join('；') + '。';
}

// 本作设定（Fic Canon）：作者明确要改的原著事实。
// 只有真的有改动时才加这一段；没有本作设定的书仍是原来的 9 段契约。
function deltaSection(scene, canon, chNum) {
  const items = Array.isArray(canon?.deltas) ? canon.deltas : [];
  const premise = String(canon?.premise || '').trim();
  const present = new Set(scene.present || []);
  const presentNames = new Set([...present].map((id) => canon.charById?.get(id)?.name || id));
  const relevant = items.filter((row) => {
    if (!row || !row.title || !row.statement) return false;
    if (row.fromChapter && chNumOf(row.fromChapter) > chNum) return false;
    if (['character', 'relationship', 'address', 'knowledge'].includes(row.kind) && (row.subjects || []).length) {
      return row.subjects.some((subject) => present.has(subject) || presentNames.has(subject));
    }
    return true;
  }).slice(0, 4);
  if (!premise && !relevant.length) return '';
  const parts = ['本作设定优先于以下原著事实；与本作冲突时按本作写'];
  if (premise) parts.push(`前提：${brief(stripEnd(premise), 120)}`);
  for (const row of relevant) {
    const label = DELTA_KINDS[row.kind] || DELTA_KINDS.other;
    parts.push(`${label}「${brief(stripEnd(row.title), 30)}」：${brief(stripEnd(row.statement), 120)}`);
  }
  return parts.join('；') + '。';
}

function unknownSection(scene, canon) {
  const present = new Set(scene.present || []);
  const open = (canon.contradictions || []).filter((c) => c.status !== 'resolved');
  const lines = [];
  for (const c of open) {
    const subjId = c.subjectChar?.id || c.subject;
    if (subjId && present.size && !present.has(subjId)) continue;
    const vals = (c.values || []).join(' / ');
    const label = PREDICATE_LABEL[c.predicate] || c.predicate;
    const chapters = (c.chapters || []).join('、');
    lines.push(`${label}（${c.id}，${chapters} 记作 ${vals}）未裁决：本章不要断言`);
  }
  // 章节任务卡的「开放问题」单向注入这里（任务卡 → 契约，不回写）。
  // 没有任务卡时这一行不出现，v0.1 的契约输出逐字不变。
  const mission = canon.missions?.[scene.chapter];
  const questions = Array.isArray(mission?.openQuestions) ? mission.openQuestions.slice(0, 3) : [];
  if (questions.length) {
    lines.push(`任务卡里还挂着 ${questions.length} 个开放问题，写之前先定：${questions.join('；')}`);
  }
  return lines.length ? lines.join('；') + '。' : '本章没有未裁决的设定，按已确认事实写。';
}

function anchorsSection(scene, canon, chNum) {
  const present = new Set(scene.present || []);
  const anchors = [];
  const seen = new Set();
  const push = (chapter, quote) => {
    if (!quote || anchors.length >= ANCHOR_LIMIT) return;
    const key = `${chapter}:${quote}`;
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push(`「${brief(quote)}」（${chapter}）`);
  };
  for (const rule of canon.addressRules || []) {
    if (!present.has(rule.from) || !present.has(rule.to)) continue;
    if (chNumOf(rule.evidence?.chapter) > chNum) continue;
    push(rule.evidence?.chapter, rule.evidence?.quote);
  }
  for (const secret of canon.secrets || []) {
    if (!(scene.mustReveal || []).includes(secret.id)) continue;
    const ev = (secret.knownBy || []).find((k) => chNumOf(k.fromChapter) <= chNum)?.evidence;
    if (ev) push(ev.chapter, ev.quote);
  }
  for (const fact of canon.facts || []) {
    if (fact.chapter === scene.chapter && fact.status === 'confirmed') push(fact.chapter, fact.quote);
  }
  for (const fact of canon.facts || []) {
    if (fact.chapter < scene.chapter && fact.status === 'confirmed') push(fact.chapter, fact.quote);
  }
  return anchors.length ? anchors.join('；') : '（暂无）';
}

export function compileContract(scene, canon) {
  const chNum = chNumOf(scene.chapter);
  const mission = canon.missions?.[scene.chapter] || null;
  const pov = canon.charById.get(scene.pov);
  const presentNames = (scene.present || []).map((id) => canon.charById.get(id)?.name || id);
  const tags = {
    视角: `${pov?.name || scene.pov}（第三人称受限，只写他能看见、听见、想到的）`,
    在场: joinNames(presentNames),
    称呼: addressSection(scene, canon, chNum),
    知情: knowledgeSection(scene, canon, chNum),
    世界规则: worldRuleSection(scene, canon, chNum),
    时间线: timelineSection(scene, canon, chNum),
    禁忌: tabooSection(scene, canon),
    不确定: unknownSection(scene, canon),
    锚点: anchorsSection(scene, canon, chNum),
  };
  // 本作设定放在最前面：先把「作者改了什么」说清楚，再读原著的约束。
  const delta = deltaSection(scene, canon, chNum);
  if (delta) tags[DELTA_TAG] = delta;
  // 任务卡的元数据行也吃 800 字预算：先把它算出来，再让 fitBudget 预留这部分。
  const missionHead = mission ? missionHeader(mission) : '';
  fitBudget(tags, missionHead ? missionHead.length + 4 : 0);
  const order = delta ? [DELTA_TAG, ...CONTRACT_TAGS] : CONTRACT_TAGS;
  const lines = [`# 场景契约 ${scene.chapter}（${scene.id}）`];
  // 有任务卡时加一行元数据（没有就不加，v0.1 的输出逐字不变）：
  // 作者与 conductor 都能看到「这一章写前想过没有」。
  if (missionHead) lines.push(missionHead);
  for (const tag of order) lines.push(`【${tag}】${tags[tag]}`);
  const markdown = lines.join('\n') + '\n';
  return {
    id: scene.id,
    chapter: scene.chapter,
    file: scene.contractFile || `contracts/${scene.chapter}.md`,
    markdown,
    tags,
    chars: markdown.length,
    hash: sha1(markdown),
  };
}

export function compileAll(canon, scenes = canon.scenes) {
  return scenes.map((scene) => compileContract(scene, canon));
}

// 与磁盘上现有契约逐份比较，返回漂移列表；用于 verify 与测试。
export function contractDrift(canon) {
  const drift = [];
  for (const scene of canon.scenes) {
    const compiled = compileContract(scene, canon);
    const onDisk = canon.contracts.get(scene.chapter);
    if (!onDisk) {
      drift.push({ chapter: scene.chapter, reason: 'missing', scene: scene.id });
      continue;
    }
    if (onDisk.markdown.trim() !== compiled.markdown.trim()) {
      drift.push({
        chapter: scene.chapter,
        reason: 'differs',
        scene: scene.id,
        diskHash: onDisk.hash,
        compiledHash: compiled.hash,
      });
    }
  }
  return drift;
}
