// 人物形象资产：.dsh-novel-fanfic/<project>/avatars.json + assets/avatars/。
//
// 设计口径见 docs/方案-fanfic-0.4.x-2026-11-26.md §4：
//   - 图片是视觉参考，不是 canon；avatar 变更只 bump avatars.json.assetRevision，
//     不 bump project.json.revision，不使场景契约失效。
//   - 只存作者确认的图；候选只在 UI，不落盘。
//   - 单图 256×256 目标、≤512KB；Host 校验魔数/尺寸，不信任客户端 MIME。
//   - 文件内不存绝对路径；project/characterId 必须是单段安全名。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { audit, paths, projectExists, readJson, writeJsonAtomic } from './canon-store.mjs';
import { sha256Buffer } from './hash.mjs';
import { assertSafeProject } from './project-name.mjs';

export const AVATAR_SCHEMA_VERSION = 1;
export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_MAX_DIMENSION = 512;
export const AVATAR_STATUS = ['none', 'candidate', 'confirmed', 'rejected', 'stale'];
export const AVATAR_SOURCE_KINDS = ['bangumi', 'anilist', 'kitsu', 'vndb', 'web-image', 'upload'];

const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

export function avatarPaths(root, project) {
  const p = paths(root, project);
  return {
    dir: p.dir,
    file: path.join(p.dir, 'avatars.json'),
    assets: path.join(p.dir, 'assets', 'avatars'),
  };
}

export function emptyAvatars(project) {
  return {
    schemaVersion: AVATAR_SCHEMA_VERSION,
    project,
    assetRevision: 0,
    works: [],
    characters: {},
  };
}

function assertProject(project) {
  assertSafeProject(project);
}

function assertCharacterId(characterId) {
  if (typeof characterId !== 'string' || !SAFE_NAME.test(characterId)) {
    throw new Error('characterId 必须是单段安全名（字母/数字/._-）');
  }
}

/** 手改 avatars.json 也不能把删除/读取带到项目目录外。 */
function safeProjectFile(projectDir, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const base = path.resolve(projectDir);
  const abs = path.resolve(base, rel);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

function asString(value, max = 2000) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function sanitizeSource(source) {
  const sourceObject = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const kind = AVATAR_SOURCE_KINDS.includes(sourceObject.kind) ? sourceObject.kind : 'upload';
  return {
    kind,
    workSourceId: asString(sourceObject.workSourceId, 120),
    characterSourceId: asString(sourceObject.characterSourceId, 120),
    pageUrl: asString(sourceObject.pageUrl),
    imageUrl: asString(sourceObject.imageUrl),
    query: asString(sourceObject.query, 300),
    credit: asString(sourceObject.credit, 300),
    rights: asString(sourceObject.rights, 80) || 'local-reference-only',
    fetchedAt: asString(sourceObject.fetchedAt, 40) || new Date().toISOString(),
  };
}

function pngInfo(buffer) {
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', ext: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegInfo(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < buffer.length) {
    if (buffer[at] !== 0xff) { at += 1; continue; }
    let marker = buffer[at + 1];
    while (marker === 0xff) { at += 1; marker = buffer[at + 1]; }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { at += 2; continue; }
    if (marker >= 0xd0 && marker <= 0xd7) { at += 2; continue; }
    const length = buffer.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buffer.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (at + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(at + 5);
      const width = buffer.readUInt16BE(at + 7);
      return { mime: 'image/jpeg', ext: 'jpg', width, height };
    }
    at += 2 + length;
  }
  return null;
}

function webpInfo(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  if (chunk === 'VP8 ') {
    const at = 20;
    if (buffer[at + 3] !== 0x9d || buffer[at + 4] !== 0x01 || buffer[at + 5] !== 0x2a) return null;
    const width = (buffer[at + 6] | (buffer[at + 7] << 8)) & 0x3fff;
    const height = (buffer[at + 8] | (buffer[at + 9] << 8)) & 0x3fff;
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return null;
    const b = buffer;
    const width = 1 + (((b[21] | (b[22] << 8)) & 0x3fff));
    const height = 1 + ((((b[22] >> 6) | (b[23] << 2) | (b[24] << 10)) & 0x3fff));
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  return null;
}

/** 只认 PNG/JPEG/WebP；返回真实 MIME/扩展名/宽高，失败返回 null。不执行 SVG。 */
export function imageInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  return pngInfo(buffer) || jpegInfo(buffer) || webpInfo(buffer);
}

export async function loadAvatars(root, project) {
  assertProject(project);
  const p = avatarPaths(root, project);
  const data = await readJson(p.file, null);
  if (!data) return emptyAvatars(project);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('avatars.json 不是对象');
  const out = {
    schemaVersion: Number.isInteger(data.schemaVersion) ? data.schemaVersion : AVATAR_SCHEMA_VERSION,
    project: asString(data.project, 200) || project,
    assetRevision: Number.isInteger(data.assetRevision) && data.assetRevision >= 0 ? data.assetRevision : 0,
    works: Array.isArray(data.works) ? data.works : [],
    characters: data.characters && typeof data.characters === 'object' && !Array.isArray(data.characters) ? data.characters : {},
  };
  return out;
}

async function writeBufferAtomic(file, buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, buffer);
  await rename(tmp, file);
}

function normalizeBase64(input) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const comma = text.indexOf(',');
  return comma >= 0 ? text.slice(comma + 1) : text;
}

/**
 * 确认一张头像：写文件 + avatars.json；author 已确认才调用。
 * input: { characterId, dataBase64 | buffer, source?, crop?, name? }
 */
export async function setAvatar(root, project, input = {}) {
  assertProject(project);
  assertCharacterId(input.characterId);
  if (!(await projectExists(root, project))) throw new Error(`项目不存在：${project}`);

  const buffer = Buffer.isBuffer(input.buffer)
    ? input.buffer
    : Buffer.from(normalizeBase64(input.dataBase64), 'base64');
  if (!buffer.length) throw new Error('头像数据为空');
  if (buffer.length > AVATAR_MAX_BYTES) throw new Error(`头像超过 ${AVATAR_MAX_BYTES} 字节`);
  const info = imageInfo(buffer);
  if (!info) throw new Error('头像只支持 PNG/JPEG/WebP（不执行 SVG）');
  if (!info.width || !info.height || info.width > AVATAR_MAX_DIMENSION || info.height > AVATAR_MAX_DIMENSION) {
    throw new Error(`头像尺寸无效或超过 ${AVATAR_MAX_DIMENSION}`);
  }
  if (info.width !== info.height) throw new Error('头像必须是正方形（宽高必须相等）');
  const p = avatarPaths(root, project);
  const data = await loadAvatars(root, project);
  const old = data.characters[input.characterId];
  const hash = sha256Buffer(buffer);
  const filename = `${input.characterId}-${hash}.${info.ext}`;
  const file = path.join(p.assets, filename);
  const rel = path.relative(p.dir, file).split(path.sep).join('/');

  await writeBufferAtomic(file, buffer);

  const now = new Date().toISOString();
  const record = {
    status: 'confirmed',
    name: asString(input.name, 120),
    file: rel,
    hash: `sha256:${hash}`,
    mime: info.mime,
    width: info.width,
    height: info.height,
    source: sanitizeSource(input.source),
    crop: input.crop && typeof input.crop === 'object' ? {
      x: Number(input.crop.x) || 0,
      y: Number(input.crop.y) || 0,
      size: Number(input.crop.size) || info.width,
    } : { x: 0, y: 0, size: info.width },
    confirmedBy: 'author',
    confirmedAt: now,
    updatedAt: now,
  };
  data.characters[input.characterId] = record;
  data.assetRevision += 1;
  data.schemaVersion = AVATAR_SCHEMA_VERSION;
  data.project = project;

  try {
    await writeJsonAtomic(p.file, data);
  } catch (error) {
    await rm(file, { force: true }).catch(() => {});
    throw error;
  }
  await audit(root, project, {
    action: 'avatar.set',
    characterId: input.characterId,
    hash: record.hash,
    file: rel,
    source: record.source.kind,
    assetRevision: data.assetRevision,
  });

  if (old && old.file && old.file !== rel) {
    const oldPath = safeProjectFile(p.dir, old.file);
    if (oldPath) await rm(oldPath, { force: true }).catch(() => {});
  }
  return { ok: true, avatar: record, assetRevision: data.assetRevision, file: rel };
}

export async function removeAvatar(root, project, characterId) {
  assertProject(project);
  assertCharacterId(characterId);
  const p = avatarPaths(root, project);
  const data = await loadAvatars(root, project);
  const old = data.characters[characterId];
  if (!old) return { ok: true, removed: false, assetRevision: data.assetRevision };
  const oldPath = old.file ? safeProjectFile(p.dir, old.file) : null;
  data.characters[characterId] = { status: 'none', updatedAt: new Date().toISOString() };
  data.assetRevision += 1;
  data.schemaVersion = AVATAR_SCHEMA_VERSION;
  data.project = project;
  await writeJsonAtomic(p.file, data);
  if (oldPath) await rm(oldPath, { force: true }).catch(() => {});
  await audit(root, project, { action: 'avatar.remove', characterId, assetRevision: data.assetRevision });
  return { ok: true, removed: true, assetRevision: data.assetRevision };
}

/** 只读：取已确认头像的 base64；文件缺失/hash 不符返回 stale，不写盘。 */
export async function resolveAvatar(root, project, characterId) {
  assertProject(project);
  assertCharacterId(characterId);
  const p = avatarPaths(root, project);
  const data = await loadAvatars(root, project);
  const record = data.characters[characterId];
  if (!record || record.status !== 'confirmed' || !record.file) {
    return { ok: false, reason: 'none' };
  }
  let buffer;
  try {
    const file = safeProjectFile(p.dir, record.file);
    if (!file) return { ok: false, reason: 'invalid', avatar: record };
    buffer = await readFile(file);
  } catch {
    return { ok: false, reason: 'missing', avatar: record };
  }
  const actual = `sha256:${sha256Buffer(buffer)}`;
  if (actual !== record.hash) return { ok: false, reason: 'stale', avatar: record };
  return {
    ok: true,
    base64: buffer.toString('base64'),
    mime: record.mime,
    hash: record.hash,
    width: record.width,
    height: record.height,
    assetRevision: data.assetRevision,
  };
}

export function avatarSummary(avatars) {
  const characters = Object.values(avatars?.characters || {});
  const count = (status) => characters.filter((row) => row?.status === status).length;
  return {
    total: characters.length,
    confirmed: count('confirmed'),
    candidate: count('candidate'),
    none: count('none'),
    stale: count('stale'),
    assetRevision: avatars?.assetRevision || 0,
  };
}
