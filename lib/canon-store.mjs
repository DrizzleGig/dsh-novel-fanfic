// 项目存储：.dsh-novel-fanfic/<project>/ 的读写、原子写、审计日志。
// 所有实体统一 status: pending | confirmed | rejected | conflict，并带 evidence[{chapter, offset, quote}]。
// 目录形状见开发方案 §4.1；v0.1 只落 canon 子集。
//
// v0.2.0 起 project.json 多两个字段：
//   schemaVersion: 1
//   revision:       单调递增整数；任意一次会改变账本内容的写操作 +1（只读查询不变）
// 旧项目没有 revision 时按 audit.jsonl 行数**只在内存里**兜底（revDrift:true），
// 第一次真实写入（commitProject）才把它落盘成权威值。

import { mkdir, readFile, rename, writeFile, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './hash.mjs';

export const STATUS = ['pending', 'confirmed', 'rejected', 'conflict'];
export const CANON_FILES = ['characters', 'facts', 'worldRules', 'secrets', 'addresses', 'contradictions'];
export const SCHEMA_VERSION = 1;

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

/** audit.jsonl 的行数：旧项目没有 revision 时的迁移兜底（只读，不写盘）。 */
export async function auditLineCount(root, project) {
  const p = paths(root, project);
  try {
    const text = await readFile(p.audit, 'utf8');
    if (!text) return 0;
    return text.split('\n').filter((line) => line.trim()).length;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

export async function projectExists(root, project) {
  const p = paths(root, project);
  try {
    const info = await stat(p.projectFile);
    return info.isFile();
  } catch {
    return false;
  }
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
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(p.projectFile, data);
    await audit(root, project, { action: 'project.create', project });
  } else if (!Number.isInteger(data.schemaVersion)) {
    data.schemaVersion = SCHEMA_VERSION;
  }
  return data;
}

export async function loadProject(root, project) {
  const p = paths(root, project);
  const proj = await readJson(p.projectFile, null);
  if (!proj) throw new Error(`项目不存在：${path.join(p.root, '.dsh-novel-fanfic', project)}（先跑 import）`);
  // 版本兜底：旧项目按 audit 行数给一个只读值，标 revDrift；不在这里写盘。
  if (Number.isInteger(proj.revision) && proj.revision >= 0) {
    proj.revDrift = false;
  } else {
    proj.revision = await auditLineCount(root, project);
    proj.revDrift = true;
  }
  if (!Number.isInteger(proj.schemaVersion)) proj.schemaVersion = SCHEMA_VERSION;
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

/**
 * 唯一的版本提交点：读 project.json → revision +1 → 合并 patch → 原子写。
 * 返回值是**写后**的 revision，调用方负责发事件与刷新 exports。
 *
 * `patch` 里允许带 exports（派生导出，见 lib/exports.mjs）；调用方在同一事务里
 * 一起写，避免「改了内容但导出还是旧的」。
 */
export async function commitProject(root, project, patch = {}, options = {}) {
  const p = paths(root, project);
  const proj = (await readJson(p.projectFile, null)) || {
    id: project,
    title: project,
    sourceId: null,
    currentChapter: null,
    activeBranch: null,
    createdAt: new Date().toISOString(),
  };
  if (!Number.isInteger(proj.revision) || proj.revision < 0) {
    proj.revision = await auditLineCount(root, project);
  }
  proj.schemaVersion = SCHEMA_VERSION;
  proj.revision += 1;
  if (typeof options.exports === 'function') {
    const next = options.exports(proj.revision);
    if (next) proj.exports = next;
  }
  proj.updatedAt = new Date().toISOString();
  Object.assign(proj, patch);
  await writeJsonAtomic(p.projectFile, proj);
  return { revision: proj.revision, updatedAt: proj.updatedAt, project: proj };
}

/** 只读：当前 revision（与 getRevision 同语义，不迁移、不写盘）。 */
export async function readRevision(root, project) {
  const p = paths(root, project);
  const proj = await readJson(p.projectFile, null);
  if (!proj) return { found: false, revision: null, updatedAt: null, revDrift: false };
  if (Number.isInteger(proj.revision) && proj.revision >= 0) {
    return { found: true, revision: proj.revision, updatedAt: proj.updatedAt || null, revDrift: false };
  }
  return {
    found: true,
    revision: await auditLineCount(root, project),
    updatedAt: proj.updatedAt || null,
    revDrift: true,
  };
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
