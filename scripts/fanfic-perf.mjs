#!/usr/bin/env node
// 导入/面板的性能与体积实测：拿一本真书（或生成的合成长篇）跑一遍，
// 量「解码+分章+落盘」「面板视图构建」「载荷大小」，用来判断大文件下会不会卡。
//
//   node scripts/fanfic-perf.mjs D:/books/我的原著.txt
//   node scripts/fanfic-perf.mjs --generate 2.5          # 生成 ~2.5MB 合成书再测
//   node scripts/fanfic-perf.mjs D:/books/x.txt --json   # 机器可读
//
// 不写工作区：临时项目建在系统临时目录，跑完删掉。

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestFile } from '../lib/ingest.mjs';
import { loadProject } from '../lib/canon-store.mjs';
import { buildBook } from '../lib/views.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const rest = argv.filter((a) => a !== '--json');
const genAt = rest.indexOf('--generate');
const generateMb = genAt >= 0 ? Number(rest[genAt + 1]) : 0;
const input = rest.find((a, i) => !a.startsWith('--') && !(genAt >= 0 && i === genAt + 1));

const SENTENCES = [
  '雾从港口漫上来，灯还亮着。',
  '他把灯绳绕在手腕上，抬头看了一眼天。',
  '潮声钟响的时候，码头上没有人说话。',
  '她翻开簿子，指尖在最后一页停住。',
  '那年的冬至，风比往常更冷一些。',
];

function makeBook(mb) {
  const targetBytes = mb * 1024 * 1024;
  const parts = ['# 性能测试长篇（合成）\n'];
  let bytes = Buffer.byteLength(parts[0]);
  let chapter = 1;
  while (bytes < targetBytes) {
    const head = `\n## 第${chapter}章 第${chapter}夜\n\n`;
    parts.push(head);
    bytes += Buffer.byteLength(head);
    // 每章约 1 万字，接近真实长篇的章长
    for (let chars = 0; chars < 10000; chars += 120) {
      const line = Array.from({ length: 6 }, (_, i) => SENTENCES[(chapter + Math.floor(chars / 120) + i) % SENTENCES.length]).join('');
      parts.push(`${line}\n\n`);
      bytes += Buffer.byteLength(line) + 2;
      if (bytes >= targetBytes) break;
    }
    chapter += 1;
  }
  return { text: parts.join(''), chapters: chapter - 1 };
}

const root = await mkdtemp(path.join(tmpdir(), 'fic-perf-'));
const project = 'perf';
let target = input;
try {
  if (generateMb > 0) {
    const made = makeBook(generateMb);
    target = path.join(root, 'generated.txt');
    await writeFile(target, made.text, 'utf8');
    console.log(`生成 ${generateMb} MB 合成书：${made.chapters} 章 → ${target}`);
  }
  if (!target) throw new Error('用法：node scripts/fanfic-perf.mjs <book.txt> | --generate <MB>');

  const mark = () => Number(process.hrtime.bigint()) / 1e6;
  const bytes = (await readFile(target)).length;

  const t0 = mark();
  const imported = await ingestFile({ root, project, file: path.resolve(target) });
  const t1 = mark();

  const loaded = await loadProject(root, project);
  const chapters = (loaded.index?.chapters || []).map((ch) => ({ id: ch.id, title: ch.title || '', chars: ch.chars || 0, ordinal: ch.ordinal }));

  const t2 = mark();
  const texts = {};
  for (const ch of chapters) {
    try {
      texts[ch.id] = await readFile(loaded.paths.source(loaded.project.sourceId).chapter(ch.id), 'utf8');
    } catch {
      // 缺章不算失败
    }
  }
  const book = buildBook({ canon: loaded.canon, project: loaded.project, chapters, texts });
  const t3 = mark();
  const payload = JSON.stringify(book);

  const report = {
    file: path.resolve(target),
    bytes,
    mb: Number((bytes / 1048576).toFixed(2)),
    encoding: imported.encoding,
    chapters: imported.chapters.length,
    chars: imported.meta.chars,
    importMs: Number((t1 - t0).toFixed(1)),
    panelMs: Number((t3 - t2).toFixed(1)),
    payloadKb: Number((payload.length / 1024).toFixed(1)),
    charsPerSecond: Math.round((imported.meta.chars / Math.max(1, t1 - t0)) * 1000),
    largestChapter: Math.max(0, ...chapters.map((c) => c.chars)),
  };

  if (json) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    console.log('');
    console.log(`文件        ${report.file}`);
    console.log(`大小        ${report.mb} MB（${report.bytes} 字节，${report.encoding}）`);
    console.log(`分章        ${report.chapters} 章 / ${report.chars} 字（最大一章 ${report.largestChapter} 字）`);
    console.log(`导入耗时    ${report.importMs} ms（约 ${report.charsPerSecond} 字/秒）`);
    console.log(`面板构建    ${report.panelMs} ms（${report.chapters} 个章节文件 + 人物提及统计）`);
    console.log(`面板载荷    ${report.payloadKb} KB`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
