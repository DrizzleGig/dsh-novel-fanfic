// 侧边栏视图数据：把 canon 的平铺条目推导成「原著档案」面板要用的卡片结构。
// 纯函数：不读磁盘、不改状态；输入 canon + 章节 + 正文，输出可直接 JSON 化的对象。
// 设计口径见 docs/小说插件系列-fanfic-侧边栏IA-v1.md：
//   人物卡 / 势力卡 / 称呼矩阵 + 关系边 / 世界（规则·地点·物品·术语）/ 冲突线索 / 时间线·伏笔 / 覆盖度。
// 推导出来的东西一律标 source 字段（canon = 原文直接条目，derived = 由条目归纳），
// 面板上据此显示「已确认 / 待审 / 归纳」徽标，不把推导当原著事实。

const ORG_SUFFIXES = ['队', '塔', '房', '堂', '阁', '帮', '会', '盟', '军', '寨', '宗', '门派', '派', '家', '府', '司', '局', '院', '馆', '楼', '寺', '观'];
const ORG_STOPWORDS = ['的', '了', '是', '在', '把', '被', '给', '让', '和', '与', '他', '她', '它'];

const KIND_BY_SUFFIX = {
  队: '组织', 帮: '组织', 会: '组织', 盟: '组织', 军: '组织', 门派: '门派', 派: '门派', 宗: '门派',
  家: '家族', 府: '家族', 司: '机构', 局: '机构', 院: '机构', 馆: '机构',
  塔: '地点', 房: '地点', 堂: '地点', 阁: '地点', 楼: '地点', 寺: '地点', 观: '地点', 寨: '地点',
};

const STATUS_ORDER = { confirmed: 0, pending: 1, conflict: 2, rejected: 3 };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(text, n = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 名称 + 别名在文本里出现的次数（近似「提及次数」）。 */
export function countMentions(text, forms) {
  if (!text) return 0;
  let total = 0;
  for (const form of forms) {
    if (!form) continue;
    let at = 0;
    for (;;) {
      const found = text.indexOf(form, at);
      if (found < 0) break;
      total += 1;
      at = found + form.length;
    }
  }
  return total;
}

/** 从身份描述里抽出机构/地点名：「巡雾队副队长」→「巡雾队」，「长明塔档案房的记录员」→「长明塔」。 */
export function extractOrg(text) {
  const s = String(text ?? '');
  const modifiers = ['副', '正', '总', '分', '小', '大', '老'];
  for (const suffix of ORG_SUFFIXES) {
    let at = s.indexOf(suffix);
    while (at >= 0) {
      const candidate = s.slice(0, at + suffix.length);
      const before = s.slice(Math.max(0, at - 1), at);
      const doubled = candidate.length >= 2 && candidate[candidate.length - 1] === candidate[candidate.length - 2];
      const ok = candidate.length >= 2
        && candidate.length <= 10
        && !ORG_STOPWORDS.some((word) => candidate.includes(word))
        && !modifiers.includes(before)
        && !doubled;
      if (ok) return candidate;
      at = s.indexOf(suffix, at + 1);
    }
  }
  return '';
}

function chapterOrder(chapters) {
  const map = new Map();
  chapters.forEach((ch, i) => map.set(ch.id, i));
  return map;
}

function makeEvidence(row) {
  return asArray(row?.evidence).map((ev) => ({
    chapter: ev.chapter || null,
    offset: Number.isFinite(ev.offset) ? ev.offset : null,
    quote: clamp(ev.quote || '', 160),
  })).filter((ev) => ev.chapter || ev.quote);
}

/** 人物卡：姓名、别名、角色、一句话、出场区间、提及次数、证据条数、状态。 */
export function characterCards(canon, chapters, texts = {}) {
  const order = chapterOrder(chapters);
  const chars = asArray(canon?.characters).filter((c) => c.status !== 'rejected');
  const allText = Object.values(texts).join('\n');
  return chars.map((c) => {
    const forms = [c.name, ...asArray(c.aliases)].filter(Boolean);
    const seen = [];
    for (const [id, body] of Object.entries(texts)) {
      if (forms.some((form) => form && body.includes(form))) seen.push(id);
    }
    seen.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
    const evidence = makeEvidence(c);
    return {
      id: c.id,
      name: c.name,
      aliases: asArray(c.aliases),
      role: c.role || '角色',
      summary: clamp(c.summary || '', 120),
      status: c.status || 'pending',
      source: 'canon',
      firstChapter: seen[0] || c.firstChapter || evidence[0]?.chapter || null,
      lastChapter: seen[seen.length - 1] || c.lastChapter || evidence[evidence.length - 1]?.chapter || null,
      chapters: seen,
      mentions: countMentions(allText, forms),
      evidence,
      evidenceCount: evidence.length,
      voiceSamples: asArray(c.voiceSamples).map((v) => clamp(v, 120)).slice(0, 3),
    };
  }).sort((a, b) => b.mentions - a.mentions || (order.get(a.firstChapter) ?? 99) - (order.get(b.firstChapter) ?? 99));
}

/** 势力卡：v0.1 不提取势力实体，先从「身份」事实里归纳组织/地点，成员与证据都可追溯。 */
export function factionCards(canon, characters) {
  const facts = asArray(canon?.facts);
  const byName = new Map();
  for (const fact of facts) {
    if (fact.predicate !== 'role') continue;
    const org = extractOrg(fact.object);
    if (!org) continue;
    const row = byName.get(org) || {
      id: `org:${org}`,
      name: org,
      kind: KIND_BY_SUFFIX[org.slice(-1)] || KIND_BY_SUFFIX[org.slice(-2)] || '组织',
      source: 'derived',
      status: fact.status === 'confirmed' ? 'confirmed' : 'pending',
      members: [],
      evidence: [],
      firstChapter: fact.chapter || fact.evidence?.[0]?.chapter || null,
    };
    if (fact.status === 'confirmed') row.status = 'confirmed';
    const member = characters.find((c) => c.name === (fact.subjectName || fact.subject));
    if (member && !row.members.some((m) => m.id === member.id)) {
      row.members.push({ id: member.id, name: member.name, role: fact.object, status: fact.status });
    }
    const ev = makeEvidence(fact);
    if (ev[0] && !row.evidence.some((x) => x.chapter === ev[0].chapter && x.quote === ev[0].quote)) row.evidence.push(ev[0]);
    byName.set(org, row);
  }
  return [...byName.values()].sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
}

/** 称呼矩阵：行=称呼者，列=被称呼者，格子里是公开/私下/改口章。 */
export function addressMatrix(canon, characters) {
  const nameOf = (id) => characters.find((c) => c.id === id)?.name || id;
  const edges = asArray(canon?.addresses).filter((a) => a.status !== 'rejected').map((a) => ({
    id: a.id,
    from: a.from,
    fromName: nameOf(a.from),
    to: a.to,
    toName: nameOf(a.to),
    publicForm: a.publicForm || a.form || '',
    privateForm: a.privateForm || '',
    form: a.form || '',
    fromChapter: a.fromChapter || a.chapter || null,
    taboo: asArray(a.taboo),
    status: a.status || 'pending',
    evidence: makeEvidence(a),
  }));
  return {
    people: characters.map((c) => ({ id: c.id, name: c.name, role: c.role })),
    edges,
  };
}

/** 关系边：从「关系」事实来（血缘/旧识/亲近），与称呼矩阵互补。 */
export function relationEdges(canon) {
  return asArray(canon?.facts)
    .filter((f) => f.predicate === 'relationship' && f.status !== 'rejected')
    .map((f) => ({
      id: f.id,
      from: f.subjectName || f.subject,
      text: clamp(f.object, 120),
      chapter: f.chapter || f.evidence?.[0]?.chapter || null,
      status: f.status,
      evidence: makeEvidence(f),
    }));
}

/** 「铜哨，母亲遗物…」→「铜哨」：卡面标题只取第一个短语。 */
export function shortName(text, n = 24) {
  const s = String(text ?? '').trim();
  const cut = s.split(/[，,；;（(、]/)[0].trim();
  return clamp(cut || s, n);
}

/** 世界：规则 / 地点 / 物品 / 术语（术语由人物、势力、地点、物品名归纳）。 */
export function worldView(canon, characters, factions) {
  const facts = asArray(canon?.facts).filter((f) => f.status !== 'rejected');
  const rules = asArray(canon?.worldRules).filter((r) => r.status !== 'rejected').map((r) => ({
    id: r.id,
    name: clamp(r.text, 26),
    text: r.text,
    status: r.status || 'pending',
    evidence: makeEvidence(r),
  }));
  const locations = facts.filter((f) => f.predicate === 'residence').map((f) => ({
    id: f.id,
    name: shortName(f.object, 24),
    owner: f.subjectName || f.subject,
    chapter: f.chapter || f.evidence?.[0]?.chapter || null,
    status: f.status,
    evidence: makeEvidence(f),
  }));
  const items = facts.filter((f) => f.predicate === 'possession').map((f) => ({
    id: f.id,
    name: shortName(f.object, 24),
    holder: f.subjectName || f.subject,
    chapter: f.chapter || f.evidence?.[0]?.chapter || null,
    status: f.status,
    evidence: makeEvidence(f),
  }));
  const terms = [];
  const pushTerm = (name, kind, note) => {
    const clean = String(name || '').trim();
    if (!clean || terms.some((t) => t.name === clean)) return;
    terms.push({ id: `term:${clean}`, name: clean, kind, note: clamp(note || '', 60) });
  };
  for (const c of characters) pushTerm(c.name, '人物', c.summary);
  for (const f of factions) pushTerm(f.name, f.kind, `${f.members.length} 名成员`);
  for (const l of locations) pushTerm(l.name, '地点', l.owner ? `与 ${l.owner} 相关` : '');
  for (const i of items) pushTerm(i.name, '物品', i.holder ? `持有者 ${i.holder}` : '');
  return { rules, locations, items, terms };
}

/** 冲突线索：从未被拒绝的秘密归纳「谁知道 / 谁还不知道 / 赌注在哪一章公开」。 */
export function conflictCards(canon, characters) {
  const nameOf = (id) => characters.find((c) => c.id === id)?.name || id;
  return asArray(canon?.secrets)
    .filter((s) => s.status !== 'rejected')
    .map((s) => {
      const known = asArray(s.knownBy).map((k) => ({ id: k.who, name: nameOf(k.who), fromChapter: k.fromChapter || null }));
      const knownIds = new Set(known.map((k) => k.id));
      const unknown = characters.filter((c) => !knownIds.has(c.id)).map((c) => c.name);
      return {
        id: s.id,
        title: clamp(s.what, 34),
        stakes: s.what,
        status: s.status || 'pending',
        publicAtChapter: s.publicAtChapter || null,
        known,
        unknown,
        chapters: [known[0]?.fromChapter, s.publicAtChapter].filter(Boolean),
        evidence: makeEvidence(s),
      };
    });
}

/** 剧情：每章一条时间线卡（本章事实、出场人物、关键引文）。 */
export function timelineView(canon, chapters, characters) {
  const facts = asArray(canon?.facts).filter((f) => f.status !== 'rejected');
  return chapters.map((ch) => {
    const rows = facts.filter((f) => (f.chapter || f.evidence?.[0]?.chapter) === ch.id);
    const present = [];
    for (const c of characters) {
      const hit = c.chapters?.includes(ch.id);
      if (hit) present.push(c.name);
    }
    return {
      id: ch.id,
      ordinal: ch.ordinal ?? null,
      title: ch.title || '',
      chars: ch.chars || 0,
      factCount: rows.length,
      present,
      facts: rows.map((f) => ({
        id: f.id,
        subject: f.subjectName || f.subject,
        predicate: f.predicate,
        object: clamp(f.object, 60),
        status: f.status,
      })),
      quote: rows.flatMap((f) => makeEvidence(f))[0] || null,
    };
  });
}

/** 伏笔：secret 的埋设章 / 公开章 / 是否已回收。 */
export function threadView(canon, chapters) {
  const last = chapters[chapters.length - 1]?.id || null;
  const order = chapterOrder(chapters);
  return asArray(canon?.secrets)
    .filter((s) => s.status !== 'rejected')
    .map((s) => {
      const setup = makeEvidence(s)[0]?.chapter || null;
      const payoff = s.publicAtChapter || null;
      const revealed = Boolean(payoff) && (order.get(payoff) ?? 99) <= (order.get(last) ?? 99);
      return {
        id: s.id,
        title: clamp(s.what, 40),
        setup,
        payoff,
        revealed,
        status: s.status || 'pending',
        evidence: makeEvidence(s),
      };
    })
    .sort((a, b) => Number(a.revealed) - Number(b.revealed));
}

/** 覆盖度与关键数字。 */
export function coverageView(canon, characters, factions, conflicts) {
  const count = (rows) => ({
    confirmed: asArray(rows).filter((r) => r.status === 'confirmed').length,
    total: asArray(rows).filter((r) => r.status !== 'rejected').length,
  });
  return {
    characters: count(canon?.characters),
    facts: count(canon?.facts),
    worldRules: count(canon?.worldRules),
    secrets: count(canon?.secrets),
    addresses: count(canon?.addresses),
    contradictions: {
      open: asArray(canon?.contradictions).filter((c) => c.status !== 'resolved').length,
      total: asArray(canon?.contradictions).length,
    },
    factions: { confirmed: factions.filter((f) => f.status === 'confirmed').length, total: factions.length },
    conflicts: { confirmed: conflicts.filter((c) => c.status === 'confirmed').length, total: conflicts.length },
  };
}

/** 分析进度：只按「数据有没有」判，不假装有后台任务。 */
export function analysisStages(chapters, characters, factions, world, timeline, coverage) {
  return [
    { key: 'chapters', label: '分章', done: chapters.length > 0, detail: `${chapters.length} 章` },
    { key: 'characters', label: '人物', done: characters.length > 0, detail: `${coverage.characters.confirmed}/${coverage.characters.total} 已确认` },
    { key: 'factions', label: '势力', done: factions.length > 0, detail: `${factions.length} 张（归纳）` },
    { key: 'world', label: '世界', done: world.rules.length > 0, detail: `${world.rules.length} 条规则` },
    { key: 'facts', label: '事实', done: timeline.some((t) => t.factCount > 0), detail: `${coverage.facts.confirmed}/${coverage.facts.total} 已确认` },
    { key: 'relations', label: '称呼', done: coverage.addresses.total > 0, detail: `${coverage.addresses.confirmed}/${coverage.addresses.total} 已确认` },
  ];
}

/**
 * 一次组装面板需要的全部数据。
 * @param {{canon:object, project?:object, chapters?:Array, texts?:Record<string,string>}} input
 */
export function buildBook(input = {}) {
  const canon = input.canon || {};
  const chapters = asArray(input.chapters);
  const texts = input.texts || {};
  const full = input.full === true;
  const characters = characterCards(canon, chapters, texts);
  const factions = factionCards(canon, characters);
  const matrix = addressMatrix(canon, characters);
  const relations = relationEdges(canon);
  const world = worldView(canon, characters, factions);
  const conflicts = conflictCards(canon, characters);
  const timelineFull = timelineView(canon, chapters, characters);
  // 侧栏是窄栏：人物/势力/术语/每章事实都要带上限，避免一本大书把面板载荷撑爆。
  const timeline = full ? timelineFull : timelineFull.map((t) => ({ ...t, facts: t.facts.slice(0, 12) }));
  const threads = threadView(canon, chapters);
  const coverage = coverageView(canon, characters, factions, conflicts);
  const totalChars = chapters.reduce((n, ch) => n + (ch.chars || 0), 0);
  return {
    title: input.project?.title || null,
    sourceId: input.project?.sourceId || null,
    currentChapter: input.project?.currentChapter || null,
    chapters,
    stats: {
      chapters: chapters.length,
      chars: totalChars,
      characters: characters.length,
      factions: factions.length,
      conflicts: conflicts.length,
      threads: threads.length,
      openThreads: threads.filter((t) => !t.revealed).length,
      rules: world.rules.length,
      facts: coverage.facts.total,
    },
    characters: full ? characters : characters.slice(0, 60),
    factions: full ? factions : factions.slice(0, 24),
    matrix,
    relations,
    world: { ...world, terms: full ? world.terms : world.terms.slice(0, 80) },
    conflicts,
    timeline,
    threads,
    coverage,
    analysis: analysisStages(chapters, characters, factions, world, timeline, coverage),
  };
}

export { STATUS_ORDER, clamp as clampText };
