// 端到端：stub 生成 → scores.csv → 盲评包 → 两份评分汇总；以及 discoverDrafts 复用已有稿。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';

import { loadFixture } from '../lib/canon.mjs';
import { runSamples, selectScenes, buildMatrix, discoverDrafts, SCORE_COLUMNS } from '../eval/lib/runner.mjs';
import { stubDraft } from '../eval/lib/writers.mjs';
import { buildBlindPackage, collectBlindScores, RATER_COLUMNS } from '../eval/lib/blind.mjs';
import { toCsv, csvWithBom, parseCsv } from '../eval/lib/csv.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const canon = await loadFixture(path.join(ROOT, 'fixtures', 'fixture-a'));

const scenes = selectScenes(canon).slice(0, 2);
const samples = buildMatrix(scenes, ['B', 'C'], 2);
const outDir = await mkdtemp(path.join(os.tmpdir(), 'fic-run-'));

test.after(async () => {
  await rm(outDir, { recursive: true, force: true });
});

let rows;

test('runSamples 写出 CSV / findings / summary，行数与矩阵一致', async () => {
  const res = await runSamples({
    canon,
    samples,
    outDir,
    write: async (s) => stubDraft({ scene: s.scene, canon }),
    writerName: 'stub',
  });
  rows = res.rows;
  assert.equal(rows.length, 8);
  assert.equal(res.summary.arms.B.samples, 4);
  assert.equal(res.summary.arms.C.samples, 4);

  const csv = await readFile(path.join(outDir, 'scores.csv'), 'utf8');
  assert.ok(csv.startsWith('\ufeff'), 'scores.csv 应带 BOM');
  const parsed = parseCsv(csv);
  assert.equal(parsed.length, 8);
  assert.deepEqual(Object.keys(parsed[0]), SCORE_COLUMNS);
  assert.equal(parsed[0].writer, 'stub');
  assert.ok(parsed.every((r) => Number(r.gate_blockers) === 0), 'stub 基线不应有必检违规');

  const findings = JSON.parse(await readFile(path.join(outDir, 'findings.json'), 'utf8'));
  assert.deepEqual(Object.keys(findings).sort(), samples.map((s) => s.id).sort());
  const summary = JSON.parse(await readFile(path.join(outDir, 'summary.json'), 'utf8'));
  assert.equal(summary.arms.C.samples, 4);
});

test('盲评包：编号不含臂标签，映射单独存放', async () => {
  const blind = await buildBlindPackage({ runDir: outDir, rows, seed: 7 });
  assert.equal(blind.count, 8);
  const ids = blind.items.map((i) => i.blind_id);
  assert.deepEqual(ids, ['B001', 'B002', 'B003', 'B004', 'B005', 'B006', 'B007', 'B008']);

  const map = JSON.parse(await readFile(path.join(outDir, 'blind-map.json'), 'utf8'));
  assert.equal(map.items.length, 8);
  assert.ok(map.items.every((i) => ['B', 'C'].includes(i.arm)));

  const template = parseCsv(await readFile(path.join(outDir, 'blind', 'blind-scores-template.csv'), 'utf8'));
  assert.deepEqual(Object.keys(template[0]), RATER_COLUMNS);
  assert.ok(template.every((r) => !r['总评(1-5)']), '模板不应预填分数');

  // 评分者能看到的东西里不能出现臂标签
  const readme = await readFile(path.join(outDir, 'blind', 'README.md'), 'utf8');
  assert.ok(!/无契约|契约\+lookup/.test(readme));
  for (const it of blind.items) {
    const text = await readFile(path.join(outDir, 'blind', 'drafts', `${it.blind_id}.md`), 'utf8');
    assert.ok(!/^【?臂?】?[ABC]\b/m.test(text), '正文里不应泄露臂标签');
  }
});

test('collectBlindScores 合并多名评分者并按臂汇总', async () => {
  const map = JSON.parse(await readFile(path.join(outDir, 'blind-map.json'), 'utf8'));
  const scoreByArm = { B: 3, C: 4 };
  const fill = (delta) => map.items.map((it) => {
    const v = scoreByArm[it.arm] + delta;
    return {
      '盲评编号': it.blind_id,
      '章': it.chapter,
      '类型': '场景',
      '契合原著(1-5)': v,
      '人物声线(1-5)': v,
      '对话自然(1-5)': v,
      '场景成立(1-5)': v,
      '总评(1-5)': v,
      '备注': '',
    };
  });
  for (const [name, delta] of [['rater1', 0], ['rater2', 1]]) {
    await writeFile(
      path.join(outDir, 'blind', `blind-scores-${name}.csv`),
      csvWithBom(toCsv(fill(delta), RATER_COLUMNS)),
      'utf8',
    );
  }
  const report = await collectBlindScores({ runDir: outDir });
  assert.equal(report.raters.length, 2);
  assert.equal(report.pooled.samples, 16);
  assert.equal(report.pooled.arms.B.mean['总评(1-5)'], 3.5);
  assert.equal(report.pooled.arms.C.mean['总评(1-5)'], 4.5);
  const md = await readFile(path.join(outDir, 'blind-report.md'), 'utf8');
  assert.match(md, /B/);
  assert.match(md, /不做统计显著/);
});

test('discoverDrafts 能对已有稿重新评分（prepare → 外部写稿 → score 的路径）', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'fic-score-'));
  const dir2 = path.join(base, 'run');
  try {
    await cp(outDir, dir2, { recursive: true, filter: (src) => !src.startsWith(path.join(outDir, 'blind')) });
    const res = await discoverDrafts({ canon, draftsDir: path.join(dir2, 'drafts'), outDir: dir2, arms: ['B', 'C'] });
    assert.equal(res.rows.length, 8);
    const csv = await readFile(path.join(dir2, 'scores.csv'), 'utf8');
    assert.equal(parseCsv(csv).length, 8);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
