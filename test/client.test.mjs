// 客户端模块的单元测试：不启动浏览器，用假的 window.__ModuleLoader__ 捕获 factory，
// 再用假 ctx 调 apply，验证侧栏 tab / 面板 / 入口按钮的注册与数据通道约定。
//
// v0.2.3：面板读取走 panel remote（Host 进程内），不再执行 /fic 命令；写操作仍走命令。
// 这里的 harness 同时提供假 remote 与假命令通道，任何读操作落到命令通道都会失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
}

async function loadClientModule() {
  const source = await readFile(clientPath, 'utf8');
  const loaded = [];
  const window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
  const require = (id) => {
    if (id === 'react') return fakeReact();
    throw new Error(`unexpected require: ${id}`);
  };
  // 客户端模块是浏览器脚本，不是 ESM：用 Function 提供 window/require。
  new Function('window', 'require', source)(window, require);
  assert.equal(loaded.length, 1, 'client.js 应当调用一次 __ModuleLoader__.load');
  const module = loaded[0].factory(require);
  return { definition: loaded[0], module, react: fakeReact() };
}

const METHODS = [
  'identity', 'getPanel', 'listProjects', 'getChapter', 'getContract', 'getPlan',
  'search', 'previewImport', 'listImportFiles', 'checkDraft', 'pickDirectory', 'getDeltas',
];

/**
 * 假宿主：remote 的每个方法都记一笔并返回同一个 payload；
 * 命令通道默认抛错——读操作一旦退回命令就会当场暴露。
 */
function fakeCtx({ execute, payload } = {}) {
  const calls = { tabTypes: [], registered: [], injected: [], effects: 0, openedTab: null };
  const remoteCalls = [];
  const panel = {};
  for (const method of METHODS) {
    panel[method] = async (sessionId, request) => {
      remoteCalls.push({ method, sessionId, request });
      const value = typeof payload === 'function' ? payload(method, request) : payload;
      return { ok: true, value };
    };
  }
  const ctx = {
    slots: {
      inject(key, cb) {
        calls.injected.push(key);
        return cb();
      },
      register(options, component) {
        calls.registered.push({ options, component });
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(definition) {
        calls.tabTypes.push(definition);
        return () => {};
      },
    },
    sidebarRight: {
      openTab(kind) {
        calls.openedTab = kind;
      },
    },
    remote: {
      async $mount() {
        return () => {};
      },
      commands: {
        execute: execute ?? (async () => {
          throw new Error('读操作不应执行命令');
        }),
      },
    },
    get(key) {
      if (key === 'remote.novelFanficPanel') return panel;
      return undefined;
    },
    effect(fn) {
      calls.effects += 1;
      return fn();
    },
  };
  return { ctx, calls, remoteCalls };
}

const paneOf = (calls) => calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');

test('client 导出 inject 并注册侧栏 tab type、面板与入口按钮', async () => {
  const { definition, module } = await loadClientModule();
  assert.equal(definition.id, 'dsh-novel-fanfic');
  assert.equal(typeof module.apply, 'function');
  assert.ok(module.inject.includes('slots'));
  assert.ok(module.inject.includes('remote.commands'));

  const { ctx, calls } = fakeCtx();
  await module.apply(ctx);

  assert.equal(calls.tabTypes.length, 1);
  const tab = calls.tabTypes[0];
  assert.equal(tab.id, 'dsh-novel-fanfic');
  assert.equal(tab.kind, 'fanfic');
  assert.equal(tab.title(), '同人');
  assert.equal(tab.guide[0].title(), '同人工作室');
  assert.equal(typeof tab.guide[0].description(), 'string');

  const pane = paneOf(calls);
  assert.ok(pane, '应当注册 sidebar.right.pane.tab');
  assert.equal(pane.options.key, 'dsh-novel-fanfic');
  assert.equal(typeof pane.component, 'function');

  const header = calls.registered.find(({ options }) => options.name === 'conversation.session.header.utilities');
  assert.ok(header, '应当注册会话头按钮');
  assert.equal(header.options.id, 'novel-fanfic-open');

  assert.deepEqual(calls.injected.sort(), [
    'conversation.session.header.utilities',
    'sidebar.right.pane.tab',
  ]);
});

test('面板读取走 panel remote；enable 仍走 /fic on', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const payload = { ok: true, project: 'fixture-a', status: { enabled: true }, chapters: [], pending: [], contradictions: [] };
  const { ctx, calls, remoteCalls } = fakeCtx({
    payload: (method) => (method === 'getPanel' ? payload : { ok: true }),
    execute: async (sessionId, line) => {
      executed.push({ sessionId, line });
      return { ok: true, value: { commandId: 'c2', result: { kind: 'success', text: '同人工作室已开启' } } };
    },
  });
  await module.apply(ctx);

  const face = paneOf(calls).options.inject('session-42');
  const snap = await face.load();
  assert.deepEqual(snap, payload);
  assert.deepEqual(remoteCalls[0], { method: 'getPanel', sessionId: 'session-42', request: { project: null } });

  const text = await face.enable();
  assert.match(text, /已开启/);
  assert.deepEqual(executed, [{ sessionId: 'session-42', line: '/fic on' }]);
});

test('面板读接口报错时 load 抛出可读错误（面板会显示原因）', async () => {
  const { module } = await loadClientModule();
  const { ctx, calls } = fakeCtx();
  // 覆盖 remote：getPanel 直接抛错
  const original = ctx.get;
  ctx.get = (key) => (key === 'remote.novelFanficPanel'
    ? new Proxy({}, { get: () => async () => { throw new Error('面板读接口未就绪：请更新并重载 DSH'); } })
    : original(key));
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('session-x');
  await assert.rejects(() => face.load(), /面板读接口未就绪/);
});

test('remote 返回 { ok:false } 时给出可读原因（不回退命令）', async () => {
  const { module } = await loadClientModule();
  const { ctx, calls } = fakeCtx();
  const panel = {
    getPanel: async () => ({ ok: false, error: { message: 'session not found', code: 'NOT_FOUND' } }),
  };
  const original = ctx.get;
  ctx.get = (key) => (key === 'remote.novelFanficPanel' ? panel : original(key));
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('s1');
  await assert.rejects(() => face.load(), /session not found/);
});

test('入口按钮调用 sidebarRight.openTab("fanfic")', async () => {
  const { module } = await loadClientModule();
  const { ctx, calls } = fakeCtx();
  await module.apply(ctx);
  const header = calls.registered.find(({ options }) => options.name === 'conversation.session.header.utilities');
  const face = header.options.inject('session-y');
  face.open();
  assert.equal(calls.openedTab, 'fanfic');
});

test('读章节走 remote；确认/拒绝/裁决仍走命令，并显式带项目', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls, remoteCalls } = fakeCtx({
    payload: (method) => (method === 'getChapter'
      ? { ok: true, id: 'ch001', title: '雾港初逢', chars: 4, text: '正文…' }
      : { ok: true }),
    execute: async (sessionId, line) => {
      executed.push(line);
      return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: '完成' } } };
    },
  });
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('session-write');

  const body = await face.chapter('ch001', 'other');
  assert.equal(body.text, '正文…');
  assert.deepEqual(remoteCalls[0].request, { chapter: 'ch001', project: 'other' });

  await face.confirm(['fact_011'], 'other');
  await face.reject(['fact_012'], 'other');
  await face.resolve('fc_001', 'later', 'other');

  assert.deepEqual(executed, [
    '/fic confirm fact_011 --project other',
    '/fic reject fact_012 --project other',
    '/fic resolve fc_001 later --project other',
  ]);
});

test('导入仍走命令；草稿检查走 remote（不发命令）', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls, remoteCalls } = fakeCtx({
    payload: () => ({ ok: true, chapter: 'ch002', findings: [], summary: { blockers: 0 } }),
    execute: async (sessionId, line) => {
      executed.push(line);
      return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: '已导入：6 章' } } };
    },
  });
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('session-draft');

  const imported = await face.importSource('D:\\books\\a b.txt');
  assert.match(imported, /已导入/);
  const draft = '“沈先生。”裴照说。\n钟声散了。';
  const checked = await face.checkDraft('ch002', draft, 'other');
  assert.equal(checked.chapter, 'ch002');

  assert.deepEqual(executed, ['/fic import D:\\books\\a b.txt']);
  assert.deepEqual(remoteCalls[0].request, { chapter: 'ch002', text: draft, project: 'other' });
});

test('项目切换与导入预览：读走 remote 的 project 字段，写命令带 --project', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls, remoteCalls } = fakeCtx({
    payload: (method) => {
      if (method === 'getPanel') return { ok: true, project: 'other' };
      if (method === 'listProjects') return { ok: true, current: 'other', projects: [{ id: 'other', title: '另一本' }] };
      if (method === 'previewImport') return { ok: true, title: '书', chapterCount: 2, chapters: [] };
      return { ok: true };
    },
    execute: async (sessionId, line) => {
      executed.push(line);
      return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: '{}' } } };
    },
  });
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('session-project');

  const snapshot = await face.load('other');
  assert.equal(snapshot.project, 'other');
  const list = await face.projects();
  assert.equal(list.projects[0].id, 'other');
  const preview = await face.preview('D:\\books\\a b.txt', 'other');
  assert.equal(preview.title, '书');
  await face.confirm(['fact_001'], 'other');

  assert.deepEqual(remoteCalls.map((c) => c.method), ['getPanel', 'listProjects', 'previewImport']);
  assert.deepEqual(remoteCalls[0].request, { project: 'other' });
  assert.deepEqual(executed, ['/fic confirm fact_001 --project other']);
});

test('作者私设：declare 走 /fic declare，值做 URI 编码，删除走 --remove', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls } = fakeCtx({
    execute: async (sessionId, line) => {
      executed.push(line);
      return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: '{"ok":true}' } } };
    },
  });
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('session-declare');

  await face.declare('au', { name: '回魂钟', signatures: '回魂,亡者的声音', text: 'AU' }, 'other');
  await face.declare('typo', { remove: '沈研' }, 'other');

  assert.deepEqual(executed, [
    '/fic declare au --name ' + encodeURIComponent('回魂钟')
      + ' --text ' + encodeURIComponent('AU')
      + ' --signatures ' + encodeURIComponent('回魂,亡者的声音') + ' --json --project other',
    '/fic declare typo --remove ' + encodeURIComponent('沈研') + ' --json --project other',
  ]);
});

test('忽略：waive 编码 quote/reason，unwaive 走 id，都可带项目', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls } = fakeCtx({
    execute: async (sessionId, line) => {
      executed.push(line);
      const text = line.startsWith('/fic waive')
        ? JSON.stringify({ ok: true, waiver: { id: 'wv_001' } })
        : JSON.stringify({ ok: true, id: 'wv_001' });
      return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: text } } };
    },
  });
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('session-waive');

  const quote = '“沈先生。”裴照说。';
  const created = await face.waive('ch002', 'address/address_retired', quote, '想保留这句', 'other');
  assert.equal(created.waiver.id, 'wv_001');
  await face.unwaive('wv_001', 'other');

  assert.deepEqual(executed, [
    '/fic waive ch002 address/address_retired --quote ' + encodeURIComponent(quote)
      + ' --reason ' + encodeURIComponent('想保留这句') + ' --json --project other',
    '/fic unwaive wv_001 --json --project other',
  ]);
});

test('目录选择与文件列表走 remote（只有点击时才调用 pickDirectory）', async () => {
  const { module } = await loadClientModule();
  const { ctx, calls, remoteCalls } = fakeCtx({
    payload: (method) => (method === 'pickDirectory'
      ? { ok: false, reason: 'unavailable', text: '当前宿主没有目录选择器' }
      : { ok: true, dir: 'D:/books', files: [{ name: 'a.txt', path: 'D:/books/a.txt', bytes: 10 }] }),
  });
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('session-pick');

  const picked = await face.pickDir();
  assert.equal(picked.ok, false);
  assert.match(picked.text, /没有目录选择器/);
  const listed = await face.files('D:/books');
  assert.equal(listed.files[0].name, 'a.txt');
  assert.deepEqual(remoteCalls.map((c) => c.method), ['pickDirectory', 'listImportFiles']);
  assert.deepEqual(remoteCalls[1].request, { dir: 'D:/books' });
});

test('写作抽屉与原文检索走 remote；搜索把 term/limit 结构化传过去', async () => {
  const { module } = await loadClientModule();
  const { ctx, calls, remoteCalls } = fakeCtx({
    payload: (method) => {
      if (method === 'getContract') return { ok: true, chapter: 'ch002', tags: { 视角: '沈砚' }, markdown: '# 场景契约' };
      if (method === 'search') return { ok: true, term: '阿砚', total: 1, hits: [{ chapter: 'ch002', offset: 165 }] };
      return { ok: true };
    },
  });
  await module.apply(ctx);
  const face = paneOf(calls).options.inject('session-writing');

  const contract = await face.contract('ch002');
  assert.equal(contract.tags['视角'], '沈砚');
  const found = await face.search('阿砚');
  assert.equal(found.total, 1);
  assert.deepEqual(remoteCalls.map((c) => c.method), ['getContract', 'search']);
  assert.deepEqual(remoteCalls[1].request, { term: '阿砚', limit: 20, project: null });
});
