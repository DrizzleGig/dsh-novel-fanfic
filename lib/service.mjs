// dsh-novel-fanfic 只读服务（service key: novelFanfic）
//
// 契约见 docs/contract.md 与《五插件协作契约 v1.1（正文 v1.2）》§3。四条硬规则：
//   1. 第一参数是**绝对** cwd；相对路径直接失败，不 resolve、不回落 process.cwd()
//   2. **永不读夹具**：本文件只走 loadProject / loadProjectCanon（source: canon），
//      夹具只在 fixture 数据源里出现，服务绝不继承那条回落（否则 conductor 会拿
//      夹具契约去验收真书）
//   3. revision 与内容来自**同一次读盘**（loadProject 一次拿 project + 六个桶）
//   4. 只读：这里没有任何 save* / import / waive
//
// 返回形状：公共信封 { status, code, message, data, source }（契约 §3.1）。
// beat/fade/voice 返回裸对象，conductor 的适配层各自吸收；fanfic 是后做的，
// 按契约走信封，并在 conductor 的 adapters/fanfic.js 里对应实现。

import path from 'node:path';
import { loadProject, paths as fanficPaths, projectExists } from './canon-store.mjs';
import { loadProjectCanon } from './canon-adapter.mjs';
import { compileContract } from './compiler.mjs';
import { loadDeltas, deltaFile } from './deltas.mjs';
import { loadDeclarations, declarationFile } from './declarations.mjs';

export const PLUGIN = 'dsh-novel-fanfic';
export const SERVICE_VERSION = 1;
export const SERVICE_DIR = '.dsh-novel-fanfic';
export const CAPABILITIES = Object.freeze([
  'fanfic.contract',
  'fanfic.canon',
  'fanfic.status',
  'fanfic.revision',
]);

const ENVELOPE_PLUGIN = 'fanfic';

function envelope({ status, code = null, message = null, data = null, source = null }) {
  return { status, code, message, data, source: source || { plugin: ENVELOPE_PLUGIN } };
}

function skipped(code, message, extra = {}) {
  return envelope({ status: 'skipped', code, message, data: null, ...extra });
}

function failed(code, message) {
  return envelope({ status: 'failed', code, message });
}

/** 绝对 cwd 校验：不接受相对路径，也不做 realpath 猜测。 */
function assertAbsCwd(cwd) {
  const text = String(cwd || '');
  if (!text) return 'MISSING_CWD';
  if (!path.isAbsolute(text)) return 'BAD_DIR';
  return null;
}

function metaOf(data) {
  return {
    plugin: ENVELOPE_PLUGIN,
    cwd: data.cwd,
    project: data.project,
    revision: data.revision ?? null,
    generated_at: new Date().toISOString(),
    stale: false,
  };
}

/** 项目名必须是单个目录名，防止 `..` 之类把路径带出 .dsh-novel-fanfic/。 */
function normalizeProject(project) {
  const text = String(project || '').trim();
  if (!text) return null;
  if (text.includes('/') || text.includes('\\') || text === '.' || text === '..') return null;
  return text;
}

/**
 * 列出 cwd 下的项目（只读）。服务允许省略 project，但只在**唯一**时自动选中；
 * 多于一个时报歧义，让调用方显式指定（避免串书）。
 */
async function resolveProject(cwd, project) {
  const wanted = normalizeProject(project);
  if (wanted) {
    const exists = await projectExists(cwd, wanted);
    return exists
      ? { project: wanted }
      : { error: skipped('NO_PROJECT', `这个工作区没有同人项目：${wanted}`, { source: { plugin: ENVELOPE_PLUGIN, cwd, project: wanted } }) };
  }
  const base = path.join(cwd, SERVICE_DIR);
  let entries = [];
  try {
    const { readdir } = await import('node:fs/promises');
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { error: skipped('NO_PROJECT', '这个工作区还没有 .dsh-novel-fanfic/', { source: { plugin: ENVELOPE_PLUGIN, cwd } }) };
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await projectExists(cwd, entry.name)) ids.push(entry.name);
  }
  if (ids.length === 1) return { project: ids[0] };
  if (!ids.length) {
    return { error: skipped('NO_PROJECT', '这个工作区还没有同人项目', { source: { plugin: ENVELOPE_PLUGIN, cwd } }) };
  }
  return {
    error: skipped('PROJECT_AMBIGUOUS', `这个工作区有多个同人项目，请显式指定 project：${ids.join('、')}`, {
      source: { plugin: ENVELOPE_PLUGIN, cwd },
    }),
  };
}

export function identity(version = '0.0.0') {
  return {
    plugin: PLUGIN,
    version: String(version),
    service_version: SERVICE_VERSION,
    capabilities: [...CAPABILITIES],
    dir: SERVICE_DIR,
    readOnly: true,
  };
}

export async function getRevision({ cwd, project } = {}) {
  const bad = assertAbsCwd(cwd);
  if (bad) return failed(bad, 'cwd 必须是工作区根的绝对路径');
  try {
    const resolved = await resolveProject(cwd, project);
    if (resolved.error) return resolved.error;
    const p = fanficPaths(cwd, resolved.project);
    const { readRevision } = await import('./canon-store.mjs');
    const rev = await readRevision(cwd, resolved.project);
    if (!rev.found) return skipped('NO_PROJECT', `没有这个项目：${resolved.project}`);
    return envelope({
      status: 'ok',
      data: { project: resolved.project, revision: rev.revision, updatedAt: rev.updatedAt, revisionDrift: rev.revDrift },
      source: { plugin: ENVELOPE_PLUGIN, cwd, project: resolved.project, revision: rev.revision, generated_at: new Date().toISOString(), stale: false, dir: p.dir },
    });
  } catch (error) {
    return failed('INTERNAL', String(error?.message || error));
  }
}

export async function getStatus({ cwd, project } = {}) {
  const bad = assertAbsCwd(cwd);
  if (bad) return failed(bad, 'cwd 必须是工作区根的绝对路径');
  try {
    const resolved = await resolveProject(cwd, project);
    if (resolved.error) return resolved.error;
    const loaded = await loadProject(cwd, resolved.project);
    const canon = loaded.canon || {};
    const buckets = {};
    for (const bucket of ['characters', 'facts', 'worldRules', 'secrets', 'addresses']) {
      const list = (canon[bucket] || []).filter((row) => row && row.status !== 'rejected');
      buckets[bucket] = {
        confirmed: list.filter((row) => row.status === 'confirmed').length,
        total: list.length,
      };
    }
    const contradictions = (canon.contradictions || []).filter((row) => row && row.status === 'open');
    const pending = [];
    for (const bucket of ['characters', 'facts', 'worldRules', 'secrets', 'addresses']) {
      for (const row of canon[bucket] || []) {
        if (row && row.status === 'pending') pending.push(bucket);
      }
    }
    let deltas = { premise: '', items: [] };
    let declarations = null;
    try {
      deltas = await loadDeltas(deltaFile(loaded.paths.dir));
    } catch {
      // 本作设定文件坏了不该让服务整体失败：状态里如实说没有。
    }
    try {
      declarations = await loadDeclarations(declarationFile(loaded.paths.dir));
    } catch {
      declarations = null;
    }
    const chapters = loaded.index?.chapters || [];
    const data = {
      cwd,
      project: resolved.project,
      revision: loaded.project.revision,
      revisionDrift: Boolean(loaded.project.revDrift),
      updatedAt: loaded.project.updatedAt || null,
      title: loaded.project.title || resolved.project,
      imported: Boolean(loaded.project.sourceId),
      currentChapter: loaded.project.currentChapter || null,
      chapters: chapters.length,
      chars: chapters.reduce((sum, ch) => sum + (ch.chars || 0), 0),
      buckets,
      contradictions: { open: contradictions.length, total: (canon.contradictions || []).length },
      pending: pending.length,
      deltas: { premise: deltas.premise || '', items: (deltas.items || []).length },
      declarations: declarations
        ? {
          auRules: (declarations.auRules || []).length,
          headcanon: (declarations.headcanonSignatures || []).length,
          typos: Object.keys(declarations.typos || {}).length,
        }
        : null,
      exportsForbidden: Array.isArray(loaded.project?.exports?.forbidden) ? loaded.project.exports.forbidden.length : 0,
      exportsRevised: loaded.project?.exports?.revision ?? null,
    };
    return envelope({ status: 'ok', data, source: metaOf(data) });
  } catch (error) {
    return failed('INTERNAL', String(error?.message || error));
  }
}

export async function getCanonSummary({ cwd, project } = {}) {
  const bad = assertAbsCwd(cwd);
  if (bad) return failed(bad, 'cwd 必须是工作区根的绝对路径');
  try {
    const resolved = await resolveProject(cwd, project);
    if (resolved.error) return resolved.error;
    const loaded = await loadProject(cwd, resolved.project);
    const canon = loaded.canon || {};
    const buckets = {};
    for (const bucket of ['characters', 'facts', 'worldRules', 'secrets', 'addresses']) {
      const list = (canon[bucket] || []).filter((row) => row && row.status !== 'rejected');
      buckets[bucket] = {
        confirmed: list.filter((row) => row.status === 'confirmed').length,
        total: list.length,
      };
    }
    const contradictions = (canon.contradictions || []).filter((row) => row && row.status === 'open');
    const data = {
      cwd,
      project: resolved.project,
      revision: loaded.project.revision,
      buckets,
      contradictions: contradictions.length,
    };
    return envelope({ status: 'ok', data, source: metaOf(data) });
  } catch (error) {
    return failed('INTERNAL', String(error?.message || error));
  }
}

export async function getContract({ cwd, project, chapter } = {}) {
  const bad = assertAbsCwd(cwd);
  if (bad) return failed(bad, 'cwd 必须是工作区根的绝对路径');
  try {
    const resolved = await resolveProject(cwd, project);
    if (resolved.error) return resolved.error;
    const wantChapter = String(chapter || '').trim();
    if (!wantChapter) return failed('BAD_CHAPTER', 'getContract 需要 chapter');
    let loaded;
    try {
      loaded = await loadProjectCanon(cwd, resolved.project);
    } catch (error) {
      const message = String(error?.message || error);
      if (/还没有导入原著/.test(message)) return skipped('NO_SOURCE', message);
      if (/没有可用的章节|还没有足够的事实/.test(message)) return skipped('NO_CANON', message);
      throw error;
    }
    const scene = (loaded.canon.scenes || []).find((row) => row.chapter === wantChapter || row.id === wantChapter);
    if (!scene) {
      return skipped('NO_CHAPTER', `没有这一章的契约：${wantChapter}（可用 ${(loaded.canon.scenes || []).map((row) => row.chapter).join('、') || '（无）'}）`);
    }
    const compiled = compileContract(scene, loaded.canon);
    // sections 就是编译器内部那份 tags：markdown 由它渲染，所以「段之和 = 全文」天然成立。
    const data = {
      cwd,
      project: resolved.project,
      chapter: scene.chapter,
      scene: scene.id,
      markdown: compiled.markdown,
      chars: compiled.chars,
      hash: compiled.hash,
      sections: compiled.tags,
      tags: compiled.tags,
      sectionOrder: Object.keys(compiled.tags),
      revision: loaded.project.revision,
      generated_at: new Date().toISOString(),
    };
    return envelope({ status: 'ok', data, source: metaOf(data) });
  } catch (error) {
    return failed('INTERNAL', String(error?.message || error));
  }
}

/** 组装 ctx.provide 用的对象；emitter 由 index.js 传入（真实写盘后发事件）。 */
export function createService({ version, subscribe }) {
  return {
    identity: () => identity(version),
    getStatus,
    getRevision,
    getContract,
    getCanonSummary,
    onDidChange: (cb) => (typeof subscribe === 'function' ? subscribe(cb) : () => {}),
  };
}
