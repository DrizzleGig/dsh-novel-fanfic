// 项目媒体来源与证据账本：.dsh-novel-fanfic/<project>/media.json。
//
// 只登记“用户授权/本地文件”的来源元数据与最小证据；不复制整本漫画/整集短剧，
// 不存播放地址/内容密钥。mediaRevision 独立于 project.json.revision：
// 加来源/证据/删除只影响媒体账本，不使 canon 契约失效。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { audit, paths, projectExists, readJson, writeJsonAtomic } from './canon-store.mjs';
import { sha256Buffer } from './hash.mjs';
import { assertSafeProject } from './project-name.mjs';
import { listComicPages } from './comic.mjs';

export const MEDIA_SCHEMA_VERSION = 1;

export function mediaPaths(root, project) {
  const p = paths(root, project);
  return { dir: p.dir, file: path.join(p.dir, 'media.json') };
}

export function emptyMedia(project) {
  return {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    project,
    mediaRevision: 0,
    sources: [],
    evidence: [],
  };
}

function assertProject(project) {
  assertSafeProject(project);
}

function asText(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

export async function loadMedia(root, project) {
  assertProject(project);
  const p = mediaPaths(root, project);
  const data = await readJson(p.file, null);
  if (!data) return emptyMedia(project);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('media.json 不是对象');
  return {
    schemaVersion: Number.isInteger(data.schemaVersion) ? data.schemaVersion : MEDIA_SCHEMA_VERSION,
    project: asText(data.project, 200) || project,
    mediaRevision: Number.isInteger(data.mediaRevision) && data.mediaRevision >= 0 ? data.mediaRevision : 0,
    sources: Array.isArray(data.sources) ? data.sources : [],
    evidence: Array.isArray(data.evidence) ? data.evidence : [],
  };
}

async function saveMedia(root, project, data) {
  const p = mediaPaths(root, project);
  data.schemaVersion = MEDIA_SCHEMA_VERSION;
  data.project = project;
  data.mediaRevision = Number.isInteger(data.mediaRevision) ? data.mediaRevision : 0;
  await writeJsonAtomic(p.file, data);
}

function nextId(prefix, rows) {
  const used = new Set(rows.map((row) => row.id));
  let n = rows.length + 1;
  let id = `${prefix}${String(n).padStart(3, '0')}`;
  while (used.has(id)) id = `${prefix}${String(++n).padStart(3, '0')}`;
  return id;
}

async function comicSourceHash(file, listed) {
  if (listed.type === 'directory') {
    const parts = [];
    for (const page of listed.pages) {
      const bytes = await readFile(path.join(file, page.name));
      parts.push(`${page.index}\t${page.name}\t${bytes.length}\t${sha256Buffer(bytes)}`);
    }
    return { fileHash: `dir:${sha256Buffer(Buffer.from(parts.join('\n')))}`, hashKind: 'directory' };
  }
  return { fileHash: `sha256:${sha256Buffer(await readFile(file))}`, hashKind: 'file' };
}

export async function addComicSource(root, project, input = {}) {
  assertProject(project);
  if (!(await projectExists(root, project))) throw new Error(`项目不存在：${project}`);
  const file = path.resolve(String(input.file || ''));
  const listed = await listComicPages(file);
  const { fileHash, hashKind } = await comicSourceHash(file, listed);
  const data = await loadMedia(root, project);
  const existing = data.sources.find((source) => source.kind === 'comic' && source.fileHash === fileHash);
  if (existing) return { ok: true, duplicate: true, source: existing, mediaRevision: data.mediaRevision };
  const now = new Date().toISOString();
  const source = {
    id: nextId('m_', data.sources),
    kind: 'comic',
    title: asText(input.title, 200) || path.basename(file),
    file,
    fileHash,
    hashKind,
    type: listed.type,
    pageCount: listed.pages.length,
    pages: listed.pages.map((page) => ({ index: page.index, name: page.name, size: page.size })),
    addedAt: now,
  };
  data.sources.push(source);
  data.mediaRevision += 1;
  await saveMedia(root, project, data);
  await audit(root, project, { action: 'media.addComic', sourceId: source.id, fileHash, mediaRevision: data.mediaRevision });
  return { ok: true, duplicate: false, source, mediaRevision: data.mediaRevision };
}

export async function addHongguoSource(root, project, input = {}) {
  assertProject(project);
  if (!(await projectExists(root, project))) throw new Error(`项目不存在：${project}`);
  const seriesId = asText(input.seriesId, 120);
  if (!seriesId) throw new Error('seriesId 必填');
  const data = await loadMedia(root, project);
  const existing = data.sources.find((source) => source.kind === 'hongguo' && source.seriesId === seriesId);
  if (existing) return { ok: true, duplicate: true, source: existing, mediaRevision: data.mediaRevision };
  const source = {
    id: nextId('h_', data.sources),
    kind: 'hongguo',
    seriesId,
    title: asText(input.title, 200) || seriesId,
    coverUrl: asText(input.coverUrl, 1000),
    addedAt: new Date().toISOString(),
  };
  data.sources.push(source);
  data.mediaRevision += 1;
  await saveMedia(root, project, data);
  await audit(root, project, { action: 'media.addHongguo', sourceId: source.id, mediaRevision: data.mediaRevision });
  return { ok: true, duplicate: false, source, mediaRevision: data.mediaRevision };
}

export async function addMediaEvidence(root, project, input = {}) {
  assertProject(project);
  const data = await loadMedia(root, project);
  const source = data.sources.find((row) => row.id === input.sourceId);
  if (!source) throw new Error(`来源不存在：${input.sourceId}`);
  const quote = asText(input.quote, 3000);
  if (!quote) throw new Error('quote 必填');
  const evidence = {
    id: nextId('ev_', data.evidence),
    sourceId: source.id,
    kind: asText(input.kind, 60) || (source.kind === 'comic' ? 'comic-page' : 'hongguo-episode'),
    locator: input.locator && typeof input.locator === 'object' ? input.locator : {},
    quote,
    method: asText(input.method, 40) || 'manual',
    hash: asText(input.hash, 100),
    capturedAt: new Date().toISOString(),
  };
  data.evidence.push(evidence);
  data.mediaRevision += 1;
  await saveMedia(root, project, data);
  await audit(root, project, { action: 'media.addEvidence', evidenceId: evidence.id, sourceId: source.id, mediaRevision: data.mediaRevision });
  return { ok: true, evidence, mediaRevision: data.mediaRevision };
}

export async function removeMediaSource(root, project, sourceId) {
  assertProject(project);
  const data = await loadMedia(root, project);
  const index = data.sources.findIndex((row) => row.id === sourceId);
  if (index < 0) return { ok: false, removed: false, mediaRevision: data.mediaRevision };
  const [removed] = data.sources.splice(index, 1);
  const before = data.evidence.length;
  data.evidence = data.evidence.filter((row) => row.sourceId !== sourceId);
  data.mediaRevision += 1;
  await saveMedia(root, project, data);
  await audit(root, project, {
    action: 'media.removeSource',
    sourceId,
    evidenceRemoved: before - data.evidence.length,
    mediaRevision: data.mediaRevision,
  });
  return { ok: true, removed: true, source: removed, mediaRevision: data.mediaRevision };
}

export async function listMedia(root, project) {
  const data = await loadMedia(root, project);
  return {
    ok: true,
    project,
    mediaRevision: data.mediaRevision,
    sources: data.sources,
    evidence: data.evidence,
  };
}

/**
 * 只读校验媒体证据：来源存在/hash、页/集定位边界。
 * 红果只有元数据、没有本地源文件，标 unverified（不假装在线已验证）。
 * 不写盘；返回逐条状态与汇总。
 */
export async function verifyMediaEvidence(root, project) {
  assertProject(project);
  const data = await loadMedia(root, project);
  const byId = new Map(data.sources.map((source) => [source.id, source]));
  const hashCache = new Map();
  const items = [];
  for (const evidence of data.evidence) {
    const source = byId.get(evidence.sourceId);
    if (!source) {
      items.push({ evidenceId: evidence.id, sourceId: evidence.sourceId, status: 'invalid', reason: '来源不存在' });
      continue;
    }
    if (source.kind === 'comic') {
      let hash = hashCache.get(source.id);
      if (hash === undefined) {
        try {
          const info = await stat(source.file);
          if (source.type === 'directory' || source.hashKind === 'directory') {
            if (!info.isDirectory()) throw new Error('来源不是目录');
            const listed = await listComicPages(source.file);
            if (listed.pages.length !== source.pageCount) throw new Error('目录页数变化');
            const current = await comicSourceHash(source.file, listed);
            hash = { value: current.fileHash };
          } else {
            if (!info.isFile()) throw new Error('来源不是文件');
            hash = { value: `sha256:${sha256Buffer(await readFile(source.file))}` };
          }
        } catch (error) {
          hash = { error: String(error?.message || error) };
        }
        hashCache.set(source.id, hash);
      }
      if (!hash || hash.error) {
        items.push({ evidenceId: evidence.id, sourceId: source.id, status: 'stale', reason: `来源不可读：${hash?.error || 'missing'}` });
        continue;
      }
      if (hash.value !== source.fileHash) {
        items.push({ evidenceId: evidence.id, sourceId: source.id, status: 'stale', reason: '来源 hash 变化' });
        continue;
      }
      const locator = evidence.locator || {};
      const page = Number(locator.page);
      if (!Number.isInteger(page) || page < 0 || page >= source.pageCount) {
        items.push({ evidenceId: evidence.id, sourceId: source.id, status: 'invalid', reason: `页码越界：${locator.page}` });
        continue;
      }
      if (locator.panel !== undefined && (!Number.isInteger(Number(locator.panel)) || Number(locator.panel) < 0)) {
        items.push({ evidenceId: evidence.id, sourceId: source.id, status: 'invalid', reason: `格号无效：${locator.panel}` });
        continue;
      }
      items.push({ evidenceId: evidence.id, sourceId: source.id, status: 'valid', reason: '文件 hash/页码通过' });
      continue;
    }
    if (source.kind === 'hongguo') {
      const episode = evidence.locator?.episode;
      if (episode !== undefined && (!Number.isInteger(Number(episode)) || Number(episode) < 1)) {
        items.push({ evidenceId: evidence.id, sourceId: source.id, status: 'invalid', reason: `集号无效：${episode}` });
        continue;
      }
      items.push({ evidenceId: evidence.id, sourceId: source.id, status: 'unverified', reason: '红果只有元数据；在线内容未本地验证' });
      continue;
    }
    items.push({ evidenceId: evidence.id, sourceId: source.id, status: 'unverified', reason: '未知来源类型' });
  }
  const summary = {
    total: items.length,
    valid: items.filter((item) => item.status === 'valid').length,
    stale: items.filter((item) => item.status === 'stale').length,
    invalid: items.filter((item) => item.status === 'invalid').length,
    unverified: items.filter((item) => item.status === 'unverified').length,
  };
  return {
    ok: summary.stale === 0 && summary.invalid === 0,
    project,
    mediaRevision: data.mediaRevision,
    summary,
    items,
  };
}
