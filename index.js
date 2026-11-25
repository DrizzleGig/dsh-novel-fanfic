// DSH 插件入口：把 canon / 契约编译器 / 检查器 / lookup 接成 fic_* 工具。
// 默认关闭：工具注册时带 when，只有在本会话执行过 `/fic on` 之后才可见。
// 设计约束见 docs/小说插件系列-fanfic-v0.1.0-步骤1-验收.md 与 README「插件」小节。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import { loadFixture } from './lib/canon.mjs';
import { loadProjectCanon } from './lib/canon-adapter.mjs';
import { runCheck, formatFindings, applyWaivers, GATE_DETECTORS } from './lib/checker.mjs';
import { retrieve } from './lib/lookup.mjs';
import { compileContract, compileAll, contractDrift } from './lib/compiler.mjs';
import { loadProject, chapterBody, paths, readJson, writeJsonAtomic, saveCanon, audit, CANON_FILES, commitProject, readRevision } from './lib/canon-store.mjs';
import { buildExports } from './lib/exports.mjs';
import { createService } from './lib/service.mjs';
import { loadMission, loadMissions, saveMission, clearMission, describeMission } from './lib/mission.mjs';
import { ingestFile, readSourceText, splitChapters, bookTitleOf, MAX_BYTES } from './lib/ingest.mjs';
import { sha256 } from './lib/hash.mjs';
import { confirmEntries, rejectEntries, resolveContradiction } from './lib/proposals.mjs';
import { buildBook } from './lib/views.mjs';
import { avatarSummary, loadAvatars, removeAvatar, resolveAvatar, setAvatar } from './lib/avatars.mjs';
import { listCharacters, matchCharacters, searchWebImages, searchWorks } from './lib/avatar-sources.mjs';
import { fetchImageBase64 } from './lib/avatar-fetch.mjs';
import { hongguoDanmaku, hongguoEpisodes, hongguoSearch, hongguoSeries } from './lib/hongguo.mjs';
import { listComicPages, ocrComicPages, detectComicPanels, ocrComicPanels, extractComicPage } from './lib/comic.mjs';
import { analyzeBook, confirmedCanon } from './lib/analysis.mjs';
import { addComicSource, addHongguoSource, addMediaEvidence, listMedia, removeMediaSource, verifyMediaEvidence } from './lib/media.mjs';
import {
  loadDeclarations, saveDeclarations, declarationFile,
  addAuRule, removeAuRule, addHeadcanon, removeHeadcanon, addTypo, removeTypo,
} from './lib/declarations.mjs';
import {
  loadDeltas, saveDeltas, deltaFile, emptyDeltas, addDelta, removeDelta, setPremise,
  describeDelta, DELTA_KINDS,
} from './lib/deltas.mjs';

export const name = 'novel-fanfic';
export const inject = ['tools', 'commands'];

const DEFAULTS = {
  root: process.cwd(),
  project: 'fixture-a',
  fixture: 'dsh-novel-fanfic/fixtures/fixture-a',
};

/** 把插件内部的参数字段简写编译成宿主和模型 API 都接受的 JSON Schema。 */
function parameterSchema(fields) {
  const properties = {};
  const required = [];
  for (const [name, definition] of Object.entries(fields)) {
    const { required: isRequired, ...property } = definition;
    properties[name] = property;
    if (isRequired === true) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

/** 从 start 向上找含夹具的开发 checkout（cordis.patch.yml 的 root 没生效时的兜底）。 */
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'dsh-novel-fanfic', 'fixtures', 'fixture-a', 'ground-truth.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 插件配置：root 是工作目录（默认进程 cwd），project 是 `.dsh-novel-fanfic/<project>/`，
 * fixture 是夹具目录（相对 root）。v0.1 的场景元数据仍来自夹具 ground-truth。
 */
export function apply(ctx, config = {}) {
  const cfg = {
    ...DEFAULTS,
    ...config,
    root: config.root
      || process.env.DSH_NOVEL_FANFIC_ROOT
      || findRepoRoot(process.cwd())
      || process.cwd(),
  };
  const enabledAgents = new Set();
  const optedOut = new Set();

  // 开关持久化：/fic on|off 写一份偏好文件，DSH 重启后新会话不必再打一遍。
  // 语义：本会话显式 on/off 优先；没表态的会话按持久默认值走。
  const stateDir = cfg.stateDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'novel-fanfic');
  const prefFile = path.join(stateDir, 'prefs.json');
  const preference = { enabled: false, project: null };
  try {
    const saved = JSON.parse(readFileSync(prefFile, 'utf8'));
    if (saved && typeof saved.enabled === 'boolean') preference.enabled = saved.enabled;
    if (saved && typeof saved.project === 'string' && saved.project) preference.project = saved.project;
  } catch {
    // 没有偏好文件就用关闭默认，不打扰用户。
  }
  // 进程启动时的默认值：/fic on|off 只把选择写进文件，供下次启动继承；
  // 本进程内改它会让别的会话跟着变，所以冻结成 bootEnabled。
  const bootEnabled = preference.enabled === true;
  const savePreference = (patch = {}) => {
    if (typeof patch === 'boolean') preference.enabled = patch;
    else if (patch && typeof patch.enabled === 'boolean') preference.enabled = patch.enabled;
    if (patch && typeof patch.project === 'string' && patch.project) preference.project = patch.project;
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        prefFile,
        `${JSON.stringify({ enabled: preference.enabled, project: preference.project, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // 写不进去不影响本次会话：开关仍在内存里生效。
    }
  };

  const keyOf = (agent) => {
    if (!agent) return '';
    return agent.session?.id ?? agent.id ?? '';
  };
  /** 装了 conductor 它就是总开关：只看它接管没接管，本插件自己的 /fic on 降级为独立模式的偏好。 */
  const conductorInstalled = () => {
    try {
      return typeof ctx.get?.('novelConductor')?.isDriving === 'function';
    } catch {
      return false;
    }
  };
  const effectiveOn = (manualOn, key) => {
    if (!conductorInstalled()) return manualOn;
    if (!key) return false;
    try {
      return ctx.get('novelConductor').isDriving(key) === true;
    } catch {
      return false;
    }
  };
  const isOn = (agent) => {
    const key = keyOf(agent);
    if (!key) return false;
    if (enabledAgents.has(key)) return true;
    if (optedOut.has(key)) return false;
    return bootEnabled;;
  };
  const ctxOf = (args = {}) => {
    const root = args.root ? path.resolve(String(args.root)) : cfg.root;
    // 夹具默认在「工作目录/dsh-novel-fanfic/fixtures/fixture-a」（开发 checkout），
    // 装成 bundle 后工作目录里没有它，就回落到包内的 fixtures/fixture-a。
    const configuredFixture = path.resolve(root, cfg.fixture);
    const fixtureDir = existsSync(configuredFixture)
      ? configuredFixture
      : path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fixture-a');
    return {
      root,
      project: String(args.project || preference.project || cfg.project),
      fixtureDir,
    };
  };

  // ── 版本、提交点与事件（v0.2.0）────────────────────────────────────────────
  // project.json.revision 是唯一的账本版本：任何改变 canon/本作/私设/忽略/原著的写操作 +1。
  // 提交点只有一个：commitWrite()。它同时刷新 project.json.exports（给 voice 读的派生块），
  // 写盘成功之后才发事件（先落盘、后事件；失败不发）。
  const PLUGIN_VERSION = (() => {
    try {
      return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();
  const changeListeners = new Set();
  function subscribeChange(listener) {
    if (typeof listener !== 'function') return () => {};
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }
  function emitChange(payload) {
    for (const listener of [...changeListeners]) {
      try {
        listener(payload);
      } catch {
        // 订阅方抛错不影响已经提交的写。
      }
    }
  }

  /**
   * 提交一次项目写入：revision +1、刷新 exports、发事件。
   * @param {{root: string, project: string}} c
   * @param {{kind?: string, canon?: object|null}} options key 用来区分事件种类
   */
  async function commitWrite(c, options = {}) {
    const kind = String(options.kind || 'canon');
    let declarations = null;
    try {
      declarations = await loadDeclarations(declarationFile(paths(c.root, c.project).dir));
    } catch {
      declarations = null;
    }
    let canon = options.canon || null;
    if (!canon) {
      try {
        canon = (await loadProject(c.root, c.project)).canon;
      } catch {
        canon = {};
      }
    }
    const committed = await commitProject(c.root, c.project, options.patch || {}, {
      exports: (revision) => buildExports({ canon, declarations, revision }),
    });
    emitChange({ project: c.project, revision: committed.revision, at: committed.updatedAt, kind });
    return committed;
  }

  const text = (value) => ({ type: 'text', text: String(value) });
  const ok = (body) => ({ ok: true, text: String(body) });
  const fail = (body) => ({ ok: false, text: String(body) });

  // 工具返回值除了渲染用的 {ok,text}，还可以带结构化字段（status/pass/revision/findings…）：
  // schema 用 additionalProperties 放开，render 只取 text——模型看到人话，
  // conductor 的 tools/result 收据拿到结构化值。beat 的 beat_verify 也是这个做法。
  const output = (render) => ({
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    },
    render: (_args, value) => [text(value?.text ?? '')],
  });

  // 数据源：fixture（夹具实验用）或 canon（.dsh-novel-fanfic/<project>/，导入的原著）。
  // v0.2.0 起把 revision / source 一起带出来，工具返回值里要报「这是哪一版」。
  async function canonOf(args, source) {
    const c = ctxOf(args || {});
    if (String(source) === 'canon') {
      const loaded = await loadProjectCanon(c.root, c.project);
      return {
        ...c,
        canon: { ...loaded.canon, source: 'canon' },
        source: 'canon',
        revision: Number.isInteger(loaded.project?.revision) ? loaded.project.revision : null,
      };
    }
    return {
      ...c,
      canon: { ...(await loadFixture(c.fixtureDir)), source: 'fixture' },
      source: 'fixture',
      revision: null,
    };
  }

  async function fixtureOf(args) {
    return canonOf(args, 'fixture');
  }

  async function projectSummary(args) {
    const c = ctxOf(args);
    const { project, canon } = await loadProject(c.root, c.project);
    const count = (rows, status) => rows.filter((row) => row.status === status).length;
    return {
      c,
      project,
      counts: {
        characters: { confirmed: count(canon.characters, 'confirmed'), total: canon.characters.length },
        facts: { confirmed: count(canon.facts, 'confirmed'), total: canon.facts.length },
        worldRules: { confirmed: count(canon.worldRules, 'confirmed'), total: canon.worldRules.length },
        secrets: { confirmed: count(canon.secrets, 'confirmed'), total: canon.secrets.length },
        addresses: { confirmed: count(canon.addresses, 'confirmed'), total: canon.addresses.length },
        contradictions: {
          open: canon.contradictions.filter((row) => row.status !== 'resolved').length,
          total: canon.contradictions.length,
        },
      },
    };
  }

  async function projectCounts(args) {
    const summary = await projectSummary(args);
    const { c, project, counts } = summary;
    const deltas = await loadDeltas(deltaFile(paths(c.root, c.project).dir));
    return {
      c,
      project,
      counts: { ...counts, deltas: { total: deltas.items.length, premise: Boolean(deltas.premise) } },
      lines: [
        `项目：${c.project}（${path.join(c.root, '.dsh-novel-fanfic', c.project)}）`,
        `原著：${project.sourceId ? `${project.sourceId}，当前章 ${project.currentChapter || '-'}` : '未导入'}`,
        `人物：confirmed ${counts.characters.confirmed} / 共 ${counts.characters.total}`,
        `事实：confirmed ${counts.facts.confirmed} / 共 ${counts.facts.total}`,
        `世界规则：confirmed ${counts.worldRules.confirmed} / 共 ${counts.worldRules.total}`,
        `秘密：confirmed ${counts.secrets.confirmed} / 共 ${counts.secrets.total}`,
        `称呼：confirmed ${counts.addresses.confirmed} / 共 ${counts.addresses.total}`,
        `设定矛盾：open ${counts.contradictions.open} / 共 ${counts.contradictions.total}`,
        `本作设定：${deltas.items.length} 条${deltas.premise ? '（有前提）' : ''}——契约里优先于原著`,
      ],
    };
  }

  // ── 工具 1：状态 ────────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'fic_state',
    description:
      '查看同人工作室的当前状态：夹具章节数、canon 各桶的 confirmed 数量、本作设定条数、未裁决的设定矛盾、契约漂移。'
      + '在任何 fic_* 操作前先用它确认项目已经导入原著。插件需先 /fic on。',
    parameters: parameterSchema({
      project: { type: 'string', description: '项目名（.dsh-novel-fanfic/<project>），默认取插件配置。' },
      root: { type: 'string', description: '工作目录，默认取插件配置。' },
    }),
    output: output(),
    async execute(args) {
      const lines = [];
      let fixture = null;
      try {
        fixture = await fixtureOf(args || {});
        const chars = fixture.canon.chapters.reduce((sum, ch) => sum + (ch.body?.length || 0), 0);
        lines.push(`夹具：${fixture.canon.chapters.length} 章 / ${chars} 字 / ${fixture.canon.scenes.length} 个场景`);
        const drift = contractDrift(fixture.canon);
        lines.push(`契约漂移：${drift.length === 0 ? '0 份 ✓' : drift.map((d) => `${d.chapter}:${d.reason}`).join('、')}`);
      } catch (err) {
        lines.push(`夹具不可读：${err.message}`);
      }
      try {
        const counts = await projectCounts(args || {});
        lines.push(...counts.lines);
      } catch (err) {
        lines.push(`canon 项目：${err.message}`);
      }
      return ok(lines.join('\n'));
    },
  }, { when: (context) => effectiveOn(isOn(context.agent), keyOf(context.agent)) });

  // ── 工具 2：原著导入 / 读取 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'fic_source',
    description:
      '管理原著来源。action=import（file=本地 txt/md 路径，UTF-8 或 GB18030，≤20MB，重复文件会被 sha256 拦下）、'
      + 'action=list（列出已导入的章节）、action=read（chapter=chNNN，读该章正文）、action=index（读确定性索引：人物候选/称呼/统计）。'
      + 'action=hongguo_search / hongguo_series / hongguo_episodes / hongguo_danmaku 读红果短剧元数据/分集/弹幕（只读；不取播放地址/内容密钥）。'
      + 'action=comic_list 列本地 CBZ/ZIP/图片目录页；action=comic_panels 对单页分格；action=comic_ocr 只对选中页做 Windows 内置 OCR（split=true 先分格再逐格 OCR；不整本、不装外部 OCR）。'
      + 'action=media_list/media_add_comic/media_add_hongguo/media_add_evidence/media_remove 登记项目媒体来源与最小证据（不复制整本/整集，不存播放地址）。'
      + 'action=media_verify 只读校验来源 hash/页集定位；红果无本地源时标 unverified。'
      + '导入只做存储与分章，不生成 canon；canon 走提案与人工确认。',
    parameters: parameterSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['import', 'list', 'read', 'index', 'hongguo_search', 'hongguo_series', 'hongguo_episodes', 'hongguo_danmaku', 'comic_list', 'comic_panels', 'comic_ocr', 'media_list', 'media_add_comic', 'media_add_hongguo', 'media_add_evidence', 'media_remove', 'media_verify'],
        description: 'import | list | read | index | hongguo_* | comic_* | media_*。',
      },
      file: { type: 'string', description: 'action=import/comic_list/comic_ocr 时的本地文件/目录路径。' },
      chapter: { type: 'string', description: 'action=read 时的章节 id，如 ch002。' },
      limit: { type: 'integer', description: 'action=read 时最多返回多少字，默认 4000。' },
      query: { type: 'string', description: 'action=hongguo_search 的剧名关键词。' },
      seriesId: { type: 'string', description: 'action=hongguo_series/hongguo_episodes/hongguo_danmaku 的剧 id。' },
      episodeId: { type: 'string', description: 'action=hongguo_danmaku 的分集 id。' },
      pageSize: { type: 'integer', description: '红果分页大小，默认 20。' },
      cursor: { type: 'string', description: '红果翻页游标（可选）。' },
      pages: { type: 'array', items: { type: 'integer' }, description: 'action=comic_ocr 的页码数组（从 0 开始，最多 30 页）。' },
      split: { type: 'boolean', description: 'action=comic_ocr 是否先分格再逐格 OCR（默认 false）。' },
      page: { type: 'integer', description: 'action=comic_panels 的页码（从 0 开始，默认 0）。' },
      sourceId: { type: 'string', description: 'action=media_add_evidence/media_remove 的来源 id。' },
      title: { type: 'string', description: 'action=media_add_comic/media_add_hongguo 的标题。' },
      coverUrl: { type: 'string', description: 'action=media_add_hongguo 的封面 URL。' },
      kind: { type: 'string', description: 'action=media_add_evidence 的证据类型。' },
      locator: { type: 'object', description: 'action=media_add_evidence 的定位（page/panel/episode/time 等）。' },
      quote: { type: 'string', description: 'action=media_add_evidence 的短引文/OCR 文本。' },
      method: { type: 'string', description: 'action=media_add_evidence 的采集方法（manual/ocr/subtitle）。' },
      hash: { type: 'string', description: 'action=media_add_evidence 的源/帧 hash（可选）。' },
      confirm: { type: 'boolean', description: 'action=media_add_*/media_remove 必须为 true，表示作者已确认。' },
      project: { type: 'string', description: '项目名。' },
      root: { type: 'string', description: '工作目录。' },
    }),
    output: output(),
    async execute(args) {
      const c = ctxOf(args || {});
      const action = String(args?.action || '');
      if (action === 'import') {
        const file = String(args?.file || '');
        if (!file) return fail('action=import 需要 file。');
        const res = await ingestFile({ root: c.root, project: c.project, file: path.resolve(c.root, file) });
        if (res.duplicate) return ok(`重复文件：sha256 ${res.sha256} 已在项目中，未重复导入。`);
        return ok(
          `已导入 ${res.sourceId}：${res.chapters.length} 章 / ${res.meta?.chars ?? '?'} 字（${res.encoding || res.meta?.encoding}）。`
          + `\n章节：${res.chapters.slice(0, 12).map((ch) => ch.id).join('、')}${res.chapters.length > 12 ? `…（共 ${res.chapters.length} 章）` : ''}`,
        );
      }
      if (action === 'hongguo_search') {
        try {
          const result = await hongguoSearch(String(args?.query || ''), {
            pageSize: Number(args?.pageSize) || 20,
            cursor: args?.cursor || undefined,
          });
          return ok(JSON.stringify(result, null, 2));
        } catch (error) {
          return fail(`红果搜索失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'hongguo_series') {
        if (!args?.seriesId) return fail('action=hongguo_series 需要 seriesId。');
        try {
          return ok(JSON.stringify(await hongguoSeries(String(args.seriesId)), null, 2));
        } catch (error) {
          return fail(`红果剧集读取失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'hongguo_episodes') {
        if (!args?.seriesId) return fail('action=hongguo_episodes 需要 seriesId。');
        try {
          const result = await hongguoEpisodes(String(args.seriesId), {
            pageSize: Number(args?.pageSize) || 20,
            cursor: args?.cursor || undefined,
          });
          return ok(JSON.stringify(result, null, 2));
        } catch (error) {
          return fail(`红果分集读取失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'hongguo_danmaku') {
        if (!args?.seriesId || !args?.episodeId) return fail('action=hongguo_danmaku 需要 seriesId 和 episodeId。');
        try {
          const result = await hongguoDanmaku(String(args.seriesId), String(args.episodeId), {
            pageSize: Number(args?.pageSize) || 20,
            cursor: args?.cursor || undefined,
          });
          return ok(JSON.stringify(result, null, 2));
        } catch (error) {
          return fail(`红果弹幕读取失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'comic_list') {
        if (!args?.file) return fail('action=comic_list 需要 file。');
        try {
          return ok(JSON.stringify(await listComicPages(path.resolve(c.root, String(args.file))), null, 2));
        } catch (error) {
          return fail(`漫画读取失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'comic_ocr') {
        if (!args?.file) return fail('action=comic_ocr 需要 file。');
        try {
          if (args?.split) {
            const pages = (Array.isArray(args?.pages) && args.pages.length ? args.pages : [0])
              .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0).slice(0, 30);
            if (!pages.length) return fail('action=comic_ocr 的 pages 没有有效页码。');
            const results = [];
            for (const page of pages) {
              results.push(await ocrComicPanels(path.resolve(c.root, String(args.file)), page));
            }
            return ok(JSON.stringify({
              ok: results.some((result) => result.ok),
              split: true,
              pages: results,
              text: results.map((result) => result.text || '').filter(Boolean).join('\n\n'),
              chars: results.reduce((sum, result) => sum + (result.chars || 0), 0),
            }, null, 2));
          }
          return ok(JSON.stringify(await ocrComicPages(
            path.resolve(c.root, String(args.file)),
            Array.isArray(args?.pages) ? args.pages : [0],
          ), null, 2));
        } catch (error) {
          return fail(`漫画 OCR 失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'comic_panels') {
        if (!args?.file) return fail('action=comic_panels 需要 file。');
        try {
          return ok(JSON.stringify(await detectComicPanels(
            path.resolve(c.root, String(args.file)),
            Number(args?.page) || 0,
          ), null, 2));
        } catch (error) {
          return fail(`漫画分格失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'media_list') {
        try {
          return ok(JSON.stringify(await listMedia(c.root, c.project), null, 2));
        } catch (error) {
          return fail(`媒体来源读取失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'media_add_comic') {
        if (!args?.file) return fail('action=media_add_comic 需要 file。');
        if (args?.confirm !== true) return fail('action=media_add_comic 需要作者确认 confirm:true。');
        try {
          return ok(JSON.stringify(await addComicSource(c.root, c.project, {
            file: path.resolve(c.root, String(args.file)), title: args?.title,
          }), null, 2));
        } catch (error) {
          return fail(`漫画来源登记失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'media_add_hongguo') {
        if (!args?.seriesId) return fail('action=media_add_hongguo 需要 seriesId。');
        if (args?.confirm !== true) return fail('action=media_add_hongguo 需要作者确认 confirm:true。');
        try {
          return ok(JSON.stringify(await addHongguoSource(c.root, c.project, {
            seriesId: args.seriesId, title: args?.title, coverUrl: args?.coverUrl,
          }), null, 2));
        } catch (error) {
          return fail(`红果来源登记失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'media_add_evidence') {
        if (!args?.sourceId || !args?.quote) return fail('action=media_add_evidence 需要 sourceId 和 quote。');
        if (args?.confirm !== true) return fail('action=media_add_evidence 需要作者确认 confirm:true。');
        try {
          return ok(JSON.stringify(await addMediaEvidence(c.root, c.project, {
            sourceId: args.sourceId,
            kind: args?.kind,
            locator: args?.locator,
            quote: args.quote,
            method: args?.method,
            hash: args?.hash,
          }), null, 2));
        } catch (error) {
          return fail(`媒体证据登记失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'media_remove') {
        if (!args?.sourceId) return fail('action=media_remove 需要 sourceId。');
        if (args?.confirm !== true) return fail('action=media_remove 需要作者确认 confirm:true。');
        try {
          return ok(JSON.stringify(await removeMediaSource(c.root, c.project, String(args.sourceId)), null, 2));
        } catch (error) {
          return fail(`媒体来源删除失败：${String(error?.message || error)}`);
        }
      }
      if (action === 'media_verify') {
        try {
          return ok(JSON.stringify(await verifyMediaEvidence(c.root, c.project), null, 2));
        } catch (error) {
          return fail(`媒体证据校验失败：${String(error?.message || error)}`);
        }
      }
      let project;
      try {
        ({ project } = await loadProject(c.root, c.project));
      } catch (err) {
        return fail(`${err.message}\n先用 fic_source action=import file=<原著路径> 建立项目。`);
      }
      if (!project.sourceId) return fail('项目还没有导入原著，先 fic_source action=import。');
      const p = paths(c.root, c.project).source(project.sourceId);
      if (action === 'list') {
        const meta = await readJson(p.meta, {});
        const index = await readJson(p.index, null);
        const ids = (index?.chapters || []).map((ch) => `${ch.id}（${ch.title || '无题'}，${ch.chars || 0} 字）`);
        return ok(`来源 ${project.sourceId}：${meta.chapterCount ?? ids.length} 章 / ${meta.chars ?? '?'} 字\n${ids.join('\n')}`);
      }
      if (action === 'read') {
        const id = String(args?.chapter || project.currentChapter || '');
        if (!id) return fail('action=read 需要 chapter。');
        const body = await chapterBody(c.root, c.project, id);
        const limit = Number(args?.limit || 4000);
        return ok(body.length > limit ? `${body.slice(0, limit)}\n…（截断，共 ${body.length} 字）` : body);
      }
      if (action === 'index') {
        const index = await readJson(p.index, null);
        if (!index) return fail('还没有索引，先重新 import。');
        const people = (index.characters || []).map((ch) => `${ch.name}（${ch.mentions} 次，${(ch.chapters || []).join('/')}）`);
        const voc = (index.vocatives || []).slice(0, 20).map((v) => `${v.speaker || '?'}→${v.word}（${v.chapter}）`);
        return ok(`人物候选：${people.join('、') || '无'}\n称呼候选：${voc.join('、') || '无'}`);
      }
      return fail(`未知 action：${action}`);
    },
  }, { when: (context) => effectiveOn(isOn(context.agent), keyOf(context.agent)) });

  // ── 工具 3：场景契约 ───────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'fic_contract',
    description:
      '取某一章的写作契约（九段：视角/在场/称呼/知情/世界规则/时间线/禁忌/不确定/锚点；有本作设定时最前面多一段【本作】，'
      + '本作优先于原著），由 canon 确定性编译，不接受自由发挥。chapter=ch002 取单章；chapter=all 列出各章摘要。'
      + '写这一章之前必须先把契约读进来。',
    parameters: parameterSchema({
      chapter: { type: 'string', required: true, description: '章 id，如 ch002；all 表示全部。' },
      source: { type: 'string', enum: ['fixture', 'canon'], description: '数据源：fixture（夹具，默认）或 canon（已导入的项目）。' },
      project: { type: 'string', description: '项目名。' },
      root: { type: 'string', description: '工作目录。' },
    }),
    output: output(),
    async execute(args) {
      const loaded = await canonOf(args || {}, args?.source);
      const canon = loaded.canon;
      const chapter = String(args?.chapter || '');
      if (chapter === 'all') {
        const rows = compileAll(canon).map(
          (c) => `${c.chapter}：${c.chars} 字，视角 ${canon.sceneById?.[c.id]?.pov || '-'}，sha1 ${c.hash.slice(0, 8)}`,
        );
        return { ...ok(rows.join('\n')), status: 'completed', revision: loaded.revision, chapters: compileAll(canon).length };
      }
      const scene = canon.scenes.find((s) => s.chapter === chapter || s.id === chapter);
      if (!scene) return fail(`没有这一章的契约：${chapter}（可用 ${canon.scenes.map((s) => s.chapter).join('、')}）`);
      const compiled = compileContract(scene, canon);
      return {
        ...ok(compiled.markdown),
        status: 'completed',
        code: null,
        chapter: scene.chapter,
        scene: scene.id,
        chars: compiled.chars,
        hash: compiled.hash,
        // sections 就是编译器内部那份 tags（markdown 由它渲染，段之和 = 全文天然成立）
        sections: compiled.tags,
        sectionOrder: Object.keys(compiled.tags),
        revision: loaded.revision,
        source: loaded.source,
      };
    },
  }, { when: (context) => effectiveOn(isOn(context.agent), keyOf(context.agent)) });

  // ── 工具 4：写作前/后的约束检查 ───────────────────────────────────────────
  ctx.tools.register({
    name: 'fic_check',
    description:
      '用确定性检查器审一段同人正文：标签、错名、称呼、知情、世界规则、AU 泄漏、眼睛颜色（未裁决矛盾）、'
      + '未声明私设、20 字复制、契约遗漏。text 或 file 二选一，chapter 指定场景。返回每条 finding 的'
      + '「在哪、凭什么、跟哪条设定冲突」；作者登记过的本作设定会放过同类 finding，并在 suppressed 里列出，'
      + '不改稿、不评分。',
    parameters: parameterSchema({
      chapter: { type: 'string', required: true, description: '章 id，如 ch004。' },
      text: { type: 'string', description: '要检查的正文（不必带【标签】行）。' },
      file: { type: 'string', description: '或从本地文件读取。' },
      arm: { type: 'string', description: 'A | B | C，默认 C（契约 + lookup 臂）。' },
      source: { type: 'string', enum: ['fixture', 'canon'], description: '数据源：fixture（夹具，默认）或 canon（已导入的项目）。' },
      project: { type: 'string', description: '项目名。' },
      root: { type: 'string', description: '工作目录。' },
    }),
    output: output(),
    async execute(args) {
      let raw = String(args?.text || '');
      if (!raw && args?.file) {
        const c = ctxOf(args || {});
        raw = await readFile(path.resolve(c.root, String(args.file)), 'utf8');
      }
      if (!raw.trim()) return fail('fic_check 需要 text 或 file。');
      const loaded = await canonOf(args || {}, args?.source);
      const canon = loaded.canon;
      const chapter = String(args?.chapter || '');
      const scene = canon.scenes.find((s) => s.chapter === chapter || s.id === chapter);
      if (!scene) return fail(`没有这一章的 canon 场景：${chapter}`);
      const checked = runCheck(raw, scene, canon, { arm: String(args?.arm || 'C') });
      // waiver 在服务端应用（v0.1 只在面板里过滤，导致 conductor 看到的 pass 与作者看到的不一致）
      let waivers = [];
      try {
        const { list } = await waiversOf(args || {});
        waivers = list;
      } catch {
        waivers = [];
      }
      const result = applyWaivers(checked, waivers, scene.chapter);
      const gate = result.findings.filter((f) => GATE_DETECTORS.includes(f.detector));
      const head = `必检 5 类：${gate.length} 条｜blocker ${result.summary.blockers}｜warning ${result.summary.warnings}`
        + `｜info ${result.summary.infos}｜本作放过 ${result.summary.suppressed || 0} 条`
        + (result.summary.waived ? `｜作者忽略 ${result.summary.waived} 条` : '');
      return {
        ...ok(`${head}\n${formatFindings(result)}`),
        // 执行成功（status）与检查通过（pass）分开：检查不通过时 status 仍是 completed
        status: 'completed',
        code: null,
        pass: result.summary.blockers === 0,
        chapter: scene.chapter,
        scene: scene.id,
        revision: loaded.revision,
        source: loaded.source,
        summary: result.summary,
        findings: result.findings,
        suppressed: result.suppressed || [],
        waived: result.waived || [],
      };
    },
  }, { when: (context) => effectiveOn(isOn(context.agent), keyOf(context.agent)) });

  // ── 工具 5：章节任务卡（v0.2.0 新增功能）────────────────────────────────────
  ctx.tools.register({
    name: 'fic_plan',
    description:
      '章节任务卡：写之前想清楚「这一章要干什么」。action=get 读、set 写（只覆盖传了的字段）、clear 删。'
      + '它不是契约、不是 canon、不是 beat 的决策账本：只落 project/chapters/<章>/mission.json，'
      + '删掉不影响契约编译；唯一进契约的地方是 openQuestions（进「不确定」段）。'
      + '字段都可选，三行也算一张卡。',
    parameters: parameterSchema({
      chapter: { type: 'string', required: true, description: '章 id，如 ch002' },
      action: { type: 'string', enum: ['get', 'set', 'clear'], description: '默认 get' },
      title: { type: 'string', description: '这一章的一句话标题' },
      pov: { type: 'string', description: '视角人物' },
      placeTime: { type: 'string', description: '时间地点' },
      goal: { type: 'string', description: '本章要干成什么（一句话）' },
      arc: { type: 'string', description: '情绪曲线，如「提防 → 松动 → 冷下去」' },
      reader_expectation: { type: 'string', description: '本章满足/延迟/颠覆哪个读者期待' },
      anchors: { type: 'array', items: { type: 'string' }, description: '原著锚点（可引用的场景/台词），最多 10 条' },
      beats: { type: 'array', items: { type: 'string' }, description: '关键节拍，最多 7 条' },
      avoid: { type: 'array', items: { type: 'string' }, description: '本章要避开的雷点（作者自己定的）' },
      open_questions: { type: 'array', items: { type: 'string' }, description: '写之前要拍板的开放问题；会进契约的「不确定」段' },
      target_chars: { type: 'integer', description: '目标字数' },
      status: { type: 'string', enum: ['draft', 'ready', 'done'], description: '作者自己的状态，插件不判' },
      source_chapter: { type: 'string', description: '对应原著章（本作章 ≠ 原著章，可不同）' },
      project: { type: 'string', description: '项目名' },
      root: { type: 'string', description: '工作目录' },
    }),
    output: output(),
    async execute(args) {
      const c = ctxOf(args || {});
      const chapter = String(args?.chapter || '').trim();
      if (!chapter) return fail('fic_plan 需要 chapter');
      const action = String(args?.action || 'get');
      if (action === 'get') {
        const mission = await loadMission(c.root, c.project, chapter);
        const revision = await readRevision(c.root, c.project);
        return {
          ...ok(describeMission(mission)),
          status: 'completed',
          chapter,
          mission,
          hasMission: Boolean(mission),
          revision: revision.revision,
        };
      }
      if (action === 'clear') {
        await clearMission(c.root, c.project, chapter);
        const committed = await commitWrite(c, { kind: 'mission' });
        return {
          ...ok(`已删除 ${chapter} 的任务卡（契约仍可编译，只是不再注入意图）`),
          status: 'completed',
          chapter,
          mission: null,
          hasMission: false,
          revision: committed.revision,
        };
      }
      const mission = await saveMission(c.root, c.project, chapter, {
        title: args?.title,
        pov: args?.pov,
        placeTime: args?.placeTime,
        goal: args?.goal,
        arc: args?.arc,
        readerExpectation: args?.reader_expectation,
        anchors: args?.anchors,
        beats: args?.beats,
        avoid: args?.avoid,
        openQuestions: args?.open_questions,
        targetChars: args?.target_chars,
        status: args?.status,
        sourceChapter: args?.source_chapter,
        canonRevision: (await readRevision(c.root, c.project)).revision,
      });
      const committed = await commitWrite(c, { kind: 'mission' });
      return {
        ...ok(describeMission(mission)),
        status: 'completed',
        chapter,
        mission,
        hasMission: true,
        revision: committed.revision,
      };
    },
  }, { when: (context) => effectiveOn(isOn(context.agent), keyOf(context.agent)) });

  // ── 工具 6：原文检索 ──────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'fic_lookup',
    description:
      '在已导入的原著里检索能支撑写作的原文片段：返回章节、偏移、原句与命中理由。用它核对「这个人叫什么、'
      + '这里发生过什么」，不要凭记忆。entities 传人物/地名可提高命中精度。',
    parameters: parameterSchema({
      question: { type: 'string', required: true, description: '要查的问题，或要核对的事实，如「裴照什么时候改口叫阿砚」。' },
      entities: { type: 'array', items: { type: 'string' }, description: '相关实体（人物名、地点），可选。' },
      chapter_range: { type: 'array', items: { type: 'string' }, description: '限制章节范围，如 ["ch001","ch003"]，可选。' },
      limit: { type: 'integer', description: '返回片段数，默认 5。' },
      source: { type: 'string', enum: ['fixture', 'canon'], description: '数据源：fixture（夹具，默认）或 canon（已导入的项目）。' },
      project: { type: 'string', description: '项目名。' },
      root: { type: 'string', description: '工作目录。' },
    }),
    output: output(),
    async execute(args) {
      const { canon } = await canonOf(args || {}, args?.source);
      const question = String(args?.question || '').trim();
      if (!question) return fail('fic_lookup 需要 question。');
      const result = retrieve(canon, {
        question,
        entities: Array.isArray(args?.entities) ? args.entities : [],
        chapterRange: Array.isArray(args?.chapter_range) ? args.chapter_range : undefined,
        limit: Number(args?.limit || 5),
      });
      const body = result.passages
        .map((p, i) => `${i + 1}. [${p.chapter} @${p.offset}] ${p.quote}\n   命中：${p.why}\n   依据：${p.from}–${p.to}`)
        .join('\n');
      return ok(`覆盖：${result.coverage}${result.note ? `（${result.note}）` : ''}\n${body || '没有命中，换个问法或补实体。'}`);
    },
  }, { when: (context) => effectiveOn(isOn(context.agent), keyOf(context.agent)) });

  // ── 工具 7：人物形象（0.4.0）──────────────────────────────────────────────
  ctx.tools.register({
    name: 'fic_avatar',
    description:
      '人物形象：官方来源（Bangumi/AniList/Kitsu）、网页搜图（Bing/百度）、本地上传。'
      + 'action=status 看覆盖；search_works 查作品；list_characters 列来源角色；match 把 canon 人物与来源角色做候选匹配；'
      + 'web_search 查网页图；set 写确认图（必须 confirm:true + dataBase64）；remove 删除（必须 confirm:true）。'
      + '图片只存本地项目，不改 canon、不进契约、不随 npm 包分发。',
    parameters: parameterSchema({
      action: {
        type: 'string', required: true,
        enum: ['status', 'search_works', 'list_characters', 'match', 'web_search', 'fetch_image', 'set', 'remove'],
        description: 'status | search_works | list_characters | match | web_search | fetch_image | set | remove。',
      },
      query: { type: 'string', description: 'search_works/web_search 的查询词，如「斗罗大陆 唐三 动画 形象」。' },
      url: { type: 'string', description: 'fetch_image 的图片 URL；只允许已知 CDN/缩略图域。' },
      source: { type: 'string', enum: ['bangumi', 'anilist', 'kitsu'], description: 'list_characters/match 的来源。' },
      sourceId: { type: 'string', description: 'list_characters/match 的来源作品 ID。' },
      characterId: { type: 'string', description: 'set/remove 的 canon 人物 ID。' },
      characterName: { type: 'string', description: 'set 时的人物名（仅展示/回查）。' },
      dataBase64: { type: 'string', description: 'set 时的 PNG/JPEG/WebP base64（可带 data: 前缀）；≤512KB、正方形。' },
      engine: { type: 'string', enum: ['bing', 'baidu'], description: 'web_search 的引擎，默认 baidu。' },
      limit: { type: 'integer', description: 'web_search 返回条数，默认 12，最多 24。' },
      confirm: { type: 'boolean', description: 'set/remove 必须显式 true，表示作者已确认。' },
      project: { type: 'string', description: '项目名。' },
      root: { type: 'string', description: '工作目录。' },
    }),
    output: output(),
    async execute(args) {
      try {
        const result = await avatarAction(args || {});
        return ok(JSON.stringify(result, null, 2));
      } catch (error) {
        return fail(String(error?.message || error));
      }
    },
  }, { when: (context) => effectiveOn(isOn(context.agent), keyOf(context.agent)) });

  // ── 工具 8：导入分析（0.4.2）──────────────────────────────────────────────
  ctx.tools.register({
    name: 'fic_analyze',
    description:
      '从已确认 canon 生成可回查的导入分析：action=overview 总览与覆盖；relations 关系/称呼；timeline 事件与伏笔；'
      + 'au 本作改动影响面；reader 读者视角假设。只统计已确认 canon；pending 不算事实；推断/假设单独标注；不自动改正文。'
      + 'OOC 逐句检查请用 fic_check。',
    parameters: parameterSchema({
      action: {
        type: 'string', required: true,
        enum: ['overview', 'relations', 'timeline', 'au', 'reader'],
        description: 'overview | relations | timeline | au | reader。',
      },
      project: { type: 'string', description: '项目名。' },
      root: { type: 'string', description: '工作目录。' },
    }),
    output: output(),
    async execute(args) {
      try {
        const result = await analysisReport(args || {});
        return {
          ...ok(result.text),
          status: 'completed',
          action: result.action,
          project: result.project,
          revision: result.revision,
        };
      } catch (error) {
        return fail(`分析失败：${String(error?.message || error)}\n先导入原著并确认 canon。`);
      }
    },
  }, { when: (context) => effectiveOn(isOn(context.agent), keyOf(context.agent)) });

  // 侧边栏总览的数据源：一次取齐夹具统计 + canon 计数 + 契约漂移。
  async function statusSnapshot(args = {}, key = '') {
    const c = ctxOf(args);
    const snap = {
      ok: true,
      project: c.project,
      root: c.root,
      enabled: isOn({ session: { id: key } }),
      persisted: preference.enabled === true,
      defaultProject: preference.project || cfg.project,
    };
    try {
      const canon = await loadFixture(c.fixtureDir);
      const chapters = canon.chapters || [];
      snap.fixture = {
        chapters: chapters.length,
        chars: chapters.reduce((n, chapter) => n + String(chapter.body || '').length, 0),
        scenes: canon.scenes.filter((scene) => scene.kind === 'canon').length,
        controlScenes: canon.scenes.filter((scene) => scene.kind === 'control').length,
      };
      snap.drift = contractDrift(canon).length;
    } catch (error) {
      snap.fixtureError = String(error?.message || error);
    }
    try {
      const { project, counts } = await projectSummary(args);
      snap.imported = Boolean(project.sourceId);
      snap.canon = counts;
    } catch (error) {
      snap.canonError = String(error?.message || error);
    }
    return snap;
  }

  // ── 侧边栏写入视图：一次取齐总览 + 章节 + 待审 canon + 未裁决矛盾 ─────────────
  const BUCKET_LABEL = {
    characters: '人物', facts: '事实', worldRules: '世界规则', secrets: '秘密', addresses: '称呼',
  };

  function entryLabel(bucket, e) {
    if (bucket === 'characters') return e.name + (Array.isArray(e.aliases) && e.aliases.length ? `（${e.aliases.join('、')}）` : '');
    if (bucket === 'facts') return `${e.subjectName || e.subject} · ${e.predicate} = ${e.object}`;
    if (bucket === 'worldRules') return e.text;
    if (bucket === 'secrets') return e.what;
    if (bucket === 'addresses') return `${e.from} → ${e.to}：${e.form}`;
    return String(e.id || '');
  }

  function clamp(text, n = 120) {
    const s = String(text || '');
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  async function panelPayload(args = {}, key = '', options = {}) {
    const c = ctxOf(args);
    const snap = await statusSnapshot(args, key);
    const out = {
      ok: true, project: c.project, status: snap,
      title: null, currentChapter: null, chapters: [], pending: [], contradictions: [], waivers: [], declarations: null,
      deltas: emptyDeltas(), book: null,
    };
    // loaded 必须在 try 外声明：后面的 revision / exports / beat 摘要都要用它。
    let loaded = null;
    try {
      loaded = await loadProject(c.root, c.project);
      out.currentChapter = loaded.project.currentChapter || null;
      out.title = loaded.project.title || null;
      out.chapters = (loaded.index?.chapters || []).map((ch) => ({
        id: ch.id, title: ch.title || '', chars: ch.chars || 0, ordinal: ch.ordinal,
      }));
      // 正文只用于算「提及次数 / 出场章节 / 时间线在场人物」，算完不回传，避免面板载荷随书变长。
      const texts = {};
      if (!options.light && loaded.project.sourceId) {
        for (const ch of loaded.index?.chapters || []) {
          try {
            texts[ch.id] = await readFile(loaded.paths.source(loaded.project.sourceId).chapter(ch.id), 'utf8');
          } catch {
            // 缺某章不影响其余卡；不在面板里报错。
          }
        }
      }
      out.book = buildBook({ canon: loaded.canon, project: loaded.project, chapters: out.chapters, texts });
      try {
        const avatars = await loadAvatars(c.root, c.project);
        out.avatars = { assetRevision: avatars.assetRevision, summary: avatarSummary(avatars) };
        out.book.characters = (out.book.characters || []).map((ch) => {
          const row = avatars.characters[ch.id];
          return {
            ...ch,
            avatar: row && row.status === 'confirmed'
              ? {
                  status: 'confirmed',
                  hash: row.hash,
                  sourceKind: row.source?.kind || 'upload',
                  credit: row.source?.credit || '',
                }
              : { status: row?.status || 'none' },
          };
        });
      } catch (error) {
        out.avatars = { error: String(error?.message || error) };
      }
      for (const bucket of CANON_FILES) {
        if (bucket === 'contradictions') continue;
        for (const e of loaded.canon[bucket] || []) {
          if (e.status !== 'pending') continue;
          out.pending.push({
            id: e.id,
            bucket,
            kind: BUCKET_LABEL[bucket] || bucket,
            label: clamp(entryLabel(bucket, e)),
            chapter: e.chapter || e.fromChapter || e.evidence?.[0]?.chapter || null,
          });
        }
      }
      for (const fc of loaded.canon.contradictions || []) {
        if (fc.status !== 'open') continue;
        out.contradictions.push({
          id: fc.id,
          description: fc.description,
          values: fc.values || [],
          chapters: fc.chapters || [],
          facts: fc.factIds || [],
          evidence: (fc.evidence || []).map((ev) => ({ chapter: ev.chapter, quote: ev.quote })),
        });
      }
      try {
        const waiverFile = path.join(loaded.paths.dir, 'waivers.json');
        const list = await readJson(waiverFile, []);
        out.waivers = Array.isArray(list) ? list : [];
      } catch {
        // 没有忽略记录就是空表，不报错。
      }
      try {
        out.declarations = await loadDeclarations(declarationFile(loaded.paths.dir));
      } catch {
        // 声明文件坏了也不影响面板其余部分。
      }
      try {
        out.deltas = await loadDeltas(deltaFile(loaded.paths.dir));
      } catch {
        out.deltas = emptyDeltas();
      }
    } catch (error) {
      out.error = String(error?.message || error);
    }
    // v0.2.0 面板新增：版本号、任务卡、兄弟插件只读摘要（beat 的本章拍板）。
    // loaded 可能是 null（loadProject 抛错：项目不存在/JSON 坏了）——每一项都要能自己降级。
    try {
      out.revision = loaded.project.revision;
      out.revisionDrift = Boolean(loaded.project.revDrift);
    } catch {
      out.revision = null;
    }
    try {
      out.missions = await loadMissions(c.root, c.project);
    } catch {
      out.missions = {};
    }
    try {
      out.exports = loaded.project.exports || null;
    } catch {
      out.exports = null;
    }
    try {
      out.beat = await readBeatSummary(c.root, out.title || (loaded && loaded.project.title) || c.project);
    } catch {
      out.beat = { available: false, reason: 'read-failed' };
    }
    return out;
  }

  /**
   * 人物形象面板动作（0.4.0）。读操作不写命令/会话；写操作必须显式 confirm:true。
   * action: status | search_works | list_characters | match | web_search | set | remove
   */
  async function avatarAction(request = {}) {
    const c = ctxOf(request);
    const action = String(request.action || 'status');
    if (action === 'status') {
      const data = await loadAvatars(c.root, c.project);
      return { ok: true, project: c.project, summary: avatarSummary(data), works: data.works };
    }
    if (action === 'search_works') {
      const result = await searchWorks(String(request.query || ''));
      return result;
    }
    if (action === 'list_characters') {
      const source = String(request.source || '');
      const sourceId = String(request.sourceId || '');
      if (!source || !sourceId) throw new Error('source 和 sourceId 必填');
      const characters = await listCharacters(source, sourceId);
      return { ok: true, source, sourceId, characters };
    }
    if (action === 'web_search') {
      return await searchWebImages(String(request.query || ''), {
        engine: request.engine === 'bing' ? 'bing' : 'baidu',
        limit: Number(request.limit) || 12,
      });
    }
    if (action === 'fetch_image') {
      return await fetchImageBase64(String(request.url || ''), {
        timeoutMs: Number(request.timeoutMs) || undefined,
      });
    }
    if (action === 'match') {
      const source = String(request.source || '');
      const sourceId = String(request.sourceId || '');
      const { canon } = await loadProject(c.root, c.project);
      const canonCharacters = (canon.characters || []).map((row) => ({
        id: row.id, name: row.name, aliases: Array.isArray(row.aliases) ? row.aliases : [],
      }));
      const sourceCharacters = Array.isArray(request.characters)
        ? request.characters
        : (source && sourceId ? await listCharacters(source, sourceId) : []);
      return { ok: true, matches: matchCharacters(canonCharacters, sourceCharacters) };
    }
    if (action === 'set') {
      if (request.confirm !== true) throw new Error('人物形象写入需要作者确认（confirm:true）');
      const result = await setAvatar(c.root, c.project, {
        characterId: String(request.characterId || ''),
        name: request.name,
        dataBase64: request.dataBase64,
        buffer: request.buffer,
        source: request.source,
        crop: request.crop,
      });
      return result;
    }
    if (action === 'remove') {
      if (request.confirm !== true) throw new Error('删除人物形象需要作者确认（confirm:true）');
      return await removeAvatar(c.root, c.project, String(request.characterId || ''));
    }
    throw new Error(`未知的人物形象动作：${action}`);
  }

  /**
   * 导入分析（0.4.2）：只读 canon，返回 Markdown；不写盘。
   */
  async function analysisReport(request = {}) {
    const c = ctxOf(request);
    const action = String(request.action || 'overview');
    const loaded = await loadProject(c.root, c.project);
    const chapters = (loaded.index?.chapters || []).map((ch) => ({
      id: ch.id, title: ch.title || '', chars: ch.chars || 0, ordinal: ch.ordinal,
    }));
    const canon = confirmedCanon(loaded.canon);
    const book = buildBook({ canon, project: loaded.project, chapters, texts: {}, full: true });
    const deltas = await loadDeltas(deltaFile(paths(c.root, c.project).dir));
    return {
      ok: true,
      action,
      project: c.project,
      revision: Number.isInteger(loaded.project.revision) ? loaded.project.revision : null,
      text: analyzeBook(book, canon, deltas, action),
    };
  }

  /**
   * 媒体来源 UI 动作（0.4.1）：读只走 remote，不写命令事件；写操作要求显式 confirm。
   * action: list | verify | add_comic | add_hongguo | remove | comic_pages | comic_panels | comic_ocr | hongguo_search | hongguo_episodes | hongguo_danmaku | add_evidence
   */
  async function mediaAction(request = {}) {
    const c = ctxOf(request);
    const action = String(request.action || 'list');
    if (action === 'list') return await listMedia(c.root, c.project);
    if (action === 'verify') return await verifyMediaEvidence(c.root, c.project);
    if (action === 'add_comic') {
      if (request.confirm !== true) throw new Error('登记漫画来源需要作者确认（confirm:true）');
      return await addComicSource(c.root, c.project, { file: path.resolve(c.root, String(request.file || '')), title: request.title });
    }
    if (action === 'add_hongguo') {
      if (request.confirm !== true) throw new Error('登记红果来源需要作者确认（confirm:true）');
      return await addHongguoSource(c.root, c.project, {
        seriesId: request.seriesId, title: request.title, coverUrl: request.coverUrl,
      });
    }
    if (action === 'remove') {
      if (request.confirm !== true) throw new Error('删除媒体来源需要作者确认（confirm:true）');
      return await removeMediaSource(c.root, c.project, String(request.sourceId || ''));
    }
    if (action === 'add_evidence') {
      if (request.confirm !== true) throw new Error('登记媒体证据需要作者确认（confirm:true）');
      return await addMediaEvidence(c.root, c.project, {
        sourceId: request.sourceId, kind: request.kind, locator: request.locator,
        quote: request.quote, method: request.method, hash: request.hash,
      });
    }
    if (action === 'hongguo_search') {
      return await hongguoSearch(String(request.query || ''), {
        pageSize: Number(request.pageSize) || 20, cursor: request.cursor || undefined,
      });
    }
    if (['comic_pages', 'comic_panels', 'comic_ocr', 'comic_page_image', 'hongguo_episodes', 'hongguo_danmaku'].includes(action)) {
      const media = await listMedia(c.root, c.project);
      const source = media.sources.find((row) => row.id === request.sourceId);
      if (!source) throw new Error(`媒体来源不存在：${request.sourceId}`);
      if (action === 'comic_pages') return await listComicPages(source.file);
      if (action === 'comic_panels') return await detectComicPanels(source.file, Number(request.page) || 0);
      if (action === 'comic_ocr') {
        if (request.split) {
          return await ocrComicPanels(source.file, Number(Array.isArray(request.pages) ? (request.pages[0] ?? 0) : 0));
        }
        return await ocrComicPages(source.file, Array.isArray(request.pages) ? request.pages : [0]);
      }
      if (action === 'comic_page_image') {
        const pageIndex = Number(request.page) || 0;
        const pageMeta = (source.pages || []).find((page) => page.index === pageIndex);
        const bytes = await extractComicPage(source.file, pageIndex);
        if (bytes.length > 6 * 1024 * 1024) throw new Error('单页超过 6MB，UI 不内嵌显示');
        const name = String(pageMeta?.name || '').toLowerCase();
        const mime = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        return {
          ok: true, page: pageIndex, name: pageMeta?.name || '', mime,
          dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
        };
      }
      if (action === 'hongguo_episodes') {
        return await hongguoEpisodes(source.seriesId, { pageSize: Number(request.pageSize) || 20 });
      }
      return await hongguoDanmaku(source.seriesId, String(request.episodeId || ''), { pageSize: Number(request.pageSize) || 20 });
    }
    throw new Error(`未知的媒体动作：${action}`);
  }

  /**
   * 只读读 beat 的账本摘要（不 import、不写、不订阅）：
   * 作者在 fanfic 里能看到「这一章已经拍过什么板」，就不会重复登记同一件事。
   * beat 没装 / 没账本 → available:false，面板整块不显示（不是显示空）。
   *
   * 归属靠书名：先按 fanfic 项目标题匹配 beat 的书目录/书名；只有一本书时直接用它；
   * 多本且匹配不上就报歧义，不猜。
   */
  async function readBeatSummary(root, titleHint) {
    const base = path.join(root, '.dsh-novel-beat');
    let entries = [];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return { available: false, reason: 'no-beat' };
    }
    const books = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let book = null;
      try {
        book = await readJson(path.join(base, entry.name, 'book.json'), null);
      } catch {
        continue;
      }
      if (!book) continue;
      books.push({ dir: entry.name, book });
    }
    if (!books.length) return { available: false, reason: 'no-book' };
    const hint = String(titleHint || '').trim();
    let picked = null;
    if (hint) {
      picked = books.find((row) => {
        const title = String(row.book.title || row.dir);
        return title.includes(hint) || hint.includes(title) || row.dir === hint;
      }) || null;
    }
    if (!picked && books.length === 1) picked = books[0];
    if (!picked) return { available: false, reason: 'ambiguous', books: books.map((row) => row.book.title || row.dir).slice(0, 5) };
    const decisions = Array.isArray(picked.book.decisions) ? picked.book.decisions : [];
    return {
      available: true,
      book: String(picked.book.title || picked.dir),
      chapter: picked.book.currentChapter ?? null,
      decided: decisions.filter((row) => row.status === 'decided').length,
      open: decisions.filter((row) => row.status !== 'decided' && row.status !== 'cancelled').length,
      recent: decisions.slice(-5).map((row) => ({ id: row.id, title: String(row.title || '').slice(0, 60), status: row.status })),
      revision: Number.isInteger(picked.book.revision) ? picked.book.revision : null,
    };
  }

  async function applyReview(action, args = {}) {
    const c = ctxOf(args);
    const { canon } = await loadProject(c.root, c.project);
    const ids = String(args.ids || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw new Error('需要条目 id');
    const done = action === 'confirm' ? confirmEntries(canon, ids) : rejectEntries(canon, ids);
    await saveCanon(c.root, c.project, canon);
    await audit(c.root, c.project, { action: `canon.${action}`, ids: done });
    await commitWrite(c, { kind: 'canon', canon });
    return done;
  }

  async function chapterPayload(chapterId, args = {}, limit = 20000) {
    const c = ctxOf(args);
    const text = await chapterBody(c.root, c.project, chapterId);
    const loaded = await loadProject(c.root, c.project);
    const meta = (loaded.index?.chapters || []).find((x) => x.id === chapterId) || {};
    return { ok: true, id: chapterId, title: meta.title || '', chars: text.length, text: clamp(text, limit) };
  }

  // ── 项目列表 / 导入预览（侧边栏页头的项目选择器与导入向导） ─────────────────
  async function listProjects(currentId) {
    const root = ctxOf({}).root;
    const base = path.join(root, '.dsh-novel-fanfic');
    const out = { ok: true, root, current: currentId || cfg.project, projects: [] };
    let entries = [];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      let proj = null;
      try {
        proj = await readJson(path.join(base, id, 'project.json'), null);
      } catch {
        continue;
      }
      if (!proj) continue;
      let chapters = 0;
      let chars = 0;
      if (proj.sourceId) {
        try {
          const index = await readJson(path.join(base, id, 'source', proj.sourceId, 'index.json'), null);
          chapters = index?.chapterCount ?? 0;
          chars = index?.chars ?? 0;
        } catch {
          // 索引损坏不该挡住项目列表。
        }
      }
      out.projects.push({
        id,
        title: proj.title || id,
        chapters,
        chars,
        sourceId: proj.sourceId || null,
        currentChapter: proj.currentChapter || null,
        updatedAt: proj.updatedAt || proj.createdAt || null,
      });
    }
    out.projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return out;
  }

  /** 只读预览：编码、书名、章节切分、是否重复，不落任何文件。 */
  async function previewImport(args, file) {
    const c = ctxOf(args);
    const abs = path.resolve(c.root, file);
    const { text, encoding } = await readSourceText(abs);
    const chapters = splitChapters(text);
    if (!chapters.length) throw new Error('没有识别到任何章节或分块，文本可能为空');
    const digest = sha256(text);
    let duplicate = false;
    let duplicateOf = null;
    try {
      const loaded = await loadProject(c.root, c.project);
      if (loaded.project.sourceId) {
        const meta = await readJson(loaded.paths.source(loaded.project.sourceId).meta, null);
        if (meta && meta.sha256 === digest) {
          duplicate = true;
          duplicateOf = loaded.project.sourceId;
        }
      }
    } catch {
      // 项目还不存在时就是「全新导入」，不是错误。
    }
    return {
      ok: true,
      file: abs,
      project: c.project,
      encoding,
      chars: text.length,
      title: bookTitleOf(text, abs),
      chapterCount: chapters.length,
      duplicate,
      duplicateOf,
      chapters: chapters.map((ch) => ({ id: ch.id, ordinal: ch.ordinal, title: ch.title, chars: ch.body.length })),
    };
  }

  /** 目录里可导入的 txt/md（供「选择目录」后的文件列表；不递归，≤200 个）。 */
  async function listImportFiles(dir) {
    const abs = path.resolve(String(dir || '.'));
    const entries = await readdir(abs, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(txt|md|markdown|text)$/i.test(entry.name)) continue;
      const full = path.join(abs, entry.name);
      let info = null;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      files.push({ name: entry.name, path: full, bytes: info.size, mtime: info.mtime.toISOString() });
    }
    files.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
    return { ok: true, dir: abs, files: files.slice(0, 200), truncated: files.length > 200 };
  }

  /** 调宿主原生的目录选择器（directoryPicker seam）。只有 native 后端能弹窗。 */
  async function pickDirectory() {
    // directoryPicker 是可选服务：不在 inject 里，用 ctx.get 取，没有就不显示选择器。
    const picker = typeof ctx.get === 'function' ? ctx.get('directoryPicker') : ctx.directoryPicker;
    if (!picker || typeof picker.capability !== 'function') {
      return { ok: false, reason: 'unavailable', text: '当前宿主没有目录选择器（directoryPicker 未挂载），请直接填路径。' };
    }
    const capability = picker.capability();
    if (!capability || capability.kind !== 'native') {
      return { ok: false, reason: 'not-native', text: '当前宿主的目录选择是浏览式的（远程/无桌面会话），这里不能弹系统窗口；请直接填路径。' };
    }
    const controller = new AbortController();
    const picked = await capability.pick(controller.signal);
    return { ok: true, path: picked, cancelled: !picked };
  }

  // ── 忽略（waive）：作者认可的一条 finding，落成项目里的记录，不再计入 ────────
  async function waiversOf(args) {
    const c = ctxOf(args);
    const file = path.join(paths(c.root, c.project).dir, 'waivers.json');
    const list = await readJson(file, []);
    return { c, file, list: Array.isArray(list) ? list : [] };
  }

  async function addWaiver(args, entry) {
    const { c, file, list } = await waiversOf(args);
    const chapter = String(entry.chapter || '').trim();
    const code = String(entry.code || '').trim();
    const reason = String(entry.reason || '').trim();
    if (!chapter) throw new Error('waive 需要 <章>');
    if (!code) throw new Error('waive 需要 <detector>/<code>');
    if (!reason) throw new Error('waive 必须写理由（忽略要留原因）');
    const slash = code.indexOf('/');
    const detector = slash > 0 ? code.slice(0, slash) : code;
    const record = {
      id: `wv_${String(list.length + 1).padStart(3, '0')}`,
      chapter,
      detector,
      code: slash > 0 ? code.slice(slash + 1) : code,
      quote: String(entry.quote || '').slice(0, 200),
      reason: reason.slice(0, 300),
      at: new Date().toISOString(),
    };
    await writeJsonAtomic(file, [...list, record]);
    await audit(c.root, c.project, { action: 'finding.waive', id: record.id, chapter, code });
    await commitWrite(c, { kind: 'waiver' });
    return record;
  }

  async function removeWaiver(args, id) {
    const { c, file, list } = await waiversOf(args);
    const next = list.filter((w) => w.id !== id);
    if (next.length === list.length) throw new Error(`没有这条忽略记录：${id}`);
    await writeJsonAtomic(file, next);
    await audit(c.root, c.project, { action: 'finding.unwaive', id });
    await commitWrite(c, { kind: 'waiver' });
    return true;
  }

  function describeDeclarations(data) {
    const lines = ['作者私设声明（不进 canon，但检查器会用来抓漏）：'];
    lines.push(`AU 规则 ${data.auRules.length} 条：`);
    for (const rule of data.auRules) lines.push(`  ${rule.id}　${rule.name}　${rule.signatures.join('/')}${rule.text ? '　' + rule.text : ''}`);
    lines.push(`私设签名 ${data.headcanonSignatures.length} 条：`);
    data.headcanonSignatures.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
    const typos = Object.entries(data.typos);
    lines.push(`错名 ${typos.length} 条：`);
    for (const [wrong, right] of typos) lines.push(`  ${wrong} → ${right}`);
    return lines.join('\n');
  }

  function describeDeltas(data) {
    const lines = ['本作设定（优先于原著；会写进契约的【本作】段）：'];
    lines.push(`前提：${data.premise || '（未填）'}`);
    if (!data.items.length) lines.push('还没有本作改动。');
    for (const row of data.items) {
      lines.push(`  ${row.id}　${describeDelta(row)}`);
      if (row.suppress?.length) {
        lines.push(`    检查器放过：${row.suppress.map((s) => `${s.detector}/${s.code}`).join('、')}`);
      }
    }
    return lines.join('\n');
  }

  // ── 命令：/fic on|off|status ───────────────────────────────────────────────
  // v0.2.3：面板读数据不再执行 /fic 命令（那会往会话日志写 command/run + command/done）。
  // Host 半把同一个 handler 作为进程内函数暴露给 panel remote，CLI 与面板共用一份实现。
  const ficCommand = {
    name: 'fic',
    description: '同人工作室：/fic on 启用 fic_* 工具，/fic off 收起，/fic status 看状态。',
    // 带参数的命令必须声明 input：DSH 客户端只对「裸命令」直接执行，
    // 声明 input 后 `/fic on` 才会走 claim → execute，而不是被当成普通消息发给模型。
    input: { hint: 'on | off | status [--json] | projects | use <项目> | panel | chapters | chapter <id> | contract <章> | search <词> | preview <file> | pickdir | files <目录> | check <章> --text <编码> | plan list|get|set|clear <章> … | delta list|add|remove|premise … | declare list|au|headcanon|typo … | waive <章> <detector/code> --quote <q> --reason <r> | unwaive <wv_id> | review | confirm <ids> | reject <ids> | resolve <fc> <choice> | import <file>（都可带 --project <项目>）' },
    handler(invocation) {
      const key = keyOf(invocation?.agent);
      const parts = String(invocation?.rawInput || '').trim().split(/\s+/).filter(Boolean);
      const json = parts.includes('--json');
      const flagValue = (name) => {
        const at = parts.indexOf(name);
        return at < 0 ? '' : parts[at + 1] || '';
      };
      const decodeFlag = (name) => {
        const raw = flagValue(name);
        if (!raw) return '';
        try {
          return decodeURIComponent(raw);
        } catch {
          return raw;
        }
      };
      const projectArg = flagValue('--project');
      // 参数里可能混着 --json / --project <值> 这类开关；命令词和位置参数只数非开关项，
      // 开关自己的取值（--project 后面那个词）也要剔掉。
      const words = parts.filter((p, i) => !p.startsWith('--') && parts[i - 1] !== '--project' && parts[i - 1] !== '--limit');
      const arg = (words[0] || '').toLowerCase();
      const scope = () => (projectArg ? { project: projectArg } : {});
      // 不传 --project 时留空，让 ctxOf 回落到「记住的项目」，再回落到配置默认。
      const projectOf = (fallback) => projectArg || fallback || undefined;
      if ((arg === 'status' || arg === '') && json) {
        // 侧边栏读取用：只读快照，不改变任何状态。
        return statusSnapshot(scope(), key).then((snap) => ({ kind: 'success', text: JSON.stringify(snap) }));
      }

      // —— 项目列表 / 切换（面板页头的项目选择器） ——
      if (arg === 'projects') {
        return listProjects().then((data) => ({
          kind: 'success',
          text: json
            ? JSON.stringify(data)
            : data.projects.map((p) => `${p.id}　${p.title || '(无题)'}　${p.chapters} 章${p.id === data.current ? '　← 当前' : ''}`).join('\n'),
        })).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }

      // —— 切当前项目（面板页头选择器 / 导入后自动切） ——
      if (arg === 'use') {
        const target = String(words[1] || '').trim();
        if (!target) return { kind: 'error', text: '用法：/fic use <项目>' };
        return listProjects().then((list) => {
          const hit = list.projects.find((p) => p.id === target);
          if (!hit) {
            return {
              kind: 'error',
              text: `没有这个项目：${target}（现有：${list.projects.map((p) => p.id).join('、') || '无'}）`,
            };
          }
          savePreference({ project: target });
          return {
            kind: 'success',
            text: json
              ? JSON.stringify({ ok: true, project: target, title: hit.title, chapters: hit.chapters })
              : `当前项目已切成 ${target}（${hit.title || '未命名'}，${hit.chapters} 章）`,
          };
        }).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }

      // —— 侧边栏写入视图用到的读写命令 ——
      if (arg === 'panel') {
        return panelPayload({ project: projectOf(words[1]) }, key).then((data) => ({ kind: 'success', text: JSON.stringify(data) }));
      }
      if (arg === 'chapters') {
        return panelPayload({ project: projectOf(words[1]) }, key, { light: true }).then((data) => {
          if (json) {
            return {
              kind: 'success',
              text: JSON.stringify({ ok: data.ok, title: data.title, currentChapter: data.currentChapter, chapters: data.chapters }),
            };
          }
          if (!data.chapters.length) return { kind: 'success', text: data.error ? `读不到章节：${data.error}` : '还没有章节：先 /fic import <文件>' };
          return {
            kind: 'success',
            text: data.chapters.map((ch) => `${ch.id}　${ch.title || '(无题)'}　${ch.chars} 字`).join('\n'),
          };
        });
      }
      if (arg === 'chapter') {
        const id = words[1];
        if (!id) return { kind: 'error', text: '用法：/fic chapter ch001 [--json]' };
        return chapterPayload(id, scope()).then((data) => ({
          kind: 'success',
          text: json ? JSON.stringify(data) : `【${data.id} ${data.title}】${data.chars} 字\n\n${data.text}`,
        })).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'contract') {
        const chapter = words[1];
        if (!chapter) return { kind: 'error', text: '用法：/fic contract <章> [--json] [--source canon|fixture]' };
        const wanted = flagValue('--source');
        const loadSource = wanted === 'fixture'
          ? canonOf(scope(), 'fixture')
          : canonOf(scope(), 'canon').catch((error) => {
              if (wanted === 'canon') throw error;
              if (/项目不存在|还没有导入/.test(String(error?.message || error))) return canonOf(scope(), 'fixture');
              throw error;
            });
        return loadSource.then((c) => {
          const scene = c.canon.scenes.find((s) => s.chapter === chapter || s.id === chapter);
          if (!scene) return { kind: 'error', text: `没有 ${chapter} 这一章的契约场景（source=${c.source}）` };
          const compiled = compileContract(scene, c.canon);
          if (json) {
            return {
              kind: 'success',
              text: JSON.stringify({
                ok: true, source: c.source, chapter: scene.chapter, scene: scene.id,
                tags: compiled.tags, markdown: compiled.markdown, chars: compiled.chars,
              }),
            };
          }
          return { kind: 'success', text: compiled.markdown };
        }).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'search') {
        const term = words.slice(1).join(' ').trim();
        if (!term) return { kind: 'error', text: '用法：/fic search <词> [--json] [--limit 30]' };
        const limit = Math.max(1, Math.min(100, Number(flagValue('--limit')) || 30));
        return (async () => {
          const sc = ctxOf(scope());
          const loaded = await loadProject(sc.root, sc.project);
          if (!loaded.project.sourceId) return { kind: 'error', text: '项目还没有导入原著，先 /fic import <文件>' };
          const hits = [];
          for (const ch of loaded.index?.chapters || []) {
            let body = '';
            try {
              body = await readFile(loaded.paths.source(loaded.project.sourceId).chapter(ch.id), 'utf8');
            } catch {
              continue;
            }
            let at = 0;
            for (;;) {
              const found = body.indexOf(term, at);
              if (found < 0 || hits.length >= limit) break;
              hits.push({
                chapter: ch.id,
                title: ch.title || '',
                offset: found,
                quote: body.slice(Math.max(0, found - 24), Math.min(body.length, found + term.length + 24)).replace(/\s+/g, ' '),
              });
              at = found + term.length;
            }
            if (hits.length >= limit) break;
          }
          const payload = { ok: true, term, total: hits.length, limit, hits };
          if (json) return { kind: 'success', text: JSON.stringify(payload) };
          if (!hits.length) return { kind: 'success', text: `没有找到「${term}」。` };
          return {
            kind: 'success',
            text: hits.map((h) => `[${h.chapter} @${h.offset}] ${h.quote}`).join('\n'),
          };
        })().catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      // —— 系统目录选择 + 目录内文件列表（导入向导） ——
      if (arg === 'pickdir') {
        return pickDirectory().then((data) => ({
          kind: data.ok ? 'success' : 'error',
          text: json ? JSON.stringify(data) : (data.ok ? (data.path ? `已选择：${data.path}` : '已取消') : data.text),
        })).catch((error) => ({ kind: 'error', text: `打开选择器失败：${String(error?.message || error)}` }));
      }
      if (arg === 'files') {
        const dir = words.slice(1).join(' ');
        if (!dir) return { kind: 'error', text: '用法：/fic files <目录> [--json]' };
        return listImportFiles(dir).then((data) => ({
          kind: 'success',
          text: json
            ? JSON.stringify(data)
            : (data.files.length ? data.files.map((f) => `${f.name}　${Math.round(f.bytes / 1024)} KB`).join('\n') : '这个目录里没有 txt/md 文件。'),
        })).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      // —— 导入预览（先看分章结果，再决定是否写入） ——
      if (arg === 'preview') {
        const file = words.slice(1).join(' ');
        if (!file) return { kind: 'error', text: '用法：/fic preview <本地 txt/md 路径> [--json]' };
        return previewImport(scope(), file).then((data) => ({
          kind: 'success',
          text: json
            ? JSON.stringify(data)
            : `${data.title}：${data.encoding} / ${data.chars} 字 / ${data.chapterCount} 章${data.duplicate ? '（已导入过，不会重复写入）' : ''}\n`
              + data.chapters.map((ch) => `${ch.id}　${ch.title || '(无题)'}　${ch.chars} 字`).join('\n'),
        })).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'check') {
        const at = parts.indexOf('check');
        const next = parts[at + 1] || '';
        const chapter = next.startsWith('--') ? '' : next;
        const encoded = flagValue('--text');
        if (!chapter) return { kind: 'error', text: '用法：/fic check <章> --text <URI 编码的正文> [--json] [--source canon|fixture]' };
        if (!encoded) return { kind: 'error', text: '需要 --text（侧边栏会把草稿编码后传来；也可以用 fic_check 工具）' };
        let text = '';
        try {
          text = decodeURIComponent(encoded);
        } catch {
          return { kind: 'error', text: '--text 不是合法的 URI 编码' };
        }
        if (!text.trim()) return { kind: 'error', text: '正文是空的' };
        const wanted = flagValue('--source');
        // 默认优先用导入项目的 canon；项目还没导入时回落到夹具，免得面板第一下就报「项目不存在」。
        const loadSource = wanted === 'fixture'
          ? canonOf(scope(), 'fixture')
          : canonOf(scope(), 'canon').catch((error) => {
              if (wanted === 'canon') throw error;
              if (/项目不存在|还没有导入/.test(String(error?.message || error))) return canonOf(scope(), 'fixture');
              throw error;
            });
        return loadSource.then(async (c) => {
          const scene = c.canon.scenes.find((s) => s.chapter === chapter || s.id === chapter);
          if (!scene) return { kind: 'error', text: `没有 ${chapter} 这一章的契约场景（source=${c.source}）` };
          const checked = runCheck(text, scene, c.canon, { arm: 'C' });
          // 与 fic_check 工具同一口径：waiver 在服务端先应用，面板看到的与 conductor 看到的一致。
          let waivers = [];
          try {
            waivers = (await waiversOf(scope())).list;
          } catch {
            waivers = [];
          }
          const result = applyWaivers(checked, waivers, scene.chapter);
          const summary = result.summary || {};
          // 面板继续拿 findings（未放过的）+ suppressed（本作放过）+ waived（作者放过）。
          const findings = (result.findings || []).map((f) => ({
            detector: f.detector,
            code: f.code,
            severity: f.severity,
            quote: clamp(f.quote || '', 160),
            offset: Number.isFinite(f.offset) ? f.offset : null,
            where: f.where || '',
            why: f.why || '',
            canonRef: f.canonRef || null,
          }));
          const suppressed = (result.suppressed || []).map((f) => ({
            detector: f.detector,
            code: f.code,
            severity: f.severity,
            quote: clamp(f.quote || '', 160),
            offset: Number.isFinite(f.offset) ? f.offset : null,
            where: f.where || '',
            why: f.why || '',
            canonRef: f.canonRef || null,
            suppressedBy: f.suppressedBy || null,
          }));
          const waived = (result.waived || []).map((f) => ({
            detector: f.detector,
            code: f.code,
            severity: f.severity,
            quote: clamp(f.quote || '', 160),
            offset: Number.isFinite(f.offset) ? f.offset : null,
            why: f.why || '',
            waivedBy: f.waivedBy || null,
          }));
          const payload = {
            ok: true, source: c.source, chapter, tag: result.tag || null, chars: result.chars || 0,
            gate: GATE_DETECTORS, summary, findings, suppressed, waived,
          };
          if (json) return { kind: 'success', text: JSON.stringify(payload) };
          const lines = [`必检 5 类：${(summary.gateFindings ?? 0)} 条｜blocker ${summary.blockers ?? 0}｜warning ${summary.warnings ?? 0}｜info ${summary.infos ?? 0}`];
          if (suppressed.length) lines.push(`本作设定放过 ${suppressed.length} 条（不按原著报）`);
          if (waived.length) lines.push(`作者忽略 ${waived.length} 条（已写理由，可撤销）`);
          for (const f of findings) lines.push(`[${f.severity}] ${f.detector}/${f.code}　${f.quote}${f.why ? `\n    ${f.why}` : ''}`);
          for (const f of suppressed) lines.push(`[放过] ${f.detector}/${f.code}　${f.quote}（按「${f.suppressedBy?.title || '本作设定'}」）`);
          for (const f of waived) lines.push(`[已忽略] ${f.detector}/${f.code}　${f.quote}（理由：${f.waivedBy?.reason || '（未写）'}）`);
          return { kind: 'success', text: lines.join('\n') };
        }).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      // —— 本作设定（Fic Canon）：作者改了什么，契约优先，检查器按指纹放过 ——
      if (arg === 'delta') {
        const sub = String(words[1] || 'list').toLowerCase();
        return (async () => {
          const c = ctxOf(scope());
          const file = deltaFile(paths(c.root, c.project).dir);
          const data = await loadDeltas(file);
          if (sub === 'list') {
            return { kind: 'success', text: json ? JSON.stringify({ ok: true, ...data }) : describeDeltas(data) };
          }
          let next = data;
          let message = '';
          if (sub === 'remove') {
            const id = words[2] || decodeFlag('--remove');
            if (!id) throw new Error('用法：/fic delta remove <id>');
            next = removeDelta(data, id);
            message = `已删除本作设定 ${id}`;
          } else if (sub === 'premise') {
            next = setPremise(data, decodeFlag('--text'));
            message = '已更新本作前提';
          } else if (sub === 'add') {
            const detector = decodeFlag('--detector');
            const code = decodeFlag('--code');
            next = addDelta(data, {
              kind: decodeFlag('--kind') || 'other',
              title: decodeFlag('--title'),
              statement: decodeFlag('--text'),
              subjects: decodeFlag('--subjects'),
              fromChapter: decodeFlag('--from'),
              source: detector && code ? 'finding' : 'author',
              suppress: detector && code
                ? [{ detector, code, quote: decodeFlag('--quote'), chapter: decodeFlag('--chapter') }]
                : [],
            });
            message = '已记下本作设定';
          } else {
            throw new Error('用法：/fic delta list | add --kind <类型> --title <标题> --text <说明> [--subjects A,B] [--from ch002] [--detector <d> --code <c> --quote <q>] | remove <id> | premise --text <一句话>');
          }
          await saveDeltas(file, next);
          await audit(c.root, c.project, { action: 'delta.update', sub });
          await commitWrite(c, { kind: 'deltas' });
          return {
            kind: 'success',
            text: json ? JSON.stringify({ ok: true, ...next }) : `${message}；现在本作设定 ${next.items.length} 条`,
          };
        })().catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }

      // —— 作者私设声明（AU / 私设 / 错名）：作者说了算，适配器交给检查器 ——
      if (arg === 'declare') {
        const kind = String(words[1] || 'list').toLowerCase();
        const remove = decodeFlag('--remove');
        return (async () => {
          const c = ctxOf(scope());
          const file = declarationFile(paths(c.root, c.project).dir);
          const data = await loadDeclarations(file);
          if (kind === 'list') {
            return { kind: 'success', text: json ? JSON.stringify({ ok: true, ...data }) : describeDeclarations(data) };
          }
          let next = data;
          let message = '';
          if (remove) {
            if (kind === 'au') {
              next = removeAuRule(data, remove);
              message = `已删除 AU 规则 ${remove}`;
            } else if (kind === 'headcanon') {
              next = removeHeadcanon(data, remove);
              message = `已删除私设签名 ${remove}`;
            } else if (kind === 'typo') {
              next = removeTypo(data, remove);
              message = `已删除错名 ${remove}`;
            } else {
              throw new Error(`未知声明类型：${kind}（au | headcanon | typo）`);
            }
          } else if (kind === 'au') {
            next = addAuRule(data, {
              name: decodeFlag('--name'),
              text: decodeFlag('--text'),
              signatures: decodeFlag('--signatures'),
            });
            message = '已记下 AU 规则';
          } else if (kind === 'headcanon') {
            next = addHeadcanon(data, decodeFlag('--text'));
            message = '已记下私设签名';
          } else if (kind === 'typo') {
            next = addTypo(data, decodeFlag('--wrong'), decodeFlag('--right'));
            message = '已记下错名';
          } else {
            throw new Error('用法：/fic declare list | au --name <n> --signatures <a,b> | headcanon --text <句> | typo --wrong <错> --right <对>');
          }
          await saveDeclarations(file, next);
          await audit(c.root, c.project, { action: 'declaration.update', kind, remove: remove || null });
          await commitWrite(c, { kind: 'declarations' });
          return {
            kind: 'success',
            text: json ? JSON.stringify({ ok: true, ...next }) : `${message}；现在 AU ${next.auRules.length} / 私设 ${next.headcanonSignatures.length} / 错名 ${Object.keys(next.typos).length}`,
          };
        })().catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      // —— 章节任务卡（v0.2.0）：面板与 CLI 都走这一条 ——
      if (arg === 'plan') {
        const sub = String(words[1] || 'list').toLowerCase();
        const chapter = String(words[2] || '').trim();
        // 总开关语义：故事总控关着时，任务卡只能读不能写（面板与命令行同一道门）。
        if (sub !== 'get' && sub !== 'list' && conductorInstalled() && !effectiveOn(false, key)) {
          return { kind: 'error', text: '故事总控关着：任务卡不能改（读可以）；先 /cue on 再改。' };
        }
        return (async () => {
          const c = ctxOf(scope());
          if (sub === 'list') {
            const missions = await loadMissions(c.root, c.project);
            const revision = await readRevision(c.root, c.project);
            if (json) return { kind: 'success', text: JSON.stringify({ ok: true, project: c.project, revision: revision.revision, missions }) };
            const rows = Object.values(missions);
            return {
              kind: 'success',
              text: rows.length
                ? rows.map((m) => `${m.chapter}${m.title ? `　${m.title}` : ''}　${m.beats.length} 节拍　${m.status}`).join('\n')
                : '还没有任何章节任务卡。用 /fic plan set <章> --goal <一句话> 开始。',
            };
          }
          if (!chapter) return { kind: 'error', text: `用法：/fic plan ${sub} <章> …` };
          if (sub === 'get') {
            const mission = await loadMission(c.root, c.project, chapter);
            const revision = await readRevision(c.root, c.project);
            return {
              kind: 'success',
              text: json ? JSON.stringify({ ok: true, chapter, mission, revision: revision.revision }) : describeMission(mission),
            };
          }
          if (sub === 'clear') {
            await clearMission(c.root, c.project, chapter);
            const committed = await commitWrite(c, { kind: 'mission' });
            return {
              kind: 'success',
              text: json
                ? JSON.stringify({ ok: true, chapter, mission: null, revision: committed.revision })
                : `已删除 ${chapter} 的任务卡（契约仍可编译，只是不再注入意图）`,
            };
          }
          if (sub === 'set') {
            // 数组字段：面板用 U+001F 拼接（作者写「|」也不会被拆开）；手输时用「|」或换行都行。
            const splitFlag = (name) => {
              const raw = decodeFlag(name);
              const sep = raw.includes('\u001f') ? '\u001f' : '|';
              return raw.split(sep).map((s) => s.trim()).filter(Boolean);
            };
            const mission = await saveMission(c.root, c.project, chapter, {
              title: decodeFlag('--title'),
              pov: decodeFlag('--pov'),
              placeTime: decodeFlag('--place-time'),
              goal: decodeFlag('--goal'),
              arc: decodeFlag('--arc'),
              readerExpectation: decodeFlag('--reader'),
              anchors: flagValue('--anchors') ? splitFlag('--anchors') : undefined,
              beats: flagValue('--beats') ? splitFlag('--beats') : undefined,
              avoid: flagValue('--avoid') ? splitFlag('--avoid') : undefined,
              openQuestions: flagValue('--open') ? splitFlag('--open') : undefined,
              targetChars: flagValue('--target-chars') ? Number(flagValue('--target-chars')) : undefined,
              status: decodeFlag('--status') || undefined,
              sourceChapter: decodeFlag('--source-chapter'),
              canonRevision: (await readRevision(c.root, c.project)).revision,
            });
            const committed = await commitWrite(c, { kind: 'mission' });
            return {
              kind: 'success',
              text: json
                ? JSON.stringify({ ok: true, chapter, mission, revision: committed.revision })
                : `${describeMission(mission)}\n（项目版本 v${committed.revision}）`,
            };
          }
          throw new Error('用法：/fic plan list | get <章> | set <章> [--goal][--arc][--beats a|b][--open q1|q2]… | clear <章>');
        })().catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      // —— 派生导出块：升级到 0.2.0 后跑一次，让 voice 能读到禁忌/称呼 ——
      if (arg === 'exports') {
        const c = ctxOf(scope());
        return commitWrite(c, { kind: 'exports' }).then((committed) => {
          const forbidden = committed.project?.exports?.forbidden || [];
          const addresses = committed.project?.exports?.addresses || [];
          return {
            kind: 'success',
            text: json
              ? JSON.stringify({ ok: true, project: c.project, revision: committed.revision, exports: committed.project?.exports || null })
              : `已刷新 ${c.project} 的导出块：禁忌 ${forbidden.length} 条、称呼 ${addresses.length} 条（v${committed.revision}）`,
          };
        }).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'waive') {
        const chapter = words[1] || '';
        const code = words[2] || '';
        const reason = decodeFlag('--reason');
        const quote = decodeFlag('--quote');
        return addWaiver(scope(), { chapter, code, reason, quote })
          .then((w) => ({
            kind: 'success',
            text: json ? JSON.stringify({ ok: true, waiver: w }) : `已忽略 ${w.chapter} ${w.detector}/${w.code}（${w.reason}）`,
          }))
          .catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'unwaive') {
        const id = words[1] || '';
        if (!id) return { kind: 'error', text: '用法：/fic unwaive <wv_id>' };
        return removeWaiver(scope(), id)
          .then(() => ({ kind: 'success', text: json ? JSON.stringify({ ok: true, id }) : `已撤销 ${id}` }))
          .catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'review') {
        return panelPayload(scope(), key, { light: true }).then((data) => {
          const payload = { ok: data.ok, pending: data.pending, contradictions: data.contradictions, error: data.error };
          if (json) return { kind: 'success', text: JSON.stringify(payload) };
          const lines = [];
          lines.push(`待审 ${data.pending.length} 条：`);
          for (const item of data.pending) lines.push(`  ${item.id}　[${item.kind}] ${item.label}`);
          lines.push(`未裁决矛盾 ${data.contradictions.length} 条：`);
          for (const fc of data.contradictions) lines.push(`  ${fc.id}　${fc.description}${fc.values?.length ? `（${fc.values.join(' / ')}）` : ''}`);
          lines.push('', '确认：/fic confirm <id>　拒绝：/fic reject <id>　裁决：/fic resolve <fc_id> later|earlier|both');
          return { kind: 'success', text: lines.join('\n') };
        });
      }
      if (arg === 'confirm' || arg === 'reject') {
        const ids = words.slice(1).join(',');
        if (!ids) return { kind: 'error', text: `用法：/fic ${arg} <id>[,<id>…]` };
        return applyReview(arg, Object.assign({ ids }, scope())).then((done) => ({
          kind: 'success',
          text: `${arg === 'confirm' ? '已确认' : '已拒绝'} ${done.length} 条：${done.join('、') || '（没有匹配的 id）'}`,
        })).catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'resolve') {
        const id = words[1];
        const choice = words[2];
        if (!id || !choice) return { kind: 'error', text: '用法：/fic resolve <fc_id> later|earlier|both|reject_new' };
        const c = ctxOf(scope());
        return loadProject(c.root, c.project)
          .then(({ canon }) => {
            const fc = resolveContradiction(canon, id, choice);
            return saveCanon(c.root, c.project, canon)
              .then(() => audit(c.root, c.project, { action: 'canon.resolve', id, choice }))
              .then(() => commitWrite(c, { kind: 'canon', canon }))
              .then(() => fc);
          })
          .then((fc) => ({ kind: 'success', text: `已裁决 ${fc.id}：${fc.resolution}（状态 ${fc.status}）` }))
          .catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'import') {
        const file = words.slice(1).join(' ');
        if (!file) return { kind: 'error', text: '用法：/fic import <本地 txt/md 路径>' };
        const c = ctxOf(scope());
        return ingestFile({ root: c.root, project: c.project, file })
          .then((result) => {
            // 导入成功后把这个项目设为当前项目：面板打开就是这本新书。
            // revision 由 ingestFile 自己 +1（导入就是一次账本写入），这里不重复提交。
            if (!result.duplicate) savePreference({ project: c.project });
            return {
              kind: 'success',
              text: result.duplicate
                ? `同一份文件已经导入过（sha256 ${String(result.meta?.sha256 || '').slice(0, 12)}），没有重复写入。`
                : `已导入：${result.meta.chapters || '?'} · ${result.chapters.length} 章 · ${result.meta.chars} 字（${result.encoding || result.meta?.encoding}）`,
            };
          })
          .catch((error) => ({ kind: 'error', text: String(error?.message || error) }));
      }
      if (arg === 'on') {
        if (!key) return { kind: 'error', text: '当前没有可归属的会话，/fic 无法启用。' };
        enabledAgents.add(key);
        optedOut.delete(key);
        savePreference(true);
        return {
          kind: 'success',
          text: '同人工作室已开启：fic_state / fic_source / fic_contract / fic_check / fic_lookup 现在可用。'
            + '已记住这个选择，下次启动 DSH 不用再 /fic on（本进程其他会话保持原状态）。',
        };
      }
      if (arg === 'off') {
        if (key) {
          enabledAgents.delete(key);
          optedOut.add(key);
        }
        savePreference(false);
        return { kind: 'success', text: '同人工作室已收起，fic_* 工具从本会话移除；这个选择也记住了（下次启动同样关闭）。' };
      }
      const on = isOn({ session: { id: key } });
      const installed = conductorInstalled();
      const driven = installed && effectiveOn(false, key);
      const usable = effectiveOn(on, key);
      const head = usable
        ? `同人工作室：可用（独立开关：${on ? '开' : '关'}）。fic_state / fic_source / fic_contract / fic_check / fic_plan / fic_lookup 可用。`
        : `同人工作室：不可用（独立开关：${on ? '开' : '关'}）。`;
      const tail = installed
        ? (driven
          ? '\n故事总控：本会话开——同人工具随总控生效，/fic on 的状态只作独立模式偏好。'
          : '\n故事总控：本会话关——装了故事总控时它说了算，四个插件都不工作；要写同人就 /cue on。')
        : (on ? '' : '\n输入 /fic on 启用（工具默认不可见，启用前不会占用上下文）。');
      return { kind: 'success', text: head + tail };
    },
  };
  ctx.commands.register(ficCommand);

  // 面板读接口（0.2.3）：与 /fic 命令共用同一个 handler，但不经过 commands.execute，
  // 所以读面板不会写 command/run / command/done。remote 半（lib/remote.js）只读这一层。
  if (typeof ctx.provide === 'function') {
    const panelView = {
      apiVersion: 1,
      async dispatch(agent, line) {
        return await ficCommand.handler({
          agent,
          rawInput: String(line || ''),
          attachments: [],
          signal: new AbortController().signal,
        });
      },
      async getAvatar(agent, request = {}) {
        const c = ctxOf(request);
        if (!request.characterId) throw new Error('characterId 必填');
        return await resolveAvatar(c.root, c.project, String(request.characterId));
      },
      async avatar(agent, request = {}) {
        return await avatarAction(request);
      },
      async media(agent, request = {}) {
        return await mediaAction(request);
      },
      async analysis(agent, request = {}) {
        return await analysisReport(request);
      },
    };
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.provide('novelFanficPanelView', panelView));
    } else {
      ctx.provide('novelFanficPanelView', panelView);
    }
  }

  // ── 只读服务：novelFanfic（v0.2.0）──────────────────────────────────────────
  // 与契约 §3 一致：只读、第一参数是绝对 cwd、永不读夹具、revision 与内容同快照。
  const service = createService({ version: PLUGIN_VERSION, subscribe: subscribeChange });
  if (typeof ctx.provide === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.provide('novelFanfic', service));
  } else if (typeof ctx.provide === 'function') {
    ctx.provide('novelFanfic', service);
  } else {
    // 老宿主没有 ctx.provide：不提供服务，也不要用直接赋值（Cordis 会抛
    // "cannot set property without provide"，conductor 0.1.0 就踩过这个坑）。
    ctx.logger?.warn?.('[novel-fanfic] 宿主没有 ctx.provide，novelFanfic 服务未注册（面板与工具不受影响）');
  }
}
