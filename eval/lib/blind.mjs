// 盲评包：把稿件洗掉臂标签、编成 B001…，生成评分模板；评分后按映射汇总。
// 评分者只看到 blind/；臂映射留在 run 根目录的 blind-map.json。

import { copyFile, mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { seededShuffle } from '../../lib/text.mjs';
import { toCsv, csvWithBom, parseCsv } from './csv.mjs';

export const RATER_COLUMNS = [
  '盲评编号', '章', '类型',
  '契合原著(1-5)', '人物声线(1-5)', '对话自然(1-5)', '场景成立(1-5)', '总评(1-5)', '备注',
];

const RATER_NUMERIC = ['契合原著(1-5)', '人物声线(1-5)', '对话自然(1-5)', '场景成立(1-5)', '总评(1-5)'];

export async function buildBlindPackage({ runDir, rows, seed = 20261115 }) {
  const blindDir = path.join(runDir, 'blind');
  await mkdir(path.join(blindDir, 'drafts'), { recursive: true });

  const order = seededShuffle(rows.map((r) => r.sample_id), seed);
  const byId = new Map(rows.map((r) => [r.sample_id, r]));
  const items = [];
  for (let i = 0; i < order.length; i += 1) {
    const row = byId.get(order[i]);
    const blindId = `B${String(i + 1).padStart(3, '0')}`;
    await copyFile(
      path.join(runDir, row.draft),
      path.join(blindDir, 'drafts', `${blindId}.md`),
    );
    items.push({
      blind_id: blindId,
      sample_id: row.sample_id,
      arm: row.arm,
      scene: row.scene,
      chapter: row.chapter,
      rep: row.rep,
    });
  }

  await writeFile(path.join(runDir, 'blind-map.json'), JSON.stringify({ seed, items }, null, 2), 'utf8');

  const templateRows = items.map((it) => ({
    盲评编号: it.blind_id,
    章: it.chapter,
    类型: it.scene === 'scene_6' ? '对照' : '场景',
  }));
  await writeFile(
    path.join(blindDir, 'blind-scores-template.csv'),
    csvWithBom(toCsv(templateRows, RATER_COLUMNS)),
    'utf8',
  );

  const readme = [
    '# 盲评包',
    '',
    `共 ${items.length} 篇。稿件已去掉实验臂标签，只保留编号。`,
    '',
    '## 怎么打分',
    '',
    '1. 复制 `blind-scores-template.csv` 为 `blind-scores-rater1.csv`（第二位评分者用 `rater2`）。',
    '2. 逐篇阅读 `drafts/B001.md` 等，按 1–5 打分：1 明显不像 / 3 一般 / 5 很像。',
    '3. 只看稿件本身。不要根据文风猜它属于哪一臂，也不要和别的评分者商量。',
    '4. 五个维度：',
    '   - 契合原著：人物、设定、世界规则是否和原著一致；',
    '   - 人物声线：说话方式、用词是否像这个人；',
    '   - 对话自然：对话是否像人说的；',
    '   - 场景成立：这一段作为一章/一场戏是否站得住；',
    '   - 总评：综合印象。',
    '',
    '## 注意',
    '',
    '- 类型「对照」是干净对照章，用来估计误报，不需要特殊对待。',
    '- 有些稿件可能标签与正文不一致，这属于被评测对象的一部分，不必因此扣分，除非它影响阅读。',
    '- 打分完成后把 CSV 放回本目录（`blind/`），运行 `node scripts/fanfic-eval.mjs blind-report --run <本目录的上一级>`。',
  ].join('\n');
  await writeFile(path.join(blindDir, 'README.md'), readme + '\n', 'utf8');
  return { dir: blindDir, count: items.length, items };
}

async function readRaterFiles(blindDir) {
  const files = (await readdir(blindDir)).filter((f) => /^blind-scores-(rater\d+|.*)\.csv$/.test(f));
  const raters = [];
  for (const f of files.sort()) {
    const rows = parseCsv(await readFile(path.join(blindDir, f), 'utf8'));
    const scored = rows.filter((r) => r['盲评编号'] && RATER_NUMERIC.every((c) => r[c] !== undefined && r[c] !== ''));
    if (scored.length) raters.push({ file: f, rows: scored });
  }
  return raters;
}

function meanOf(rows, key) {
  const vals = rows.map((r) => Number(r[key])).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

function distOf(rows, key) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) {
    const v = Number(r[key]);
    if (dist[v] !== undefined) dist[v] += 1;
  }
  return dist;
}

export async function collectBlindScores({ runDir }) {
  const blindDir = path.join(runDir, 'blind');
  const map = JSON.parse(await readFile(path.join(runDir, 'blind-map.json'), 'utf8'));
  const armOf = new Map(map.items.map((it) => [it.blind_id, it]));
  const raters = await readRaterFiles(blindDir);
  if (!raters.length) throw new Error(`在 ${blindDir} 没找到填好的 blind-scores-*.csv`);

  const perRater = [];
  const pooled = [];
  for (const rater of raters) {
    const joined = rater.rows.map((r) => ({ ...r, ...armOf.get(r['盲评编号']) })).filter((r) => r.arm);
    const arms = {};
    for (const arm of ['A', 'B', 'C']) {
      const rowsArm = joined.filter((r) => r.arm === arm);
      if (!rowsArm.length) continue;
      arms[arm] = {
        samples: rowsArm.length,
        mean: Object.fromEntries(RATER_NUMERIC.map((c) => [c, meanOf(rowsArm, c)])),
        overallDist: distOf(rowsArm, '总评(1-5)'),
        scenes: Object.fromEntries([...new Set(rowsArm.map((r) => r.scene))].sort().map((s) => {
          const rs = rowsArm.filter((r) => r.scene === s);
          return [s, { samples: rs.length, mean: meanOf(rs, '总评(1-5)') }];
        })),
      };
    }
    perRater.push({ file: rater.file, scored: joined.length, arms });
    pooled.push(...joined);
  }

  const pooledArms = {};
  for (const arm of ['A', 'B', 'C']) {
    const rowsArm = pooled.filter((r) => r.arm === arm);
    if (!rowsArm.length) continue;
    pooledArms[arm] = {
      samples: rowsArm.length,
      mean: Object.fromEntries(RATER_NUMERIC.map((c) => [c, meanOf(rowsArm, c)])),
      overallDist: distOf(rowsArm, '总评(1-5)'),
    };
  }
  const report = {
    runDir,
    raters: perRater.map((r) => r.file),
    perRater,
    pooled: { samples: pooled.length, arms: pooledArms },
    note: '2 名评分者独立打分；样本量 15 篇/臂，只报均值与分布，不做统计显著结论。',
  };
  await writeFile(path.join(runDir, 'blind-report.json'), JSON.stringify(report, null, 2), 'utf8');

  const lines = ['# 盲评汇总', '', `评分者：${perRater.map((r) => r.file).join('、')}`, ''];
  lines.push('| 臂 | 样本 | 契合原著 | 人物声线 | 对话自然 | 场景成立 | 总评 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of ['A', 'B', 'C']) {
    const a = pooledArms[arm];
    if (!a) continue;
    lines.push(`| ${arm} | ${a.samples} | ${a.mean['契合原著(1-5)']} | ${a.mean['人物声线(1-5)']} | ${a.mean['对话自然(1-5)']} | ${a.mean['场景成立(1-5)']} | ${a.mean['总评(1-5)']} |`);
  }
  lines.push('', '## 总评分布', '');
  for (const arm of ['A', 'B', 'C']) {
    const a = pooledArms[arm];
    if (!a) continue;
    lines.push(`- ${arm}：1分 ${a.overallDist[1]} / 2分 ${a.overallDist[2]} / 3分 ${a.overallDist[3]} / 4分 ${a.overallDist[4]} / 5分 ${a.overallDist[5]}`);
  }
  lines.push('', report.note);
  await writeFile(path.join(runDir, 'blind-report.md'), lines.join('\n') + '\n', 'utf8');
  return report;
}
