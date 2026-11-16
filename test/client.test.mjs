// 客户端模块的单元测试：不启动浏览器，用假的 window.__ModuleLoader__ 捕获 factory，
// 再用假 ctx 调 apply，验证侧栏 tab / 面板 / 入口按钮的注册与数据通道约定。
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

function fakeCtx(execute) {
  const calls = { tabTypes: [], registered: [], injected: [], effects: 0, openedTab: null };
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
    remote: { commands: { execute } },
    effect(fn) {
      calls.effects += 1;
      return fn();
    },
  };
  return { ctx, calls };
}

test('client 导出 inject 并注册侧栏 tab type、面板与入口按钮', async () => {
  const { definition, module } = await loadClientModule();
  assert.equal(definition.id, 'dsh-novel-fanfic');
  assert.equal(typeof module.apply, 'function');
  assert.ok(module.inject.includes('slots'));
  assert.ok(module.inject.includes('remote.commands'));

  const { ctx, calls } = fakeCtx(async () => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '{}' } } }));
  module.apply(ctx);

  assert.equal(calls.tabTypes.length, 1);
  const tab = calls.tabTypes[0];
  assert.equal(tab.id, 'dsh-novel-fanfic');
  assert.equal(tab.kind, 'fanfic');
  assert.equal(tab.title(), '同人');
  assert.equal(tab.guide[0].title(), '同人工作室');
  assert.equal(typeof tab.guide[0].description(), 'string');

  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
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

test('面板的 load 走 /fic panel --json，enable 走 /fic on', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const payload = { ok: true, project: 'fixture-a', status: { enabled: true, fixture: { chapters: 6 } }, chapters: [], pending: [], contradictions: [] };
  const { ctx, calls } = fakeCtx(async (sessionId, line) => {
    executed.push({ sessionId, line });
    if (line === '/fic panel --json') {
      return { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(payload) } } };
    }
    if (line === '/fic on') {
      return { ok: true, value: { commandId: 'c2', result: { kind: 'success', text: '同人写作闸门已开启' } } };
    }
    return { ok: true, value: { commandId: 'c3', result: { kind: 'error', text: '未知命令' } } };
  });
  module.apply(ctx);

  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-42');
  const snap = await face.load();
  assert.deepEqual(snap, payload);
  assert.deepEqual(executed[0], { sessionId: 'session-42', line: '/fic panel --json' });

  const text = await face.enable();
  assert.match(text, /已开启/);
  assert.deepEqual(executed[1], { sessionId: 'session-42', line: '/fic on' });
});

test('命令报错时 load 抛出可读错误（面板会显示原因）', async () => {
  const { module } = await loadClientModule();
  const { ctx, calls } = fakeCtx(async () => ({
    ok: true,
    value: { commandId: 'c1', result: { kind: 'error', text: '/fic 不可用' } },
  }));
  module.apply(ctx);
  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-x');
  await assert.rejects(() => face.load(), /\/fic 不可用/);
});

test('RPC 层失败与未知命令都有可读提示', async () => {
  const { module } = await loadClientModule();
  {
    const { ctx, calls } = fakeCtx(async () => ({ ok: false, error: { message: 'session not found', code: 'NOT_FOUND' } }));
    module.apply(ctx);
    const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
    await assert.rejects(() => pane.options.inject('s1').load(), /session not found/);
  }
  {
    const { ctx, calls } = fakeCtx(async () => ({ ok: true, value: undefined }));
    module.apply(ctx);
    const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
    await assert.rejects(() => pane.options.inject('s2').load(), /未知命令/);
  }
});

test('入口按钮调用 sidebarRight.openTab("fanfic")', async () => {
  const { module } = await loadClientModule();
  const { ctx, calls } = fakeCtx(async () => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '{}' } } }));
  module.apply(ctx);
  const header = calls.registered.find(({ options }) => options.name === 'conversation.session.header.utilities');
  const face = header.options.inject('session-y');
  face.open();
  assert.equal(calls.openedTab, 'fanfic');
});

test('写入视图的动作分别走 chapter / confirm / reject / resolve 命令', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls } = fakeCtx(async (sessionId, line) => {
    executed.push(line);
    const text = line.indexOf('chapter') >= 0
      ? JSON.stringify({ ok: true, id: 'ch001', title: '雾港初逢', chars: 4, text: '正文…' })
      : '完成';
    return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: text } } };
  });
  module.apply(ctx);
  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-write');

  const body = await face.chapter('ch001');
  assert.equal(body.text, '正文…');
  await face.confirm(['fact_011']);
  await face.reject(['fact_012']);
  await face.resolve('fc_001', 'later');

  assert.deepEqual(executed, [
    '/fic chapter ch001 --json',
    '/fic confirm fact_011',
    '/fic reject fact_012',
    '/fic resolve fc_001 later',
  ]);
});

test('面板的导入与草稿检查分别走 import 和 check（正文先做 URI 编码）', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls } = fakeCtx(async (sessionId, line) => {
    executed.push(line);
    const text = line.startsWith('/fic check')
      ? JSON.stringify({ ok: true, chapter: 'ch002', findings: [], summary: { blockers: 0 } })
      : '已导入：6 章';
    return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: text } } };
  });
  module.apply(ctx);
  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-draft');

  const imported = await face.importSource('D:\\books\\a b.txt');
  assert.match(imported, /已导入/);
  const draft = '“沈先生。”裴照说。\n钟声散了。';
  const checked = await face.checkDraft('ch002', draft);
  assert.equal(checked.chapter, 'ch002');
  assert.equal(executed[0], '/fic import D:\\books\\a b.txt');
  assert.equal(executed[1], '/fic check ch002 --json --text ' + encodeURIComponent(draft));
});

test('项目切换与导入预览：命令带 --project，预览走 /fic preview', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls } = fakeCtx(async (sessionId, line) => {
    executed.push(line);
    let text = '{}';
    if (line.startsWith('/fic panel')) text = JSON.stringify({ ok: true, project: 'other' });
    else if (line.startsWith('/fic projects')) text = JSON.stringify({ ok: true, current: 'other', projects: [{ id: 'other', title: '另一本' }] });
    else if (line.startsWith('/fic preview')) text = JSON.stringify({ ok: true, title: '书', chapterCount: 2, chapters: [] });
    return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: text } } };
  });
  module.apply(ctx);
  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-project');

  const snapshot = await face.load('other');
  assert.equal(snapshot.project, 'other');
  const list = await face.projects();
  assert.equal(list.projects[0].id, 'other');
  const preview = await face.preview('D:\\books\\a b.txt', 'other');
  assert.equal(preview.title, '书');
  await face.confirm(['fact_001'], 'other');

  assert.deepEqual(executed, [
    '/fic panel --json --project other',
    '/fic projects --json',
    '/fic preview D:\\books\\a b.txt --json --project other',
    '/fic confirm fact_001 --project other',
  ]);
});

test('作者私设：declare 走 /fic declare，值做 URI 编码，删除走 --remove', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls } = fakeCtx(async (sessionId, line) => {
    executed.push(line);
    return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: JSON.stringify({ ok: true, auRules: [], headcanonSignatures: [], typos: {} }) } } };
  });
  module.apply(ctx);
  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-declare');

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
  const { ctx, calls } = fakeCtx(async (sessionId, line) => {
    executed.push(line);
    const text = line.startsWith('/fic waive')
      ? JSON.stringify({ ok: true, waiver: { id: 'wv_001' } })
      : JSON.stringify({ ok: true, id: 'wv_001' });
    return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: text } } };
  });
  module.apply(ctx);
  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-waive');

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

test('目录选择：pickdir 失败时把 JSON 提示交回面板；files 走 /fic files', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls } = fakeCtx(async (sessionId, line) => {
    executed.push(line);
    if (line.startsWith('/fic pickdir')) {
      return { ok: true, value: { commandId: 'c', result: { kind: 'error', text: JSON.stringify({ ok: false, reason: 'unavailable', text: '当前宿主没有目录选择器' }) } } };
    }
    return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: JSON.stringify({ ok: true, dir: 'D:/books', files: [{ name: 'a.txt', path: 'D:/books/a.txt', bytes: 10 }] }) } } };
  });
  module.apply(ctx);
  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-pick');

  const picked = await face.pickDir();
  assert.equal(picked.ok, false);
  assert.match(picked.text, /没有目录选择器/);
  const listed = await face.files('D:/books');
  assert.equal(listed.files[0].name, 'a.txt');
  assert.deepEqual(executed, ['/fic pickdir --json', '/fic files D:/books --json']);
});

test('写作抽屉与原文检索分别走 contract 和 search', async () => {
  const { module } = await loadClientModule();
  const executed = [];
  const { ctx, calls } = fakeCtx(async (sessionId, line) => {
    executed.push(line);
    const text = line.startsWith('/fic contract')
      ? JSON.stringify({ ok: true, chapter: 'ch002', tags: { 视角: '沈砚' }, markdown: '# 场景契约' })
      : JSON.stringify({ ok: true, term: '阿砚', total: 1, hits: [{ chapter: 'ch002', offset: 165, quote: '“阿砚。”' }] });
    return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: text } } };
  });
  module.apply(ctx);
  const pane = calls.registered.find(({ options }) => options.name === 'sidebar.right.pane.tab');
  const face = pane.options.inject('session-writing');

  const contract = await face.contract('ch002');
  assert.equal(contract.tags['视角'], '沈砚');
  const found = await face.search('阿砚');
  assert.equal(found.total, 1);
  assert.deepEqual(executed, ['/fic contract ch002 --json', '/fic search 阿砚 --json --limit 20']);
});
