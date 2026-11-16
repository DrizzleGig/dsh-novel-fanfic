// 原著导入与分章：编码回退、去重、章节切分、索引落盘。
// 口径见开发方案 §5.1–5.2：UTF-8 优先、GB18030 回退；≤20 MB；sha256 去重；
// 行首「第X章/节/回/卷」优先，没有标题时按 3000–5000 字自动分块。

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from './hash.mjs';
import {
  paths, ensureProject, readJson, writeJsonAtomic, writeTextAtomic, audit,
} from './canon-store.mjs';

export const MAX_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_EXT = /\.(txt|md|markdown|text)$/i;
// 允许的控制字符：换行、制表、回车；其余（含 \u0000）按二进制看待。
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const HEADING = /^\s*(?:#{1,6}\s*)?(第[一二三四五六七八九十百千万两零〇0-9０-９]{1,8}[章节回卷])(?:[\s　:：、.．·]*(.*))?\s*$/;
const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8-bom' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8-lossy' };
    }
  }
}

// 书名：首行若是「# 书名」且不是章节标题，就用它；否则回落到文件名。
// （导入时用于项目名，面板页头也显示它。）
const TITLE_LINE = /^#\s+(.+?)\s*$/;
export function bookTitleOf(text, file) {
  const lines = String(text).split('\n').slice(0, 12);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = TITLE_LINE.exec(trimmed);
    if (m && !HEADING.exec(trimmed)) return m[1].trim();
    break;
  }
  const base = path.basename(String(file || '未命名'));
  return base.replace(/\.[^.]+$/, '') || '未命名';
}

export function cnNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9０-９]+$/.test(s)) return Number(s.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10)));
  if (/^[零〇一二两三四五六七八九十百千万]+$/.test(s)) {
    let total = 0;
    let section = 0;
    let number = 0;
    for (const ch of s) {
      if (CN_NUM[ch] !== undefined) {
        number = CN_NUM[ch];
      } else if (ch === '十') {
        section += (number || 1) * 10;
        number = 0;
      } else if (ch === '百') {
        section += (number || 1) * 100;
        number = 0;
      } else if (ch === '千') {
        section += (number || 1) * 1000;
        number = 0;
      } else if (ch === '万') {
        total += (section + number) * 10000;
        section = 0;
        number = 0;
      }
    }
    return total + section + number;
  }
  return null;
}

// 按行扫标题；每个标题行开启一章，标题之前若有正文记为「序」。
export function splitChapters(text) {
  const lines = String(text).split('\n');
  const offsets = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 40) continue;
    const m = HEADING.exec(line);
    if (!m) continue;
    heads.push({ line: i, offset: offsets[i], heading: m[1], title: (m[2] || '').trim() });
  }
  if (!heads.length) return chunkChapters(text);

  const chapters = [];
  if (heads[0].offset > 0) {
    const body = text.slice(0, heads[0].offset).trim();
    if (body) {
      chapters.push({
        id: 'ch000', ordinal: 0, title: '序', heading: '（序）', body,
        start: text.indexOf(body), end: text.indexOf(body) + body.length,
      });
    }
  }
  for (let i = 0; i < heads.length; i += 1) {
    const head = heads[i];
    const next = heads[i + 1];
    const end = next ? next.offset : text.length;
    const raw = text.slice(head.offset, end);
    const firstBreak = raw.indexOf('\n');
    const body = firstBreak >= 0 ? raw.slice(firstBreak + 1) : '';
    const trimmedBody = body.replace(/\s+$/g, '');
    const titleText = head.title || head.heading;
    chapters.push({
      id: `ch${String(i + 1).padStart(3, '0')}`,
      ordinal: Number(head.heading.replace(/[^0-9一二三四五六七八九十百千万两零〇]/g, '') ? cnNumber(head.heading.replace(/[^0-9一二三四五六七八九十百千万两零〇]/g, '')) : i + 1) || i + 1,
      title: titleText,
      heading: head.heading,
      body: trimmedBody,
      start: head.offset,
      end: head.offset + raw.length,
    });
  }
  return chapters;
}

// 无标题兜底：按空行分段，累计到 3000–5000 字切一块。
export function chunkChapters(text, target = 4000) {
  const chunks = [];
  const paras = String(text).split(/\n{2,}/);
  let buf = '';
  let bufStart = 0;
  let cursor = 0;
  const flush = () => {
    if (!buf.trim()) return;
    const body = buf.replace(/^\s+|\s+$/g, '');
    chunks.push({
      id: `ch${String(chunks.length + 1).padStart(3, '0')}`,
      ordinal: chunks.length + 1,
      title: `自动分块 ${chunks.length + 1}`,
      heading: '',
      body,
      start: bufStart,
      end: bufStart + body.length,
    });
    buf = '';
  };
  for (const para of paras) {
    const paraStart = cursor;
    cursor += para.length + 2;
    if (!buf) bufStart = paraStart;
    buf += (buf ? '\n\n' : '') + para;
    if (buf.length >= target) flush();
  }
  flush();
  return chunks;
}

export function buildIndex(text, chapters, meta = {}) {
  return {
    sourceId: meta.sourceId || null,
    sha256: sha256(text),
    encoding: meta.encoding || 'utf-8',
    chars: text.length,
    chapterCount: chapters.length,
    chapters: chapters.map((c) => ({
      id: c.id, ordinal: c.ordinal, title: c.title, heading: c.heading,
      chars: c.body.length, start: c.start, end: c.end,
    })),
  };
}

/** 读原著文本：扩展名、大小、编码、二进制、空文件都在这里挡掉，并给可读的错误。 */
export async function readSourceText(file, options = {}) {
  const abs = String(file || '');
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_BYTES;
  const fmt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${n} 字节`);
  if (options.checkExt !== false && !SUPPORTED_EXT.test(abs)) {
    throw new Error(`只支持 txt / md 文件：${path.basename(abs) || abs}`);
  }
  let buffer;
  try {
    buffer = await readFile(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`文件不存在：${abs}`);
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new Error(`没有权限读这个文件：${abs}`);
    if (err.code === 'EISDIR') throw new Error(`这是一个目录，不是文件：${abs}`);
    throw new Error(`读文件失败（${err.code || '未知错误'}）：${abs}`);
  }
  if (buffer.length > maxBytes) {
    throw new Error(`文件 ${fmt(buffer.length)}，超过 ${fmt(maxBytes)} 上限；请分卷后再导入`);
  }
  if (!buffer.length) throw new Error('文件是空的');
  const decoded = decodeText(buffer);
  // 统一换行：CRLF 文件里的 \r 会混进正文和引文偏移，分章前先归一。
  const text = decoded.text.replace(/\r\n?/g, '\n');
  const encoding = decoded.encoding;
  if (!text.trim()) throw new Error('文件里没有可读的文字');
  const control = (text.match(CONTROL) || []).length;
  if (text.includes('\u0000') || control / text.length > 0.005) {
    throw new Error('看起来是二进制文件（含控制字符），不是 txt / md 文本');
  }
  return { text, encoding, bytes: buffer.length };
}

export async function ingestFile({ root, project, file, title }) {
  const { text, encoding } = await readSourceText(file);
  const sha = sha256(text);
  const sourceId = `src_${sha.slice(0, 10)}`;

  const p = paths(root, project);
  const prevProject = await ensureProject(root, project, { title: title || bookTitleOf(text, file) });
  const prevMeta = prevProject.sourceId ? await readJson(p.source(prevProject.sourceId).meta, null) : null;
  if (prevMeta && prevMeta.sha256 === sha) {
    return { duplicate: true, sourceId: prevProject.sourceId, meta: prevMeta };
  }

  const chapters = splitChapters(text);
  if (!chapters.length) throw new Error('没有识别到任何章节或分块，文本可能为空');

  const sp = p.source(sourceId);
  await writeTextAtomic(sp.raw, text);
  for (const ch of chapters) await writeTextAtomic(sp.chapter(ch.id), ch.body);
  const meta = {
    sourceId, filename: path.basename(file), encoding, sha256: sha,
    chars: text.length, chapterCount: chapters.length,
    importedAt: new Date().toISOString(),
  };
  const index = buildIndex(text, chapters, meta);
  await writeJsonAtomic(sp.meta, meta);
  await writeJsonAtomic(sp.index, index);

  const proj = await readJson(p.projectFile, null);
  proj.sourceId = sourceId;
  proj.title = proj.title || title || bookTitleOf(text, file);
  proj.updatedAt = new Date().toISOString();
  if (!proj.currentChapter && chapters.length) proj.currentChapter = chapters[0].id;
  await writeJsonAtomic(p.projectFile, proj);
  for (const bucket of ['characters', 'facts', 'worldRules', 'secrets', 'addresses', 'contradictions', 'proposals']) {
    const existing = await readJson(p.file(bucket), null);
    if (!existing) await writeJsonAtomic(p.file(bucket), []);
  }
  await audit(root, project, { action: 'source.import', sourceId, sha256: sha, chapters: chapters.length });

  return { duplicate: false, sourceId, encoding, meta, index, chapters };
}
