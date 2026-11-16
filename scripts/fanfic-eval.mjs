#!/usr/bin/env node
// dsh-novel-fanfic 评测 CLI（第 1 步：夹具、三臂、scores.csv、盲评包）。
//
//   node scripts/fanfic-eval.mjs verify      校验夹具与 ground truth
//   node scripts/fanfic-eval.mjs check       跑植入错误对照（默认）或单篇检查
//   node scripts/fanfic-eval.mjs lookup      检索问题自检（--all 跑 10 问）
//   node scripts/fanfic-eval.mjs prepare     只生成提示与清单（给外部模型/子代理写稿）
//   node scripts/fanfic-eval.mjs run         用内置 stub 或 command 适配器跑完整矩阵
//   node scripts/fanfic-eval.mjs score       给 out/drafts 里已有的稿件评分
//   node scripts/fanfic-eval.mjs blind-report 汇总盲评 CSV
//   node scripts/fanfic-eval.mjs smoke       一条命令自检（verify + check + stub 跑 45 篇）

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { loadFixture, validateFixture, contractText } from '../lib/canon.mjs';
import { compileContract, compileAll, contractDrift } from '../lib/compiler.mjs';
import { runCheck, formatFindings } from '../lib/checker.mjs';
import { retrieve, scoreLookupQuestions } from '../lib/lookup.mjs';
import { buildPrompt, ARM_LABEL } from '../eval/lib/prompts.mjs';
import { stubDraft, loadViolationDrafts, commandWriter } from '../eval/lib/writers.mjs';
import {
  buildMatrix, selectScenes, runSamples, discoverDrafts, summarize, printSummary, seedOf,
} from '../eval/lib/runner.mjs';
import { buildBlindPackage, collectBlindScores } from '../eval/lib/blind.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE = path.join(ROOT, 'fixtures', 'fixture-a');
const ARMS = ['A', 'B', 'C'];

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    fixture: { type: 'string' },
    out: { type: 'string' },
    run: { type: 'string' },
    writer: { type: 'string' },
    command: { type: 'string' },
    arms: { type: 'string' },
    reps: { type: 'string' },
    'with-control': { type: 'boolean' },
    'stub-violations': { type: 'boolean' },
    seed: { type: 'string' },
    file: { type: 'string' },
    scene: { type: 'string' },
    arm: { type: 'string' },
    planted: { type: 'boolean' },
    question: { type: 'string' },
    all: { type: 'boolean' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
    write: { type: 'boolean' },
    verbose: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
const cmd = positionals[0] || 'help';

const fixtureDir = path.resolve(ROOT, values.fixture || DEFAULT_FIXTURE);
const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`错误：${msg}`); process.exitCode = 1; };

function parseArms(s) {
  const arms = String(s || 'A,B,C').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`未知实验臂：${a}`);
  return arms;
}
function parseReps(s) {
  const n = Number(s || 3);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--reps 需要正整数，收到 ${s}`);
  return n;
}
function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function fixtures() {
  const canon = await loadFixture(fixtureDir);
  const v = await validateFixture(canon);
  return { canon, v };
}

// ---------------------------------------------------------------- verify
async function cmdVerify() {
  const { canon, v } = await fixtures();
  const s = v.stats;
  log(`夹具：${path.relative(ROOT, fixtureDir) || fixtureDir}`);
  log(`章节 ${s.chapters}　人物 ${s.characters}　事实 ${s.facts}　场景 ${s.scenes}　秘密 ${s.secrets}　称呼 ${s.addressRules}　世界规则 ${s.worldRules}　契约 ${s.contracts}　植入用例 ${s.plantedCases}　lookup 问题 ${s.lookupQuestions}`);
  log(`正文字数：${canon.source.length} 字`);
  const drift = contractDrift(canon);
  if (drift.length) {
    log('\n契约漂移（磁盘上的 contracts/ 与编译器结果不一致）：');
    for (const d of drift) log(`  ✗ ${d.chapter}（${d.scene}）${d.reason === 'missing' ? '文件缺失' : '内容不同'}`);
    log('  修法：node scripts/fanfic-eval.mjs contract --write');
  } else {
    log('契约漂移：0 份 ✓');
  }
  if (v.errors.length) {
    log('\n错误：');
    for (const e of v.errors) log(`  ✗ ${e}`);
  }
  if (v.warnings.length) {
    log('\n警告：');
    for (const w of v.warnings) log(`  ! ${w}`);
  }
  log('');
  log(v.ok ? '结论：夹具与 ground truth 一致 ✓' : `结论：${v.errors.length} 个错误 ✗`);
  if (!v.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- contract
async function cmdContract() {
  const { canon } = await fixtures();
  const scenes = values.scene
    ? canon.scenes.filter((s) => s.id === values.scene || s.chapter === values.scene)
    : canon.scenes;
  if (!scenes.length) return fail(`找不到场景：${values.scene}`);
  const contracts = scenes.map((s) => compileContract(s, canon));
  if (values.write) {
    for (const c of contracts) {
      const file = path.join(fixtureDir, c.file);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, c.markdown, 'utf8');
      log(`已写：${path.relative(ROOT, file)}（${c.chars} 字）`);
    }
    return;
  }
  if (values.json) {
    log(JSON.stringify(contracts.map(({ markdown, ...rest }) => ({ ...rest, markdown })), null, 2));
    return;
  }
  for (const c of contracts) {
    if (contracts.length > 1) log(`\n— ${c.chapter}（${c.id}）${c.chars} 字 —`);
    log(c.markdown);
  }
}

// ---------------------------------------------------------------- lookup
async function cmdLookup() {
  const { canon } = await fixtures();
  if (values.all) {
    const res = scoreLookupQuestions(canon);
    log('id    命中  覆盖   问题');
    for (const r of res.rows) {
      log(`${r.id.padEnd(4)}  ${r.hit ? '✓' : '✗'}    ${r.coverage.padEnd(7)} ${r.question}`);
      if (!r.hit && values.verbose) {
        for (const p of r.passages) log(`        → ${p.chapter} ${p.score} ${p.quote.slice(0, 60)}`);
        for (const e of r.expected) log(`        期望 ${e.chapter}：${e.quote}`);
      }
    }
    const pct = Math.round(res.hitRate * 1000) / 10;
    log('');
    log(`命中 ${res.hits}/${res.total}（${pct}%），阈值 80%：${res.hitRate >= 0.8 ? '达标 ✓' : '未达标 ✗'}`);
    if (res.hitRate < 0.8) process.exitCode = 1;
    return;
  }
  const question = values.question || '沈九还活着吗';
  const res = retrieve(canon, { question, limit: Number(values.limit || 5), window: 1 });
  log(`问题：${question}`);
  log(`覆盖：${res.coverage}　${res.note || ''}`);
  for (const p of res.passages) {
    log('');
    log(`[${p.score}] ${p.chapter}　${p.why}`);
    log(`  ${p.quote.trim()}`);
  }
}

// ---------------------------------------------------------------- check
async function checkPlanted(canon) {
  const cases = canon.manifest?.cases || [];
  if (!cases.length) return fail('manifest 里没有用例');
  const rows = [];
  for (const c of cases) {
    const raw = await readFile(path.join(fixtureDir, 'planted-errors', c.file), 'utf8');
    const scene = canon.sceneById.get(c.scene);
    const result = runCheck(raw, scene, canon, { arm: c.arm || 'A' });
    const expected = c.expect || [];
    const missing = [];
    for (const e of expected) {
      const ok = result.findings.some((f) => f.detector === e.detector
        && (!e.code || f.code === e.code)
        && (!e.severity || f.severity === e.severity));
      if (!ok) missing.push(e);
    }
    const extra = c.class === 'clean'
      ? result.findings
      : result.findings.filter((f) => f.severity === 'blocker' && !expected.some((e) => e.detector === f.detector));
    rows.push({
      case: c, result, missing, extra,
      pass: missing.length === 0 && (c.class !== 'clean' || result.findings.length === 0),
    });
  }

  log('用例            类别              结论  实际');
  for (const r of rows) {
    const codes = [...new Set(r.result.findings.map((f) => `${f.detector}/${f.code}`))].join(' ');
    log(`${String(r.case.id).padEnd(14)}  ${String(r.case.class).padEnd(16)}  ${r.pass ? '✓' : '✗'}    ${codes || '（无 finding）'}`);
    if (!r.pass && values.verbose) {
      for (const m of r.missing) log(`    缺少期望：${m.detector}/${m.code || '*'} (${m.severity || '*'})`);
      for (const f of r.extra) log(`    意外：${f.severity} ${f.detector}/${f.code} ${f.message}`);
    }
  }

  const failed = rows.filter((r) => !r.pass);
  const gateClasses = (canon.manifest.classes || []).filter((k) => k.gate).map((k) => k.key);
  const gateCases = rows.filter((r) => gateClasses.includes(r.case.class));
  const clean = rows.filter((r) => r.case.class === 'clean');
  const cleanFindings = clean.reduce((n, r) => n + r.result.findings.length, 0);
  const cleanChars = clean.reduce((n, r) => n + r.result.chars, 0);

  log('');
  log(`植入用例 ${rows.length} 个，通过 ${rows.length - failed.length} 个${failed.length ? `，失败 ${failed.length} 个（${failed.map((r) => r.case.id).join(', ')}）` : ''}`);
  log(`必检 5 类样例：${gateCases.filter((r) => r.pass).length}/${gateCases.length}`);
  log(`干净对照误报：${cleanFindings} 条 / ${cleanChars} 字（阈值 ≤1 条/3000 字）`);
  if (failed.length) process.exitCode = 1;
}

async function cmdCheck() {
  const { canon } = await fixtures();
  if (values.file) {
    const sceneId = values.scene || 'scene_1';
    const scene = canon.sceneById.get(sceneId);
    if (!scene) return fail(`未知场景：${sceneId}`);
    const raw = await readFile(path.resolve(ROOT, values.file), 'utf8');
    const result = runCheck(raw, scene, canon, { arm: values.arm || 'A' });
    log(formatFindings(result));
    if (values.json) log('\n' + JSON.stringify(result.findings, null, 2));
    if (result.summary.gateBlockers > 0) process.exitCode = 1;
    return;
  }
  await checkPlanted(canon);
}

// ---------------------------------------------------------------- prepare
function pickScenes(canon) {
  return selectScenes(canon, { withControl: Boolean(values['with-control']) });
}

async function cmdPrepare() {
  const { canon, v } = await fixtures();
  if (!v.ok) return fail(`夹具校验未通过（${v.errors.length} 个错误），先跑 verify`);
  const arms = parseArms(values.arms);
  const reps = parseReps(values.reps);
  const scenes = pickScenes(canon);
  const samples = buildMatrix(scenes, arms, reps);
  const outDir = path.resolve(ROOT, values.out || path.join('runs', `${stamp()}-prepare`));
  await mkdir(path.join(outDir, 'prompts'), { recursive: true });
  await mkdir(path.join(outDir, 'drafts'), { recursive: true });
  const entries = [];
  for (const sample of samples) {
    const { text } = buildPrompt({ scene: sample.scene, canon, arm: sample.arm, rep: sample.rep });
    const file = path.join('prompts', `${sample.id}.txt`);
    await writeFile(path.join(outDir, file), text, 'utf8');
    entries.push({
      id: sample.id,
      arm: sample.arm,
      arm_label: ARM_LABEL[sample.arm],
      scene: sample.scene.id,
      chapter: sample.scene.chapter,
      rep: sample.rep,
      prompt: file,
      draft: path.join('drafts', `${sample.id}.md`),
    });
  }
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    fixture: path.relative(ROOT, fixtureDir),
    arms,
    reps,
    withControl: Boolean(values['with-control']),
    scenes: scenes.map((s) => ({ id: s.id, chapter: s.chapter, kind: s.kind, pov: s.pov, present: s.present })),
    samples: entries,
  }, null, 2), 'utf8');
  await writeFile(path.join(outDir, 'README.md'), [
    '# 待写清单',
    '',
    `共 ${entries.length} 个样本。每个样本：读 \`prompts/<id>.txt\`，按提示写一篇，存到 \`drafts/<id>.md\`。`,
    '',
    '写完后回到包根目录执行：',
    '',
    '```',
    `node scripts/fanfic-eval.mjs score --out ${path.relative(ROOT, outDir)}`,
    '```',
    '',
    '## 给写稿者（模型/子代理）的硬要求',
    '',
    '- 严格按提示的格式：第一行 `【标签】原著向` 或 `【标签】私设`，第二行 `【正文】`，之后只写正文。',
    '- 不要写标题、提纲、说明、字数统计，不要解释。',
    '- 不要输出任何与草稿无关的话；一篇一个文件。',
    '- 不要偷看其他样本或 `scores.csv`；不要读 `blind-map.json`。',
  ].join('\n') + '\n', 'utf8');
  log(`已生成 ${entries.length} 条提示 → ${path.relative(ROOT, outDir) || outDir}`);
  log('下一步：按 README 写 drafts，然后运行 score。');
}

// ---------------------------------------------------------------- run
async function cmdRun() {
  const { canon, v } = await fixtures();
  if (!v.ok) return fail(`夹具校验未通过（${v.errors.length} 个错误），先跑 verify`);
  const arms = parseArms(values.arms);
  const reps = parseReps(values.reps);
  const writerKind = values.writer || 'stub';
  if (!['stub', 'command'].includes(writerKind)) return fail(`--writer 只支持 stub 或 command`);
  if (writerKind === 'command' && !values.command) return fail('command 适配器需要 --command');
  const scenes = pickScenes(canon);
  const samples = buildMatrix(scenes, arms, reps);
  const outDir = path.resolve(ROOT, values.out || path.join('runs', `${stamp()}-${writerKind}`));
  const violations = writerKind === 'stub' && values['stub-violations']
    ? await loadViolationDrafts(fixtureDir)
    : null;

  await writeFile(path.join(outDir, '..', '.keep'), '', 'utf8').catch(() => {});
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'meta.json'), JSON.stringify({
    tool: 'fanfic-eval',
    version: '0.1.0',
    createdAt: new Date().toISOString(),
    fixture: path.relative(ROOT, fixtureDir),
    arms,
    reps,
    withControl: Boolean(values['with-control']),
    writer: writerKind,
    command: values.command || null,
    stubViolations: Boolean(violations),
    scenes: scenes.map((s) => s.id),
    samples: samples.length,
  }, null, 2), 'utf8');

  const write = async (sample, prompt) => {
    if (writerKind === 'command') {
      const { text } = await commandWriter({ prompt, command: values.command, cwd: ROOT });
      return text;
    }
    if (violations) {
      const idx = seedOf(sample.id) % violations.length;
      return violations[idx].text;
    }
    return stubDraft({ scene: sample.scene, canon });
  };

  const { rows, summary } = await runSamples({
    canon,
    samples,
    outDir,
    write,
    writerName: writerKind === 'command' ? `command:${values.command}` : (violations ? 'stub-violations' : 'stub'),
    onProgress: ({ index, total, row }) => {
      if (values.verbose) log(`  [${index}/${total}] ${row.sample_id} 字数 ${row.chars} 违规 ${row.blockers}`);
    },
  });
  log(printSummary(summary));
  const blind = await buildBlindPackage({ runDir: outDir, rows, seed: Number(values.seed || 20261115) });
  log('');
  log(`输出：${path.relative(ROOT, outDir) || outDir}`);
  log(`  scores.csv（${rows.length} 行）、summary.json、findings.json、meta.json`);
  log(`  盲评包：${path.relative(ROOT, blind.dir)}（${blind.count} 篇，评分者用）`);
  log('  臂映射：blind-map.json（评分者不要看）');
}

// ---------------------------------------------------------------- score
async function cmdScore() {
  const { canon, v } = await fixtures();
  if (!v.ok) return fail(`夹具校验未通过（${v.errors.length} 个错误），先跑 verify`);
  if (!values.out) return fail('score 需要 --out <run 目录>');
  const outDir = path.resolve(ROOT, values.out);
  const draftsDir = path.join(outDir, 'drafts');
  const arms = parseArms(values.arms);
  let samples;
  try {
    const res = await discoverDrafts({ canon, draftsDir, outDir, arms });
    log(printSummary(res.summary));
    const blind = await buildBlindPackage({ runDir: outDir, rows: res.rows, seed: Number(values.seed || 20261115) });
    log('');
    log(`输出：${path.relative(ROOT, outDir)}（scores.csv ${res.rows.length} 行）`);
    log(`盲评包：${path.relative(ROOT, blind.dir)}（${blind.count} 篇）`);
  } catch (err) {
    fail(err.message);
  }
}

// ---------------------------------------------------------------- blind-report
async function cmdBlindReport() {
  const runDir = path.resolve(ROOT, values.run || values.out || '');
  if (!values.run && !values.out) return fail('blind-report 需要 --run <run 目录>');
  try {
    const report = await collectBlindScores({ runDir });
    log(`评分者：${report.raters.join('、')}　样本 ${report.pooled.samples}`);
    for (const arm of ARMS) {
      const a = report.pooled.arms[arm];
      if (!a) continue;
      log(`${arm}：总评均值 ${a.mean['总评(1-5)']}　分布 ${JSON.stringify(a.overallDist)}`);
    }
    log(`已写：${path.relative(ROOT, path.join(runDir, 'blind-report.md'))}`);
  } catch (err) {
    fail(err.message);
  }
}

// ---------------------------------------------------------------- smoke
async function cmdSmoke() {
  const { canon, v } = await fixtures();
  log('1) 夹具校验');
  if (!v.ok) {
    for (const e of v.errors) log(`   ✗ ${e}`);
    return fail('夹具校验未通过');
  }
  log(`   ✓ ${v.stats.chapters} 章 / ${v.stats.plantedCases} 个植入用例 / ${v.stats.lookupQuestions} 个检索问题`);

  log('2) 植入错误对照');
  const before = process.exitCode;
  await checkPlanted(canon);
  if (process.exitCode && process.exitCode !== before) return fail('植入错误对照未通过');

  log('3) 检索自检');
  const lq = scoreLookupQuestions(canon);
  log(`   命中 ${lq.hits}/${lq.total}（${Math.round(lq.hitRate * 1000) / 10}%）`);
  if (lq.hitRate < 0.8) return fail('lookup 命中率低于 80%');

  log('4) stub 跑 45 篇');
  const scenes = selectScenes(canon, { withControl: false });
  const samples = buildMatrix(scenes, ARMS, 3);
  const outDir = path.join(ROOT, 'runs', 'smoke');
  await mkdir(outDir, { recursive: true });
  const { rows, summary } = await runSamples({
    canon, samples, outDir,
    write: async (sample) => stubDraft({ scene: sample.scene, canon }),
    writerName: 'stub',
  });
  log(`   ✓ ${rows.length} 篇，均字数 ${Object.values(summary.arms).map((a) => a.meanChars).join('/')}`);
  const gate = rows.reduce((n, r) => n + r.gate_blockers, 0);
  const blockers = rows.reduce((n, r) => n + r.blockers, 0);
  log(`   必检违规 ${gate}　全部 blocker ${blockers}`);
  const blind = await buildBlindPackage({ runDir: outDir, rows, seed: 20261115 });
  log(`   ✓ 盲评包 ${blind.count} 篇`);
  log(`5) 校验 scores.csv 行数 ${rows.length === 45 ? '✓' : '✗'}`);
  if (gate !== 0 || rows.length !== 45) return fail('stub 基线不干净或样本数不是 45');
  log('');
  log('smoke 全部通过 ✓');
}

// ---------------------------------------------------------------- dispatch
const commands = {
  verify: cmdVerify,
  contract: cmdContract,
  check: cmdCheck,
  lookup: cmdLookup,
  prepare: cmdPrepare,
  run: cmdRun,
  score: cmdScore,
  'blind-report': cmdBlindReport,
  smoke: cmdSmoke,
};

const help = `dsh-novel-fanfic 评测 CLI（v0.1.0）

用法：node scripts/fanfic-eval.mjs <命令> [选项]

命令：
  verify        校验夹具与 ground truth（章节、引文、契约、植入用例）
  contract      编译场景契约：默认打印全部；--scene 单个；--write 写回 contracts/
  check         跑 planted-errors 全部对照；--file <稿> --scene <id> 检查单篇
  lookup        检索自检；--all 跑 10 个预设问题
  prepare       生成提示与 manifest.json（外部模型/子代理写稿用）
  run           跑完整矩阵（默认 stub；--writer command --command "..." 接模型）
  score         给 <run>/drafts 里已有稿件评分并出盲评包
  blind-report  汇总 blind/ 里的评分 CSV
  smoke         verify + check + lookup + stub 45 篇 一条命令自检

常用选项：
  --fixture <dir>   夹具目录（默认 fixtures/fixture-a）
  --out <dir>       输出目录（run/prepare/score）
  --arms A,B,C      实验臂
  --reps 3          每臂每场景次数
  --with-control    追加干净对照场景（+9 篇）
  --stub-violations run 时用植入错误稿代替干净稿（演示管线）
  --verbose         打印每篇进度与细节
  --json            check 单篇时额外输出 JSON

示例：
  node scripts/fanfic-eval.mjs verify
  node scripts/fanfic-eval.mjs check --verbose
  node scripts/fanfic-eval.mjs prepare --out runs/real --with-control
  node scripts/fanfic-eval.mjs score --out runs/real
  node scripts/fanfic-eval.mjs run --out runs/stub-45
  node scripts/fanfic-eval.mjs smoke
`;

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
