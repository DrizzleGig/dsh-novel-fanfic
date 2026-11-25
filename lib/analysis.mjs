// 导入分析：从已确认 canon 生成可回查的 Markdown 报告。纯函数，不写盘、不改 canon。
// 结论只来自已确认条目；推断/读者假设单独标注，不写成事实。

function lines(list) {
  return list.filter(Boolean).join('\n');
}

function clamp(text, n = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 分析只看已确认条目；pending/rejected 不得进入报告。 */
export function confirmedCanon(canon = {}) {
  const keep = (rows) => (Array.isArray(rows) ? rows.filter((row) => row && row.status === 'confirmed') : []);
  return {
    ...canon,
    characters: keep(canon.characters),
    facts: keep(canon.facts),
    worldRules: keep(canon.worldRules),
    secrets: keep(canon.secrets),
    addresses: keep(canon.addresses),
    contradictions: Array.isArray(canon.contradictions)
      ? canon.contradictions.filter((row) => row && row.status !== 'resolved')
      : [],
  };
}

export function overviewReport(book, canon, deltas) {
  const stats = book?.stats || {};
  const coverage = book?.coverage || {};
  const items = deltas?.items || [];
  return lines([
    `# 导入分析 · 总览`,
    `- 作品：${book?.title || '未命名'}${book?.sourceId ? `（${book.sourceId}）` : ''}`,
    `- 章节：${stats.chapters ?? 0} / ${stats.chars ?? 0} 字`,
    `- 人物：${stats.characters ?? 0}；势力：${stats.factions ?? 0}；关系边：${(book?.matrix?.edges || []).length}`,
    `- 判定/冲突：${stats.conflicts ?? 0}；伏笔：${stats.threads ?? 0}（未回收 ${stats.openThreads ?? 0}）`,
    `- 世界规则：${stats.rules ?? 0}；事实：${stats.facts ?? 0}`,
    `- 覆盖：人物 ${coverage.characters?.confirmed ?? 0}/${coverage.characters?.total ?? 0}；事实 ${coverage.facts?.confirmed ?? 0}/${coverage.facts?.total ?? 0}；称呼 ${coverage.addresses?.confirmed ?? 0}/${coverage.addresses?.total ?? 0}`,
    `- 本作设定：${items.length} 条${deltas?.premise ? '，有前提' : ''}`,
    `- 证据口径：只统计已确认 canon；pending 不算事实。`,
  ]);
}

export function relationsReport(book) {
  const edges = book?.matrix?.edges || [];
  const rels = book?.relations || [];
  const rows = [];
  for (const edge of edges) {
    rows.push(`| ${edge.fromName || edge.from} | ${edge.toName || edge.to} | ${edge.publicForm || '-'} | ${edge.privateForm || '-'} | ${edge.fromChapter || '-'} |`);
  }
  const relLines = rels.map((rel) => `- ${rel.from || '?'} → ${rel.to || '?'}：${clamp(rel.text, 100)}（${rel.chapter || '?'}，${rel.status || 'pending'}）`);
  return lines([
    `# 关系与称呼`,
    rows.length
      ? `| 称呼者 | 被称呼者 | 公开称呼 | 私下称呼 | 起始章 |\n|---|---|---|---|---|\n${rows.join('\n')}`
      : '没有已确认的称呼记录。',
    relLines.length ? `\n## 关系事实\n${relLines.join('\n')}` : '\n没有已确认的关系事实。',
  ]);
}

export function timelineReport(book) {
  const timeline = book?.timeline || [];
  const threads = book?.threads || [];
  const events = [];
  for (const chapter of timeline) {
    if (!chapter.factCount) continue;
    const facts = (chapter.facts || []).map((fact) => `${fact.subject || '?'} ${fact.predicate || '?'} ${fact.object || '?'}`).join('；');
    events.push(`- ${chapter.id}${chapter.title ? ` ${chapter.title}` : ''}：${facts || '（无摘要）'}`);
  }
  const threadLines = threads.map((thread) => {
    const state = thread.revealed ? '已回收' : '未回收';
    return `- [${state}] ${clamp(thread.title, 80)}（埋 ${thread.setup || '?'} / 收 ${thread.payoff || '?'}）`;
  });
  return lines([
    `# 时间线与伏笔`,
    events.length ? `## 事件\n${events.join('\n')}` : '没有已确认的事件事实。',
    threadLines.length ? `\n## 伏笔\n${threadLines.join('\n')}` : '\n没有已确认的伏笔。',
    `\n> 时间线只按章序/已确认事实聚合；剪辑顺序与结构推断不写成事实。`,
  ]);
}

export function auImpactReport(book, deltas) {
  const premise = deltas?.premise ? `- 前提：${deltas.premise}` : '';
  const items = deltas?.items || [];
  const characters = book?.characters || [];
  const rows = [];
  for (const item of items) {
    const subjects = String(item.subjects || '').split(/[,，、\s]+/).filter(Boolean);
    const impacted = characters.filter((ch) => {
      const forms = [ch.name, ...(ch.aliases || [])].filter(Boolean);
      return subjects.some((subject) => forms.some((form) => form.includes(subject) || subject.includes(form)));
    }).map((ch) => ch.name);
    rows.push(`- [${item.kind || 'other'}] ${item.title || '未命名'}：${clamp(item.statement, 100)}`
      + `（涉及 ${subjects.join('、') || '-'}；命中人物 ${impacted.join('、') || '未识别'}；从 ${item.fromChapter || '-' } 起）`);
  }
  return lines([
    `# AU / 本作改动影响面`,
    premise || '没有本作前提。',
    rows.length ? `\n## 改动\n${rows.join('\n')}` : '\n没有本作改动。',
    `\n> “命中人物”只按已确认人物名/别名做确定性匹配；未列出的依赖显式标未知，不自动改 canon。`,
  ]);
}

export function readerQuestionsReport(book) {
  const threads = (book?.threads || []).filter((thread) => !thread.revealed);
  const conflicts = book?.conflicts || [];
  const questions = [];
  for (const thread of threads.slice(0, 12)) {
    questions.push(`- 这条伏笔还没回收：${clamp(thread.title, 80)}（埋 ${thread.setup || '?'}）`);
  }
  for (const conflict of conflicts.slice(0, 12)) {
    const known = (conflict.known || []).map((row) => row.name).join('、') || '无人';
    const unknown = (conflict.unknown || []).slice(0, 8).join('、') || '无';
    questions.push(`- 知情差：${clamp(conflict.title, 60)}——已知 ${known}；未知 ${unknown}`);
  }
  return lines([
    `# 读者视角假设（不是事实）`,
    questions.length ? questions.join('\n') : '当前没有可提的未回收伏笔/知情差。',
    `\n> 这些是供作者检查的读者问题假设；不是原作事实、不是读者总体结论，也不自动改正文。`,
  ]);
}

export function analyzeBook(book, canon, deltas, action) {
  if (action === 'overview') return overviewReport(book, canon, deltas);
  if (action === 'relations') return relationsReport(book);
  if (action === 'timeline') return timelineReport(book);
  if (action === 'au') return auImpactReport(book, deltas);
  if (action === 'reader') return readerQuestionsReport(book);
  throw new Error(`未知分析动作：${action}`);
}
