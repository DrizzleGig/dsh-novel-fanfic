// LLM 提案的校验、合并与审阅：quote 必须能在该章命中；新条目默认 pending；
// 同一 subject+predicate 出现不同 object 时写 fact-contradiction，不覆盖旧事实。

import { nextId } from './canon-store.mjs';

export const PROPOSAL_KINDS = ['entity', 'fact', 'world_rule', 'secret', 'address', 'knowledge', 'timeline', 'voice'];
// 只有一个取值才说得通的那类事实；「拥有物/关系/身份」可以同时有多条，不算矛盾。
export const FUNCTIONAL_PREDICATES = new Set([
  // 只有「对同一个人不该随时间变」的谓词才算功能性冲突。
  // age / height 会随剧情推进正常变化（长篇尤其如此），不能当设定矛盾。
  'eye_color', 'scar_side', 'birth_year', 'birthday', 'gender', 'name',
]);
// 不是称呼的「称呼」（代词、指代短语）。
const NOT_ADDRESS = /^(你|我|他|她|您|它|你们|咱们|我们)$|那孩子|这小子|丫头|孩子$/;
const MAX_QUOTE = 60;

function noSpace(text) {
  const chars = [];
  const offsets = [];
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) continue;
    chars.push(text[i]);
    offsets.push(i);
  }
  return { text: chars.join(''), offsets };
}

// 在章节正文里定位 quote；返回 { found, offset, exact }。
export function locateQuote(body, quote) {
  const idx = body.indexOf(quote);
  if (idx >= 0) return { found: true, offset: idx, exact: true };
  const nb = noSpace(body);
  const nq = noSpace(quote);
  if (!nq.text) return { found: false, offset: -1, exact: false };
  const at = nb.text.indexOf(nq.text);
  if (at < 0) return { found: false, offset: -1, exact: false };
  return { found: true, offset: nb.offsets[at], exact: false };
}

export function validateProposal(p, chapterBody, chapterId) {
  if (!p || typeof p !== 'object') return { ok: false, reason: '提案不是对象' };
  if (!PROPOSAL_KINDS.includes(p.kind)) return { ok: false, reason: `未知 kind：${p.kind}` };
  const quote = String(p.quote || '');
  if (!quote.trim()) return { ok: false, reason: '缺少 quote' };
  if (noSpace(quote).text.length > MAX_QUOTE) return { ok: false, reason: `quote 超过 ${MAX_QUOTE} 字` };
  const hit = locateQuote(chapterBody, quote);
  if (!hit.found) return { ok: false, reason: `quote 在本章找不到：${quote.slice(0, 20)}…` };
  const declared = Number(p.offset);
  const corrected = Number.isFinite(declared) && Math.abs(declared - hit.offset) > 300;
  return {
    ok: true,
    offset: hit.offset,
    exact: hit.exact,
    offsetCorrected: corrected,
    reason: corrected ? `offset 从 ${declared} 校正为 ${hit.offset}` : null,
  };
}

function charKey(c) {
  return `${c.name}|${(c.aliases || []).join(',')}`;
}

function resolveCharacter(canon, who) {
  if (!who) return null;
  const direct = canon.characters.find((c) => c.id === who);
  if (direct) return direct;
  const name = String(who).trim();
  return canon.characters.find((c) => c.name === name || (c.aliases || []).includes(name)) || null;
}

function subjectId(canon, subject) {
  const c = resolveCharacter(canon, subject);
  return c ? c.id : String(subject);
}

export function applyProposals(canon, rawProposals, chapterTexts) {
  const report = { applied: [], rejected: [], skipped: [], unresolvedSubject: [] };
  const pushProposal = (row) => {
    canon.proposals.push(row);
  };

  for (const raw of rawProposals) {
    const chapterId = raw.chapter;
    const body = chapterTexts.get(chapterId);
    if (!body) {
      report.rejected.push({ proposal: raw, reason: `未知章节：${chapterId}` });
      continue;
    }
    const v = validateProposal(raw, body, chapterId);
    if (!v.ok) {
      report.rejected.push({ proposal: raw, reason: v.reason });
      pushProposal({
        id: nextId('prop', canon.proposals), kind: raw.kind || 'unknown', chapter: chapterId,
        offset: Number(raw.offset) || 0, quote: String(raw.quote || ''), payload: raw.payload || {},
        confidence: Number(raw.confidence) || 0, status: 'rejected', reason: v.reason,
      });
      continue;
    }
    const base = {
      id: nextId('prop', canon.proposals),
      kind: raw.kind,
      chapter: chapterId,
      offset: v.offset,
      quote: raw.quote,
      payload: raw.payload || {},
      confidence: Number(raw.confidence) || 0,
      status: 'applied',
      reason: v.reason || undefined,
    };
    const evidence = [{ chapter: chapterId, offset: v.offset, quote: raw.quote }];
    const payload = raw.payload || {};
    let entity = null;

    if (raw.kind === 'entity') {
      const name = String(payload.name || '').trim();
      if (!name) {
        report.rejected.push({ proposal: raw, reason: 'entity 缺少 name' });
        continue;
      }
      const existing = canon.characters.find((c) => c.name === name);
      if (existing) {
        for (const alias of payload.aliases || []) {
          if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
        }
        if (!existing.evidence.some((e) => e.quote === raw.quote)) existing.evidence.push(...evidence);
        report.skipped.push({ proposal: raw, reason: `人物已存在：${existing.id}` });
        continue;
      }
      entity = {
        id: nextId('char', canon.characters),
        name,
        aliases: payload.aliases || [],
        firstChapter: chapterId,
        lastChapter: chapterId,
        mentions: 0,
        role: payload.role || null,
        summary: payload.summary || '',
        voiceSamples: [],
        status: 'pending',
        evidence,
      };
      canon.characters.push(entity);
    } else if (raw.kind === 'fact') {
      const subject = subjectId(canon, payload.subject);
      if (subject === String(payload.subject)) {
        report.unresolvedSubject.push({ proposal: raw, subject: payload.subject });
      }
      const predicate = String(payload.predicate || '').trim();
      const object = String(payload.object ?? '').trim();
      if (!predicate || !object) {
        report.rejected.push({ proposal: raw, reason: 'fact 缺少 predicate/object' });
        continue;
      }
      const same = canon.facts.find((f) => f.subject === subject && f.predicate === predicate && f.object === object);
      if (same) {
        if (!same.evidence.some((e) => e.quote === raw.quote)) same.evidence.push(...evidence);
        report.skipped.push({ proposal: raw, reason: `事实已存在：${same.id}` });
        continue;
      }
      const clash = FUNCTIONAL_PREDICATES.has(predicate)
        ? canon.facts.find((f) => f.subject === subject && f.predicate === predicate && f.object !== object)
        : null;
      entity = {
        id: nextId('fact', canon.facts),
        subject,
        subjectName: payload.subject,
        predicate,
        object,
        chapter: chapterId,
        offset: v.offset,
        quote: raw.quote,
        confidence: base.confidence,
        status: 'pending',
        conflictsWith: [],
        evidence,
      };
      if (clash) {
        const fc = {
          id: nextId('fc', canon.contradictions),
          subject,
          predicate,
          factIds: [clash.id, entity.id],
          chapters: [clash.chapter, chapterId],
          values: [clash.object, entity.object],
          description: `${payload.subject} 的 ${predicate} 在 ${clash.chapter}/${chapterId} 不一致`,
          status: 'open',
          resolution: null,
          evidence: [...clash.evidence, ...evidence],
        };
        canon.contradictions.push(fc);
        entity.conflictsWith.push(fc.id);
        const old = canon.facts.find((f) => f.id === clash.id);
        old.conflictsWith = [...new Set([...(old.conflictsWith || []), fc.id])];
        entity.conflictId = fc.id;
      }
      canon.facts.push(entity);
    } else if (raw.kind === 'secret') {
      const what = String(payload.what || '').trim();
      if (!what) {
        report.rejected.push({ proposal: raw, reason: 'secret 缺少 what' });
        continue;
      }
      const norm = (s) => String(s).replace(/\s/g, '');
      const same = canon.secrets.find((s) => norm(s.what) === norm(what));
      if (same) {
        report.skipped.push({ proposal: raw, reason: `秘密已存在：${same.id}` });
        continue;
      }
      entity = {
        id: nextId('secret', canon.secrets),
        what,
        publicAtChapter: payload.publicAtChapter || null,
        knownBy: (payload.knownBy || []).map((k) => ({
          who: subjectId(canon, k.who), fromChapter: k.fromChapter,
        })),
        evidence,
        status: 'pending',
      };
      canon.secrets.push(entity);
    } else if (raw.kind === 'world_rule') {
      const text = String(payload.text || '').trim();
      if (!text) {
        report.rejected.push({ proposal: raw, reason: 'world_rule 缺少 text' });
        continue;
      }
      const same = canon.worldRules.find((r) => r.text === text);
      if (same) {
        report.skipped.push({ proposal: raw, reason: `规则已存在：${same.id}` });
        continue;
      }
      entity = { id: nextId('rule', canon.worldRules), text, evidence, status: 'pending' };
      canon.worldRules.push(entity);
    } else if (raw.kind === 'address') {
      const from = subjectId(canon, payload.from);
      const to = subjectId(canon, payload.to);
      const form = String(payload.form || payload.publicForm || '').trim();
      if (!from || !to || !form) {
        report.rejected.push({ proposal: raw, reason: 'address 缺少 from/to/form' });
        continue;
      }
      if (NOT_ADDRESS.test(form)) {
        report.rejected.push({ proposal: raw, reason: `不是称呼：${form}` });
        continue;
      }
      if (from === to) {
        report.rejected.push({ proposal: raw, reason: 'address 的 from/to 相同' });
        continue;
      }
      const same = canon.addresses.find((a) => a.from === from && a.to === to && a.form === form);
      if (same) {
        report.skipped.push({ proposal: raw, reason: `称呼已存在：${same.id}` });
        continue;
      }
      entity = {
        id: nextId('addr', canon.addresses),
        from, to, form,
        publicForm: payload.publicForm || form,
        privateForm: payload.privateForm || null,
        fromChapter: payload.fromChapter || chapterId,
        // 提取器常把「为什么算忌讳」写进括号里；这里只留称呼本身，检查器才好逐字比对。
        taboo: (payload.taboo || [])
          .map((s) => String(s).split(/[（(]/)[0].trim())
          .filter(Boolean),
        evidence,
        status: 'pending',
      };
      canon.addresses.push(entity);
    } else {
      // knowledge / timeline / voice：v0.1 先入队，人工确认后再接线。
      entity = { id: nextId('prop', canon.proposals), kind: raw.kind, ...payload, evidence, status: 'pending' };
    }

    base.entityId = entity ? entity.id : null;
    base.entityKind = raw.kind;
    canon.proposals.push(base);
    if (entity) report.applied.push({ proposal: raw, entity });
  }
  return report;
}

export function findEntity(canon, id) {
  for (const bucket of ['characters', 'facts', 'worldRules', 'secrets', 'addresses', 'contradictions']) {
    const hit = canon[bucket].find((x) => x.id === id);
    if (hit) return { bucket, entity: hit };
  }
  return null;
}

export function confirmEntries(canon, ids) {
  const done = [];
  for (const id of ids) {
    const hit = findEntity(canon, id);
    if (!hit) continue;
    hit.entity.status = 'confirmed';
    const prop = canon.proposals.find((p) => p.entityId === id);
    if (prop) prop.status = 'confirmed';
    done.push(id);
  }
  return done;
}

export function rejectEntries(canon, ids) {
  const done = [];
  for (const id of ids) {
    const hit = findEntity(canon, id);
    if (!hit) continue;
    hit.entity.status = 'rejected';
    const prop = canon.proposals.find((p) => p.entityId === id);
    if (prop) prop.status = 'rejected';
    done.push(id);
  }
  return done;
}

// 裁决：later（后章为准）/ earlier（前章为准）/ both（都保留）/ reject_new（拒绝新条目）。
export function resolveContradiction(canon, id, choice) {
  const fc = canon.contradictions.find((c) => c.id === id);
  if (!fc) throw new Error(`没有这条设定矛盾：${id}`);
  if (!['later', 'earlier', 'both', 'reject_new'].includes(choice)) {
    throw new Error(`未知裁决：${choice}（later/earlier/both/reject_new）`);
  }
  const [firstId, secondId] = fc.factIds;
  const first = canon.facts.find((f) => f.id === firstId);
  const second = canon.facts.find((f) => f.id === secondId);
  fc.status = 'resolved';
  fc.resolution = choice;
  if (choice === 'later') {
    if (first) first.status = 'rejected';
    if (second) second.status = 'confirmed';
  } else if (choice === 'earlier') {
    if (first) first.status = 'confirmed';
    if (second) second.status = 'rejected';
  } else if (choice === 'both') {
    if (first) first.status = 'confirmed';
    if (second) second.status = 'confirmed';
  } else if (choice === 'reject_new') {
    if (second) second.status = 'rejected';
  }
  return fc;
}

export function coverage(canon, index) {
  const confirmed = (list) => list.filter((x) => x.status === 'confirmed').length;
  const pending = (list) => list.filter((x) => x.status === 'pending').length;
  const rejected = (list) => list.filter((x) => x.status === 'rejected').length;
  const chars = index?.chars || 0;
  const factual = canon.facts.filter((f) => f.status !== 'rejected');
  const bucket = (list) => ({
    confirmed: confirmed(list), pending: pending(list), rejected: rejected(list), total: list.length,
  });
  return {
    chars,
    chapters: index?.chapterCount || 0,
    characters: bucket(canon.characters),
    facts: bucket(canon.facts),
    worldRules: bucket(canon.worldRules),
    secrets: bucket(canon.secrets),
    addresses: bucket(canon.addresses),
    contradictions: { open: canon.contradictions.filter((c) => c.status === 'open').length, total: canon.contradictions.length },
    proposals: {
      // applied 只表示「落盘后还没被人动过」；确认过的条目 status 变成 confirmed，
      // 所以对外说「采纳」时要把两者加起来，否则确认越多、采纳看起来越少。
      accepted: canon.proposals.filter((p) => p.status === 'applied' || p.status === 'confirmed').length,
      pending: canon.proposals.filter((p) => p.status === 'applied').length,
      rejected: canon.proposals.filter((p) => p.status === 'rejected').length,
      confirmed: canon.proposals.filter((p) => p.status === 'confirmed').length,
      total: canon.proposals.length,
    },
    factsPer10k: chars ? Math.round((factual.length / chars) * 10000 * 100) / 100 : 0,
  };
}
