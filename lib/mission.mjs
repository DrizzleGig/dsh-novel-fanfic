// 章节任务卡（Chapter Mission Card）—— v0.2.0 新增的唯一功能。
//
// 它是「写之前 5 分钟想清楚这一章要干什么」的便签，不是契约、不是 canon、不是 beat 的决策账本：
//   - 只落一个文件：<项目>/project/chapters/<章>/mission.json
//   - 不进 canon 六桶；删掉不影响契约编译（只是少一段「意图」注入）
//   - 唯一进契约的地方是 openQuestions → 契约的「不确定」段（单向，不回写）
//
// 字段与 docs/小说插件系列-fanfic-v0.2.0-设计与开发方案.md §4.2 一致。

import path from 'node:path';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './canon-store.mjs';

export const MISSION_SCHEMA_VERSION = 1;
export const MISSION_BEATS_LIMIT = 7;

export const MISSION_FIELDS = Object.freeze([
  'title', 'pov', 'placeTime', 'goal', 'arc', 'anchors', 'readerExpectation',
  'beats', 'avoid', 'openQuestions', 'targetChars', 'status', 'sourceChapter', 'canonRefs',
]);

export function missionDir(root, project) {
  return path.join(root, '.dsh-novel-fanfic', project, 'project', 'chapters');
}

export function missionFile(root, project, chapter) {
  return path.join(missionDir(root, project), String(chapter), 'mission.json');
}

function asStrings(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function asText(value, limit = 2000) {
  return String(value ?? '').trim().slice(0, limit);
}

/** 把外部 patch 归一化：只保留已知字段，类型不对就当没写。 */
export function normalizeMission(chapter, patch = {}, base = null) {
  const merged = { ...(base || {}) };
  const setIf = (key, value) => {
    if (value !== undefined) merged[key] = value;
  };
  if (patch.title !== undefined) setIf('title', asText(patch.title, 80));
  if (patch.pov !== undefined) setIf('pov', asText(patch.pov, 80));
  if (patch.placeTime !== undefined) setIf('placeTime', asText(patch.placeTime, 120));
  if (patch.goal !== undefined) setIf('goal', asText(patch.goal, 600));
  if (patch.arc !== undefined) setIf('arc', asText(patch.arc, 200));
  if (patch.readerExpectation !== undefined) setIf('readerExpectation', asText(patch.readerExpectation, 400));
  if (patch.anchors !== undefined) setIf('anchors', asStrings(patch.anchors, 10));
  if (patch.beats !== undefined) setIf('beats', asStrings(patch.beats, MISSION_BEATS_LIMIT));
  if (patch.avoid !== undefined) setIf('avoid', asStrings(patch.avoid, 10));
  if (patch.openQuestions !== undefined) setIf('openQuestions', asStrings(patch.openQuestions, 10));
  if (patch.targetChars !== undefined) {
    const n = Number(patch.targetChars);
    setIf('targetChars', Number.isFinite(n) && n > 0 ? Math.round(n) : null);
  }
  if (patch.status !== undefined) {
    const status = String(patch.status || '').trim();
    setIf('status', ['draft', 'ready', 'done'].includes(status) ? status : 'draft');
  }
  if (patch.sourceChapter !== undefined || patch.sourceContext?.sourceChapter !== undefined) {
    setIf('sourceChapter', asText(patch.sourceChapter ?? patch.sourceContext?.sourceChapter, 40));
  }
  if (patch.canonRevision !== undefined || patch.sourceContext?.canonRevision !== undefined) {
    const n = Number(patch.canonRevision ?? patch.sourceContext?.canonRevision);
    setIf('canonRevision', Number.isInteger(n) ? n : null);
  }
  if (patch.canonRefs !== undefined) {
    const rows = Array.isArray(patch.canonRefs) ? patch.canonRefs : [];
    setIf('canonRefs', rows
      .filter((row) => row && typeof row === 'object' && row.bucket && row.id)
      .map((row) => ({
        bucket: asText(row.bucket, 40),
        id: asText(row.id, 60),
        sourceChapter: row.sourceChapter ? asText(row.sourceChapter, 40) : null,
      }))
      .slice(0, 30));
  }
  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    chapter: String(chapter),
    ...merged,
    title: merged.title || '',
    pov: merged.pov || '',
    placeTime: merged.placeTime || '',
    goal: merged.goal || '',
    arc: merged.arc || '',
    readerExpectation: merged.readerExpectation || '',
    anchors: merged.anchors || [],
    beats: merged.beats || [],
    avoid: merged.avoid || [],
    openQuestions: merged.openQuestions || [],
    targetChars: merged.targetChars ?? null,
    status: merged.status || 'draft',
    sourceChapter: merged.sourceChapter || '',
    canonRevision: merged.canonRevision ?? null,
    canonRefs: merged.canonRefs || [],
    updatedAt: merged.updatedAt || null,
    revision: Number.isInteger(merged.revision) ? merged.revision : 0,
  };
}

export async function loadMission(root, project, chapter) {
  const file = missionFile(root, project, chapter);
  const data = await readJson(file, null);
  if (!data) return null;
  return normalizeMission(chapter, data, data);
}

/** 读全项目所有任务卡（按章 id）——面板与契约编译都只读这一份。 */
export async function loadMissions(root, project) {
  const dir = missionDir(root, project);
  const out = {};
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const mission = await loadMission(root, project, entry.name);
    if (mission) out[entry.name] = mission;
  }
  return out;
}

export async function saveMission(root, project, chapter, patch = {}) {
  const id = String(chapter || '').trim();
  if (!id) throw new Error('任务卡需要章 id');
  const file = missionFile(root, project, id);
  const base = await loadMission(root, project, id);
  const next = normalizeMission(id, patch, base);
  next.revision = (base?.revision || 0) + 1;
  next.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, next);
  return next;
}

export async function clearMission(root, project, chapter) {
  const id = String(chapter || '').trim();
  if (!id) throw new Error('任务卡需要章 id');
  const file = missionFile(root, project, id);
  try {
    await rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 人类可读的一张卡（CLI / 面板文案共用）。 */
export function describeMission(mission) {
  if (!mission) return '这一章还没有任务卡。';
  const lines = [`任务卡 ${mission.chapter}${mission.title ? `　${mission.title}` : ''}（${mission.status}）`];
  if (mission.goal) lines.push(`  要干：${mission.goal}`);
  if (mission.arc) lines.push(`  情绪：${mission.arc}`);
  if (mission.pov) lines.push(`  视角：${mission.pov}`);
  if (mission.placeTime) lines.push(`  时间地点：${mission.placeTime}`);
  if (mission.anchors?.length) lines.push(`  原著锚点：${mission.anchors.join('；')}`);
  if (mission.readerExpectation) lines.push(`  读者期待：${mission.readerExpectation}`);
  if (mission.beats?.length) {
    lines.push(`  节拍 ${mission.beats.length} 条：`);
    mission.beats.forEach((beat, i) => lines.push(`    ${i + 1}. ${beat}`));
  }
  if (mission.avoid?.length) lines.push(`  避开：${mission.avoid.join('；')}`);
  if (mission.openQuestions?.length) {
    lines.push(`  开放问题 ${mission.openQuestions.length} 条（会进契约的「不确定」段）：`);
    mission.openQuestions.forEach((q, i) => lines.push(`    ${i + 1}. ${q}`));
  }
  if (mission.targetChars) lines.push(`  目标字数：${mission.targetChars}`);
  if (Number.isInteger(mission.canonRevision)) lines.push(`  写卡时 canon 版本：v${mission.canonRevision}`);
  return lines.join('\n');
}
