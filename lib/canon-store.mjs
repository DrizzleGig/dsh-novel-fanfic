// 项目存储：.dsh-novel-fanfic/<project>/ 的读写、原子写、审计日志。
// 所有实体统一 status: pending | confirmed | rejected | conflict，并带 evidence[{chapter, offset, quote}]。
// 目录形状见开发方案 §4.1；v0.1 只落 canon 子集。

import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './hash.mjs';

export const STATUS = ['pending', 'confirmed', 'rejected', 'conflict'];
export const CANON_FILES = ['characters', 'facts', 'worldRules', 'secrets', 'addresses', 'contradictions'];

export function paths(root, project) {
  const dir = path.join(root, '.dsh-novel-fanfic', project);
  const sourceDir = path.join(dir, 'source');
  const canonDir = path.join(dir, 'canon');
  return {
    root,
    project,
    dir,
    projectFile: path.join(dir, 'project.json'),
    sourceDir,
    canonDir,
    audit: path.join(dir, 'audit.jsonl'),
    file: (bucket) => path.join(canonDir, `${bucket}.json`),
    source: (sourceId) => ({
      dir: path.join(sourceDir, sourceId),
      meta: path.join(sourceDir, sourceId, 'meta.json'),
      raw: path.join(sourceDir, sourceId, 'raw.txt'),
      index: path.join(sourceDir, sourceId, 'index.json'),
      chapter: (id) => path.join(sourceDir, sourceId, 'chapters', `${id}.txt`),
    }),
  };
}

export async function readJson(file, fallback = null) {
  try {
    // 用户可能用记事本手改过 JSON，带 BOM 时 JSON.parse 会直接抛错；先剥掉。
    const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// 原子写：先写 tmp 再 rename，断电不会留下半个 JSON。
export async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

export async function audit(root, project, entry) {
  const p = paths(root, project);
  await mkdir(p.dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  await appendFile(p.audit, `${line}\n`, 'utf8');
}

export async function ensureProject(root, project, meta = {}) {
  const p = paths(root, project);
  const now = new Date().toISOString();
  let data = await readJson(p.projectFile, null);
  if (!data) {
    data = {
      id: project,
      title: meta.title || project,
      sourceId: meta.sourceId || null,
      currentChapter: null,
      activeBranch: null,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(p.projectFile, data);
    await audit(root, project, { action: 'project.create', project });
  }
  return data;
}

export async function loadProject(root, project) {
  const p = paths(root, project);
  const proj = await readJson(p.projectFile, null);
  if (!proj) throw new Error(`项目不存在：${path.join(p.root, '.dsh-novel-fanfic', project)}（先跑 import）`);
  const canon = {};
  for (const bucket of [...CANON_FILES, 'proposals']) {
    canon[bucket] = (await readJson(p.file(bucket), null)) || [];
  }
  let index = null;
  if (proj.sourceId) {
    index = await readJson(p.source(proj.sourceId).index, null);
  }
  return { project: proj, canon, index, paths: p };
}

export async function saveCanon(root, project, canon) {
  const p = paths(root, project);
  for (const bucket of [...CANON_FILES, 'proposals']) {
    await writeJsonAtomic(p.file(bucket), canon[bucket] || []);
  }
  const proj = await readJson(p.projectFile, null);
  if (proj) {
    proj.updatedAt = new Date().toISOString();
    await writeJsonAtomic(p.projectFile, proj);
  }
}

export async function chapterBody(root, project, chapterId) {
  const { project: proj, paths: p } = await loadProject(root, project);
  if (!proj.sourceId) throw new Error('项目还没有导入原著');
  return readFile(p.source(proj.sourceId).chapter(chapterId), 'utf8');
}

export function evidenceKey(ev) {
  return `${ev.chapter}@${ev.offset}:${ev.quote}`;
}

export function nextId(prefix, list) {
  const n = list.filter((x) => String(x.id).startsWith(`${prefix}_`)).length + 1;
  let id = `${prefix}_${String(n).padStart(3, '0')}`;
  const used = new Set(list.map((x) => x.id));
  while (used.has(id)) id = `${prefix}_${String(++n).padStart(3, '0')}`;
  return id;
}

export function hashFile(text) {
  return sha256(text);
}
