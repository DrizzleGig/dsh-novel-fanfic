// 评测运行器：矩阵、生成/评分、汇总、CSV。
// 只依赖 Node 内置模块；真实模型通过 command 适配器或「prepare + 外部写稿 + score」。

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildPrompt, sampleId } from './prompts.mjs';
import { stubDraft, commandWriter } from './writers.mjs';
import { runCheck } from '../../lib/checker.mjs';
import { toCsv, csvWithBom } from './csv.mjs';
import { mulberry32, seededShuffle } from '../../lib/text.mjs';

export const DETECTORS = [
  'appearance', 'address', 'knowledge', 'auLeak', 'tagDefault',
  'copy20', 'branchCross', 'headcanon', 'unknown', 'worldRule', 'name', 'contractGap',
];

export const SCORE_COLUMNS = [
  'sample_id', 'scene', 'chapter', 'kind', 'arm', 'arm_label', 'rep', 'writer',
  'tag', 'chars', 'blockers', 'gate_blockers', 'warnings', 'infos',
  ...DETECTORS,
  'finding_codes', 'missing_must', 'draft', 'prompt',
];

export function selectScenes(canon, { withControl = false } = {}) {
  return canon.scenes.filter((s) => s.kind === 'canon' || (withControl && s.kind === 'control'));
}

export function buildMatrix(scenes, arms, reps) {
  const samples = [];
  for (const scene of scenes) {
    for (const arm of arms) {
      for (let rep = 1; rep <= reps; rep += 1) {
        samples.push({ id: sampleId(arm, scene.id, rep), arm, scene, rep });
      }
    }
  }
  return samples;
}

function detectorCounts(findings) {
  const counts = Object.fromEntries(DETECTORS.map((d) => [d, 0]));
  for (const f of findings) if (counts[f.detector] !== undefined) counts[f.detector] += 1;
  return counts;
}

export function rowFor({ sample, raw, result, writer, draftPath, promptPath }) {
  const counts = detectorCounts(result.findings);
  const missingMust = result.findings
    .filter((f) => f.detector === 'contractGap')
    .map((f) => (f.canonRef?.requiredForm ? `form:${f.canonRef.requiredForm.form}` : `reveal:${f.canonRef?.secret || '?'}`));
  return {
    sample_id: sample.id,
    scene: sample.scene.id,
    chapter: sample.scene.chapter,
    kind: sample.scene.kind,
    arm: sample.arm,
    arm_label: { A: '无契约', B: '契约', C: '契约+lookup' }[sample.arm],
    rep: sample.rep,
    writer,
    tag: result.tag || 'MISSING',
    chars: result.chars,
    blockers: result.summary.blockers,
    gate_blockers: result.summary.gateBlockers,
    warnings: result.summary.warnings,
    infos: result.summary.infos,
    ...counts,
    finding_codes: [...new Set(result.findings.map((f) => `${f.detector}:${f.code}`))].join(';'),
    missing_must: [...new Set(missingMust)].join(';'),
    draft: draftPath,
    prompt: promptPath,
  };
}

/**
 * 运行（或评分）一个样本矩阵。
 * @param {object} opts
 * @param {object} opts.canon
 * @param {Array} opts.samples  buildMatrix 的结果
 * @param {string} opts.outDir
 * @param {(sample: object, prompt: string) => Promise<string>} opts.write 返回草稿原文
 * @param {string} opts.writerName 记录到 CSV
 * @param {boolean} [opts.reusePrompts] score 模式：提示文件已存在，不重新生成
 */
export async function runSamples({ canon, samples, outDir, write, writerName, reusePrompts = false, onProgress }) {
  await mkdir(path.join(outDir, 'drafts'), { recursive: true });
  await mkdir(path.join(outDir, 'prompts'), { recursive: true });
  await mkdir(path.join(outDir, 'findings'), { recursive: true });

  const rows = [];
  const findingsById = {};
  let i = 0;
  for (const sample of samples) {
    i += 1;
    const promptFile = path.join('prompts', `${sample.id}.txt`);
    const draftFile = path.join('drafts', `${sample.id}.md`);
    let prompt = '';
    if (reusePrompts) {
      try {
        prompt = await readFile(path.join(outDir, promptFile), 'utf8');
      } catch {
        prompt = buildPrompt({ scene: sample.scene, canon, arm: sample.arm, rep: sample.rep }).text;
      }
    } else {
      prompt = buildPrompt({ scene: sample.scene, canon, arm: sample.arm, rep: sample.rep }).text;
      await writeFile(path.join(outDir, promptFile), prompt, 'utf8');
    }
    const raw = String(await write(sample, prompt)).trim();
    await writeFile(path.join(outDir, draftFile), raw + '\n', 'utf8');
    const result = runCheck(raw, sample.scene, canon, { arm: sample.arm });
    findingsById[sample.id] = result.findings;
    rows.push(rowFor({ sample, raw, result, writer: writerName, draftPath: draftFile, promptPath: promptFile }));
    onProgress?.({ index: i, total: samples.length, sample, row: rows[rows.length - 1] });
  }

  await writeFile(path.join(outDir, 'scores.csv'), csvWithBom(toCsv(rows, SCORE_COLUMNS)), 'utf8');
  await writeFile(path.join(outDir, 'findings.json'), JSON.stringify(findingsById, null, 2), 'utf8');
  const summary = summarize(rows);
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  return { rows, summary };
}

/** 按臂、场景汇总。只报绝对次数与均值，不做显著性结论。 */
export function summarize(rows) {
  const arms = {};
  for (const row of rows) {
    const a = arms[row.arm] || (arms[row.arm] = {
      arm: row.arm, label: row.arm_label, samples: 0, chars: 0,
      blockers: 0, gate_blockers: 0, warnings: 0, infos: 0,
      detectors: Object.fromEntries(DETECTORS.map((d) => [d, 0])),
      scenes: {}, codes: {},
    });
    a.samples += 1;
    a.chars += row.chars;
    a.blockers += row.blockers;
    a.gate_blockers += row.gate_blockers;
    a.warnings += row.warnings;
    a.infos += row.infos;
    for (const d of DETECTORS) a.detectors[d] += row[d] || 0;
    const sc = a.scenes[row.scene] || (a.scenes[row.scene] = { samples: 0, blockers: 0, gate_blockers: 0, warnings: 0 });
    sc.samples += 1;
    sc.blockers += row.blockers;
    sc.gate_blockers += row.gate_blockers;
    sc.warnings += row.warnings;
  }
  for (const a of Object.values(arms)) {
    a.meanChars = a.samples ? Math.round(a.chars / a.samples) : 0;
  }
  const A = arms.A;
  const C = arms.C;
  const comparison = A && C ? {
    gate_blockers: { a: A.gate_blockers, c: C.gate_blockers, delta: A.gate_blockers - C.gate_blockers },
    blockers: { a: A.blockers, c: C.blockers, delta: A.blockers - C.blockers },
    warnings: { a: A.warnings, c: C.warnings, delta: A.warnings - C.warnings },
  } : null;
  return {
    samples: rows.length,
    arms,
    comparison,
    note: '样本量为探索级：每臂每场景 3 次，只报绝对次数与逐场景分布，不做统计显著结论。',
  };
}

/** 从 drafts/ 目录读取已有稿件（agent 写稿后评分）。 */
export async function discoverDrafts({ canon, draftsDir, outDir, arms = ['A', 'B', 'C'], onProgress }) {
  const files = (await readdir(draftsDir)).filter((f) => /^[ABC]-scene_[A-Za-z0-9_]+-r\d+\.md$/.test(f)).sort();
  const samples = [];
  for (const f of files) {
    const m = f.match(/^([ABC])-(scene_[A-Za-z0-9_]+)-r(\d+)\.md$/);
    const scene = canon.sceneById.get(m[2]);
    if (!scene) throw new Error(`未知场景：${m[2]}（${f}）`);
    if (!arms.includes(m[1])) continue;
    samples.push({ id: f.replace(/\.md$/, ''), arm: m[1], scene, rep: Number(m[3]) });
  }
  if (!samples.length) throw new Error(`在 ${draftsDir} 没找到形如 A-scene_1-r01.md 的稿件`);
  const rows = [];
  const findingsById = {};
  let i = 0;
  for (const sample of samples) {
    i += 1;
    const raw = (await readFile(path.join(draftsDir, `${sample.id}.md`), 'utf8')).trim();
    const result = runCheck(raw, sample.scene, canon, { arm: sample.arm });
    findingsById[sample.id] = result.findings;
    rows.push(rowFor({
      sample,
      raw,
      result,
      writer: 'external',
      draftPath: path.join('drafts', `${sample.id}.md`),
      promptPath: path.join('prompts', `${sample.id}.txt`),
    }));
    onProgress?.({ index: i, total: samples.length, sample, row: rows[rows.length - 1] });
  }
  await mkdir(path.join(outDir, 'findings'), { recursive: true });
  await writeFile(path.join(outDir, 'scores.csv'), csvWithBom(toCsv(rows, SCORE_COLUMNS)), 'utf8');
  await writeFile(path.join(outDir, 'findings.json'), JSON.stringify(findingsById, null, 2), 'utf8');
  const summary = summarize(rows);
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  return { rows, summary, samples };
}

export function printSummary(summary) {
  const lines = [];
  lines.push('臂        样本  均字数  硬违规  必检违规  警告  提示');
  for (const arm of ['A', 'B', 'C']) {
    const a = summary.arms[arm];
    if (!a) continue;
    lines.push(`${a.arm} ${a.label.padEnd(6, '　')} ${String(a.samples).padStart(4)}  ${String(a.meanChars).padStart(5)}  ${String(a.blockers).padStart(5)}  ${String(a.gate_blockers).padStart(7)}  ${String(a.warnings).padStart(5)}  ${String(a.infos).padStart(4)}`);
  }
  if (summary.comparison) {
    const c = summary.comparison;
    lines.push('');
    lines.push(`C 相对 A：必检违规 ${c.gate_blockers.a} → ${c.gate_blockers.c}（少 ${c.gate_blockers.delta}）；硬违规 ${c.blockers.a} → ${c.blockers.c}（少 ${c.blockers.delta}）；警告 ${c.warnings.a} → ${c.warnings.c}（少 ${c.warnings.delta}）`);
  }
  lines.push('');
  lines.push(summary.note);
  return lines.join('\n');
}

/** 演示用的随机种子：把提示文本映射成固定种子，保证 stub 可复现。 */
export function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { mulberry32, seededShuffle };
