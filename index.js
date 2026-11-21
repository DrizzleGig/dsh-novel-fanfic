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
  /** 舞台监督接管：conductor 开着时，本会话也能用 fic_*（不改自己的持久偏好）。 */
  const drivenBy = (agent) => {
    const key = keyOf(agent);
    if (!key) return false;
    try {
      const conductor = ctx.get?.('novelConductor');
      return conductor?.isDriving?.(key) === true;
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
  }, { when: (context) => isOn(context.agent) || drivenBy(context.agent) });

  // ── 工具 2：原著导入 / 读取 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'fic_source',
    description:
      '管理原著来源。action=import（file=本地 txt/md 路径，UTF-8 或 GB18030，≤20MB，重复文件会被 sha256 拦下）、'
      + 'action=list（列出已导入的章节）、action=read（chapter=chNNN，读该章正文）、action=index（读确定性索引：人物候选/称呼/统计）。'
      + '导入只做存储与分章，不生成 canon；canon 走提案与人工确认。',
    parameters: parameterSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['import', 'list', 'read', 'index'],
        description: 'import | list | read | index。',
      },
      file: { type: 'string', description: 'action=import 时的本地文件路径。' },
      chapter: { type: 'string', description: 'action=read 时的章节 id，如 ch002。' },
      limit: { type: 'integer', description: 'action=read 时最多返回多少字，默认 4000。' },
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
  }, { when: (context) => isOn(context.agent) || drivenBy(context.agent) });

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
  }, { when: (context) => isOn(context.agent) || drivenBy(context.agent) });

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
  }, { when: (context) => isOn(context.agent) || drivenBy(context.agent) });

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
  }, { when: (context) => isOn(context.agent) || drivenBy(context.agent) });

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
  }, { when: (context) => isOn(context.agent) || drivenBy(context.agent) });

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
  ctx.commands.register({
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
      const words = parts.filter((p, i) => !p.startsWith('--') && parts[i - 1] !== '--project');
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
      return {
        kind: 'success',
        text: on
          ? '同人工作室：已开启。可用 fic_state / fic_source / fic_contract / fic_check / fic_lookup。'
          : '同人工作室：关闭。输入 /fic on 启用（工具默认不可见，启用前不会占用上下文）。',
      };
    },
  });

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
