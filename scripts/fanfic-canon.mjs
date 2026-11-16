#!/usr/bin/env node
// canon 内核 CLI（开发方案第 2 步）：导入 → 分章 → 确定性索引 → LLM 提案 → 审阅 → 冲突裁决。
//
//   node scripts/fanfic-canon.mjs import --file <原著.txt> [--project fanfic-a]
//   node scripts/fanfic-canon.mjs index
//   node scripts/fanfic-canon.mjs prompt [--chapter ch001|all] [--out runs/canon-prompts]
//   node scripts/fanfic-canon.mjs propose --file proposals.json [--dry]
//   node scripts/fanfic-canon.mjs review [--status pending] [--kind fact]
//   node scripts/fanfic-canon.mjs confirm --ids char_001,fact_002
//   node scripts/fanfic-canon.mjs reject --ids prop_003
//   node scripts/fanfic-canon.mjs resolve --id fc_001 --choice later
//   node scripts/fanfic-canon.mjs stats
//   node scripts/fanfic-canon.mjs verify
//   node scripts/fanfic-canon.mjs dump

import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  loadProject, saveCanon, audit, paths, writeJsonAtomic,
} from '../lib/canon-store.mjs';
import { verifyCanon } from '../lib/canon-verify.mjs';
import { ingestFile } from '../lib/ingest.mjs';
import { analyzeChapters } from '../lib/indexer.mjs';
import {
  applyProposals, confirmEntries, rejectEntries, resolveContradiction, coverage,
} from '../lib/proposals.mjs';

/** 默认工作目录：向上找含 `.dsh-novel-fanfic/` 的目录；没有就用包目录的上一级（本仓库根）。 */
function defaultRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.dsh-novel-fanfic'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const ROOT = process.env.DSH_NOVEL_FANFIC_ROOT || defaultRoot();
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    file: { type: 'string' },
    project: { type: 'string' },
    root: { type: 'string' },
    title: { type: 'string' },
    chapter: { type: 'string' },
    out: { type: 'string' },
    ids: { type: 'string' },
    id: { type: 'string' },
    choice: { type: 'string' },
    status: { type: 'string' },
    kind: { type: 'string' },
    dry: { type: 'boolean' },
    json: { type: 'boolean' },
    verbose: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
const cmd = positionals[0] || 'help';
const root = path.resolve(ROOT, values.root || '.');
const project = values.project || 'default';
const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`错误：${msg}`); process.exitCode = 1; };

async function chapterTexts(ctx) {
  const map = new Map();
  if (!ctx.project.sourceId) return map;
  for (const ch of ctx.index?.chapters || []) {
    map.set(ch.id, await readFile(ctx.paths.source(ctx.project.sourceId).chapter(ch.id), 'utf8'));
  }
  return map;
}

async function loadCtx() {
  const ctx = await loadProject(root, project);
  return ctx;
}

// ---------------------------------------------------------------- import
async function cmdImport() {
  if (!values.file) return fail('import 需要 --file <文本路径>');
  const file = path.resolve(ROOT, values.file);
  const r = await ingestFile({ root, project, file, title: values.title });
  if (r.duplicate) {
    log(`已存在同一文件（sha256 ${r.sourceId}），跳过导入。`);
    return;
  }
  log(`导入完成：${path.relative(ROOT, file)} → ${path.join('.dsh-novel-fanfic', project)}`);
  log(`编码 ${r.encoding}　字数 ${r.meta.chars}　章节 ${r.meta.chapterCount}　sourceId ${r.sourceId}`);
  log('');
  log('章节：');
  for (const ch of r.index.chapters.slice(0, 30)) {
    log(`  ${ch.id}  ${String(ch.chars).padStart(5)} 字  ${ch.title}`);
  }
  if (r.index.chapters.length > 30) log(`  …共 ${r.index.chapters.length} 章`);
  log('');
  log('下一步：node scripts/fanfic-canon.mjs index');
}

// ---------------------------------------------------------------- index
async function cmdIndex() {
  const ctx = await loadCtx();
  if (!ctx.project.sourceId) return fail('还没有导入原著，先跑 import');
  const texts = await chapterTexts(ctx);
  const chapters = (ctx.index.chapters || []).map((c) => ({ ...c, body: texts.get(c.id) || '' }));
  const analysis = analyzeChapters(chapters);
  const outFile = path.join(ctx.paths.source(ctx.project.sourceId).dir, 'index-candidates.json');
  await writeJsonAtomic(outFile, analysis);
  log(`确定性索引：${analysis.characters.length} 个人物候选，${analysis.aliases.length} 条别名候选，${analysis.vocatives.length} 组称呼候选`);
  log('');
  log('人物候选（对话提示词 + 职称统计）：');
  for (const c of analysis.characters) {
    log(`  ${c.name.padEnd(4)} 出现 ${String(c.mentions).padStart(3)} 次  ${c.chapters.join('/')}  方式 ${c.ways.join(',')}`);
  }
  if (analysis.vocatives.length) {
    log('');
    log('称呼候选（引号内纯称呼 + 就近说话人）：');
    for (const v of analysis.vocatives.slice(0, 8)) log(`  ${v.from}→${v.to}「${v.form}」 ${v.chapter}`);
  }
  log('');
  log(`候选已写：${path.relative(ROOT, outFile)}`);
  log('下一步：node scripts/fanfic-canon.mjs prompt --out runs/canon-prompts');
}

// ---------------------------------------------------------------- prompt
function extractionPrompt(chapter, meta) {
  return `你是原著分析助手。下面是一部长篇小说的其中一章，请只根据这一章的原文，输出 **一个 JSON 数组**，不要任何解释、不要 Markdown 代码围栏。

要求：
1. 每条提案必须有 \`kind\`、\`chapter\`、\`offset\`、\`quote\`、\`payload\`、\`confidence\` 六个字段。
2. \`quote\` 必须是本章原文的**逐字片段**（≤60 字），不得改写、不得拼接；\`offset\` 是 quote 在本章正文中的字符下标（从 0 开始）。
3. \`kind\` 只能用：entity、fact、world_rule、secret、address。
4. 只写原文能支持的条目；不确定就不写，宁可少不要编。不要写动机分析、人物弧光、主题解读。
5. 数量建议：entity 覆盖本章出现的 2–4 个主要人物；fact 5–10 条（身份/年龄/关系/伤病/外貌/物品/住址）；world_rule 0–2 条；secret 0–1 条；address 0–3 条。

payload 形状：
- entity: {"name":"人物名","aliases":["别名"],"role":"主角/配角等","summary":"一句话"}
- fact: {"subject":"人物名","predicate":"age|eye_color|scar_side|role|relationship|injury|possession|residence","object":"取值"}
- world_rule: {"text":"规则原文概述"}
- secret: {"what":"秘密内容","publicAtChapter":"chNNN","knownBy":[{"who":"人物名","fromChapter":"chNNN"}]}
- address: {"from":"称呼者","to":"被称呼者","form":"本章用的称呼","publicForm":"公开称呼","privateForm":"私下称呼","fromChapter":"chNNN","taboo":["忌讳"]}

章节：${chapter.id}（${chapter.title}，${chapter.chars} 字）

===== 正文开始 =====
${meta.body}
===== 正文结束 =====`;
}

async function cmdPrompt() {
  const ctx = await loadCtx();
  if (!ctx.project.sourceId) return fail('还没有导入原著，先跑 import');
  const texts = await chapterTexts(ctx);
  const wanted = values.chapter && values.chapter !== 'all'
    ? (ctx.index.chapters || []).filter((c) => c.id === values.chapter)
    : (ctx.index.chapters || []);
  if (!wanted.length) return fail(`找不到章节：${values.chapter}`);
  const outDir = path.resolve(ROOT, values.out || 'runs/canon-prompts');
  await mkdir(outDir, { recursive: true });
  const manifest = [];
  for (const ch of wanted) {
    const body = texts.get(ch.id) || '';
    const file = path.join(outDir, `${ch.id}.md`);
    await writeFile(file, extractionPrompt(ch, { ...ch, body }), 'utf8');
    manifest.push({ chapter: ch.id, chars: ch.chars, file: path.relative(ROOT, file) });
  }
  await writeJsonAtomic(path.join(outDir, 'manifest.json'), { project, chapters: manifest });
  log(`已写 ${manifest.length} 份抽取提示 → ${path.relative(ROOT, outDir)}`);
  log('下一步：让模型/子代理读每份提示，把返回的 JSON 数组存成 proposals-<chapter>.json，再运行 propose --file');
}

// ---------------------------------------------------------------- propose
async function cmdPropose() {
  if (!values.file) return fail('propose 需要 --file <proposals.json>');
  const ctx = await loadCtx();
  const texts = await chapterTexts(ctx);
  const rawText = await readFile(path.resolve(ROOT, values.file), 'utf8');
  const jsonText = rawText.replace(/^\uFEFF/, '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    return fail(`提案文件不是合法 JSON：${err.message}`);
  }
  const list = Array.isArray(raw) ? raw : raw.proposals || [];
  const report = applyProposals(ctx.canon, list, texts);
  if (!values.dry) {
    await saveCanon(root, project, ctx.canon);
    for (const a of report.applied) {
      await audit(root, project, { action: 'proposal.apply', kind: a.proposal.kind, entityId: a.entity?.id, chapter: a.proposal.chapter });
    }
    for (const r of report.rejected) {
      await audit(root, project, { action: 'proposal.reject', reason: r.reason, chapter: r.proposal?.chapter });
    }
  }
  log(`提案 ${list.length} 条：采纳 ${report.applied.length}、跳过 ${report.skipped.length}、拒收 ${report.rejected.length}${values.dry ? '（dry run，未写盘）' : ''}`);
  for (const a of report.applied) {
    const e = a.entity || {};
    log(`  ✓ ${e.id || '?'}  ${a.proposal.kind}  「${a.proposal.quote.slice(0, 26)}…」`);
  }
  for (const s of report.skipped) log(`  · 跳过：${s.reason}`);
  for (const r of report.rejected) log(`  ✗ 拒收：${r.reason}`);
  if (report.unresolvedSubject.length) {
    log('');
    log(`注意：${report.unresolvedSubject.length} 条事实的 subject 还不是已登记人物（会先按名字存，确认人物后可回填）：`);
    for (const u of report.unresolvedSubject.slice(0, 5)) log(`  · ${u.subject}（${u.proposal.payload.predicate}）`);
  }
  log('');
  log('下一步：node scripts/fanfic-canon.mjs review');
}

// ---------------------------------------------------------------- review
async function cmdReview() {
  const ctx = await loadCtx();
  const status = values.status || 'pending';
  const show = (bucket, label) => {
    const rows = ctx.canon[bucket].filter((x) => (status === 'all' ? true : x.status === status));
    if (!rows.length) return;
    log(`\n${label}（${rows.length}）：`);
    for (const x of rows) {
      const ev = x.evidence?.[0] || x;
      const head = bucket === 'facts' ? `${x.subjectName || x.subject} ${x.predicate}=${x.object}`
        : bucket === 'characters' ? `${x.name}${x.aliases?.length ? `（${x.aliases.join('/')}）` : ''}`
          : bucket === 'secrets' ? x.what
            : bucket === 'worldRules' ? x.text
              : bucket === 'addresses' ? `${x.from}→${x.to}「${x.form}」`
                : `${x.description || x.id}`;
      log(`  ${x.id.padEnd(10)} ${x.status.padEnd(9)} ${head}`);
      if (values.verbose && ev?.quote) log(`              「${ev.quote}」 ${ev.chapter || ''}`);
    }
  };
  if (values.kind) {
    const map = { fact: 'facts', character: 'characters', secret: 'secrets', world_rule: 'worldRules', address: 'addresses', contradiction: 'contradictions' };
    show(map[values.kind] || values.kind, values.kind);
  } else {
    show('characters', '人物');
    show('facts', '事实');
    show('worldRules', '世界规则');
    show('secrets', '秘密');
    show('addresses', '称呼');
    show('contradictions', '设定矛盾');
  }
  const pendingProps = ctx.canon.proposals.filter((p) => p.status === 'applied');
  if (status !== 'all' && pendingProps.length) {
    log(`\n待确认提案队列：${pendingProps.length} 条（用 review --verbose 查看引文）`);
  }
  log('');
  log('确认：confirm --ids <id,...>　拒绝：reject --ids <id,...>');
}

// ---------------------------------------------------------------- confirm/reject/resolve
function parseIds(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

async function cmdConfirm() {
  const ids = parseIds(values.ids);
  if (!ids.length) return fail('confirm 需要 --ids a,b');
  const ctx = await loadCtx();
  const done = confirmEntries(ctx.canon, ids);
  await saveCanon(root, project, ctx.canon);
  for (const id of done) await audit(root, project, { action: 'entity.confirm', entityId: id });
  log(`已确认 ${done.length} 条：${done.join(', ') || '（没有匹配的 id）'}`);
}

async function cmdReject() {
  const ids = parseIds(values.ids);
  if (!ids.length) return fail('reject 需要 --ids a,b');
  const ctx = await loadCtx();
  const done = rejectEntries(ctx.canon, ids);
  await saveCanon(root, project, ctx.canon);
  for (const id of done) await audit(root, project, { action: 'entity.reject', entityId: id });
  log(`已拒绝 ${done.length} 条：${done.join(', ') || '（没有匹配的 id）'}`);
}

async function cmdResolve() {
  if (!values.id || !values.choice) return fail('resolve 需要 --id fc_001 --choice later|earlier|both|reject_new');
  const ctx = await loadCtx();
  const fc = resolveContradiction(ctx.canon, values.id, values.choice);
  await saveCanon(root, project, ctx.canon);
  await audit(root, project, { action: 'contradiction.resolve', id: fc.id, choice: values.choice });
  log(`已裁决 ${fc.id} → ${values.choice}（两条事实都保留，被覆盖的标 rejected）`);
}

// ---------------------------------------------------------------- stats/verify/dump
async function cmdStats() {
  const ctx = await loadCtx();
  const cov = coverage(ctx.canon, ctx.index);
  if (values.json) return log(JSON.stringify(cov, null, 2));
  log(`项目 ${project}　原著 ${cov.chapters} 章 / ${cov.chars} 字`);
  const line = (label, b) => log(`  ${label.padEnd(6)} 已确认 ${b.confirmed}　待确认 ${b.pending}　已拒绝 ${b.rejected}　共 ${b.total}`);
  line('人物', cov.characters);
  line('事实', cov.facts);
  line('世界规则', cov.worldRules);
  line('秘密', cov.secrets);
  line('称呼', cov.addresses);
  log(`  设定矛盾：未裁决 ${cov.contradictions.open} / 共 ${cov.contradictions.total}`);
  log(`  提案：采纳 ${cov.proposals.accepted}（其中已确认 ${cov.proposals.confirmed}、待动 ${cov.proposals.pending}）　拒收 ${cov.proposals.rejected}　共 ${cov.proposals.total}`);
  log(`  事实密度：${cov.factsPer10k} 条/万字（目标 ≥10，不是硬门槛）`);
}

async function cmdVerify() {
  const ctx = await loadCtx();
  const texts = await chapterTexts(ctx);
  const { ok, errors, warnings } = verifyCanon(ctx.canon, texts);
  log(`校验项目 ${project}：${ctx.index?.chapters?.length || 0} 章`);
  if (errors.length) {
    log(`\n错误 ${errors.length}：`);
    for (const e of errors) log(`  ✗ ${e}`);
  }
  if (warnings.length) {
    log(`\n警告 ${warnings.length}：`);
    for (const w of warnings) log(`  ! ${w}`);
  }
  log('');
  log(ok ? '结论：canon 自洽，所有引文可命中 ✓' : `结论：${errors.length} 个错误 ✗`);
  if (!ok) process.exitCode = 1;
}

async function cmdDump() {
  const ctx = await loadCtx();
  log(JSON.stringify({ project: ctx.project, canon: ctx.canon }, null, 2));
}

// ---------------------------------------------------------------- help/dispatch
const help = `dsh-novel-fanfic canon 内核 CLI（v0.1.0）

用法：node scripts/fanfic-canon.mjs <命令> [选项]

  import     导入原著文本（--file；去重；分章）
  index      确定性索引（人物/别名/称呼候选、章节统计）
  prompt     生成逐章抽取提示（--chapter ch001|all --out 目录）
  propose    应用模型返回的 JSON 提案（--file；--dry 只看不写）
  review     审阅队列（--status pending|confirmed|rejected|all --kind fact）
  confirm    确认条目（--ids char_001,fact_002）
  reject     拒绝条目（--ids）
  resolve    裁决设定矛盾（--id fc_001 --choice later|earlier|both|reject_new）
  stats      覆盖度
  verify     引文可命中、状态合法、矛盾指向有效
  dump       输出完整 canon JSON

选项：
  --project <名>   项目名（默认 default）
  --root <目录>    数据根（默认当前目录，数据落在 .dsh-novel-fanfic/）
  --json           stats 输出 JSON
  --verbose        review 显示引文
`;

const commands = {
  import: cmdImport,
  index: cmdIndex,
  prompt: cmdPrompt,
  propose: cmdPropose,
  review: cmdReview,
  confirm: cmdConfirm,
  reject: cmdReject,
  resolve: cmdResolve,
  stats: cmdStats,
  verify: cmdVerify,
  dump: cmdDump,
};

try {
  if (values.help || cmd === 'help' || !commands[cmd]) {
    log(help);
    if (cmd !== 'help' && !values.help && !commands[cmd]) process.exitCode = 1;
  } else {
    await commands[cmd]();
  }
} catch (err) {
  fail(err.stack || err.message);
}
