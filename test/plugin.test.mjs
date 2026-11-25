// 插件入口的单元测试：用假的 ctx 捕获注册，验证 8 个 fic_* 工具、/fic 开关语义与工具输出。
// 不启动 DSH 宿主；宿主侧的安装与启用另见 dev 脚手架的验收文档。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply, name, inject } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '..');

function harness(overrides = {}) {
  const tools = [];
  const commands = [];
  const ctx = {
    tools: {
      register(definition, options) {
        tools.push({ definition, options });
        return () => {};
      },
    },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
  };
  apply(ctx, {
    root: repoRoot,
    project: 'fixture-a',
    fixture: 'dsh-novel-fanfic/fixtures/fixture-a',
    stateDir: mkdtempSync(path.join(os.tmpdir(), 'fic-pref-')),
    ...overrides,
  });
  return { tools, commands, ctx };
}

const byName = (tools) => Object.fromEntries(tools.map(({ definition }) => [definition.name, definition]));

test('插件导出 name / inject，注册 8 个 fic 工具和 /fic 命令', () => {
  assert.equal(name, 'novel-fanfic');
  assert.deepEqual(inject, ['tools', 'commands']);
  const { tools, commands } = harness();
  assert.deepEqual(
    tools.map(({ definition }) => definition.name).sort(),
    // v0.2.0 起多了 fic_plan；0.4.0 起多了 fic_avatar；0.4.2 起多了 fic_analyze
    ['fic_analyze', 'fic_avatar', 'fic_check', 'fic_contract', 'fic_lookup', 'fic_plan', 'fic_source', 'fic_state'],
  );
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'fic');
});

test('所有 fic 工具向宿主提供完整 JSON Schema', () => {
  const definitions = byName(harness().tools);
  for (const { parameters } of Object.values(definitions)) {
    assert.equal(parameters.type, 'object');
    assert.equal(typeof parameters.properties, 'object');
    for (const schema of Object.values(parameters.properties)) {
      assert.equal(typeof schema.type, 'string');
      assert.equal(schema.required, undefined, 'required 应是参数名列表，不是字段 schema 的属性');
      if (schema.type === 'array') assert.equal(typeof schema.items?.type, 'string');
    }
    for (const name of parameters.required || []) {
      assert.equal(typeof name, 'string');
      assert.ok(Object.hasOwn(parameters.properties, name));
    }
  }

  const plan = definitions.fic_plan.parameters;
  assert.deepEqual(plan.required, ['chapter']);
  assert.deepEqual(plan.properties.title, { type: 'string', description: '这一章的一句话标题' });
});

test('0.2.0 回归：参数表不会顶到 schema 根（title 撞 JSON Schema 注解关键字）', () => {
  // 0.2.0 把整张「参数名 → 描述对象」表当 parameters 交给宿主，宿主原样透传给模型接口；
  // 接口按 JSON Schema 解析根级键，title 是注解关键字、必须是字符串 → 每条消息 400。
  const allowedRootKeys = ['type', 'properties', 'required', 'additionalProperties'];
  for (const [toolName, { parameters }] of Object.entries(byName(harness().tools))) {
    assert.deepEqual(
      Object.keys(parameters).filter((key) => !allowedRootKeys.includes(key)),
      [],
      `${toolName} 的 parameters 根级只允许 JSON Schema 关键字`,
    );
    assert.equal(parameters.title, undefined, `${toolName} 的参数名不能落在 schema 根上`);
    assert.equal(parameters.chapter, undefined);
  }
  const plan = byName(harness().tools).fic_plan.parameters;
  assert.deepEqual(Object.keys(plan).sort(), ['properties', 'required', 'type']);
  assert.deepEqual(plan.properties.title, { type: 'string', description: '这一章的一句话标题' });
});

test('工具默认不可见，/fic on 之后才对同一会话可见', () => {
  const { tools, commands } = harness();
  const agent = { session: { id: 'session-a' } };
  for (const { options } of tools) {
    assert.equal(typeof options.when, 'function');
    assert.equal(options.when({ agent }), false);
  }
  const on = commands[0].handler({ agent, rawInput: 'on' });
  assert.equal(on.kind, 'success');
  for (const { options } of tools) assert.equal(options.when({ agent }), true);
  // 别的会话不受影响
  assert.equal(tools[0].options.when({ agent: { session: { id: 'session-b' } } }), false);
  const off = commands[0].handler({ agent, rawInput: 'off' });
  assert.equal(off.kind, 'success');
  assert.equal(tools[0].options.when({ agent }), false);
});

test('fic_state 读夹具与 canon 项目；fic_contract 输出九段契约', async () => {
  const { tools } = harness();
  const defs = byName(tools);
  const state = await defs.fic_state.execute({});
  assert.equal(state.ok, true);
  assert.match(state.text, /夹具：6 章/u);
  assert.match(state.text, /契约漂移：0 份/u);
  const hasProject = existsSync(path.join(repoRoot, '.dsh-novel-fanfic', 'fixture-a', 'project.json'));
  if (hasProject) assert.match(state.text, /设定矛盾：open 1/u);
  else assert.match(state.text, /项目不存在/u);

  const contract = await defs.fic_contract.execute({ chapter: 'ch002' });
  assert.equal(contract.ok, true);
  for (const tag of ['视角', '在场', '称呼', '知情', '世界规则', '时间线', '禁忌', '不确定', '锚点']) {
    assert.match(contract.text, new RegExp(`【${tag}】`, 'u'));
  }
  assert.match(contract.text, /阿砚/u);
  assert.match(contract.text, /小砚/u);
  const missing = await defs.fic_contract.execute({ chapter: 'ch999' });
  assert.equal(missing.ok, false);
});

test('fic_check 报出植入错误；fic_lookup 返回可追溯的原文', async () => {
  const { tools } = harness();
  const defs = byName(tools);
  const bad = await defs.fic_check.execute({
    chapter: 'ch001',
    text: '【标签】原著向\n【正文】沈砚右眉上那道疤在灯下很明显。',
  });
  assert.equal(bad.ok, true);
  assert.match(bad.text, /appearance_scar_side/u);
  assert.match(bad.text, /左眉/u);

  const clean = await defs.fic_check.execute({
    chapter: 'ch001',
    text: '【标签】原著向\n【正文】沈砚站在码头，裴照喊他“沈先生”。',
  });
  assert.equal(clean.ok, true);
  assert.match(clean.text, /必检 5 类：0 条/u);

  const found = await defs.fic_lookup.execute({ question: '裴照什么时候改口叫阿砚', entities: ['裴照', '沈砚'] });
  assert.equal(found.ok, true);
  assert.match(found.text, /ch002/u);
  assert.match(found.text, /阿砚/u);
  const empty = await defs.fic_lookup.execute({ question: '' });
  assert.equal(empty.ok, false);
});

test('fic_source 在没有导入项目时给出可执行的下一步', async () => {
  const { tools } = harness();
  const defs = byName(tools);
  const list = await defs.fic_source.execute({ action: 'list', project: 'no-such-project' });
  assert.equal(list.ok, false);
  assert.match(list.text, /项目不存在|先跑 import/u);
});

test('/fic delta：本作设定可增删，list --json 读回', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fic-delta-'));
  const { commands } = harness({ root });
  const command = commands[0];
  const agent = { session: { id: 'session-delta' } };
  const add = await command.handler({
    agent,
    rawInput: 'delta add --project delta-test --kind relationship'
      + ' --title ' + encodeURIComponent('裴照与沈砚是恋人')
      + ' --text ' + encodeURIComponent('本作中两人自 ch002 起是恋人。')
      + ' --subjects ' + encodeURIComponent('裴照,沈砚')
      + ' --from ch002',
  });
  assert.equal(add.kind, 'success');
  const list = await command.handler({ agent, rawInput: 'delta list --project delta-test --json' });
  const payload = JSON.parse(list.text);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].title, '裴照与沈砚是恋人');
  assert.deepEqual(payload.items[0].subjects, ['裴照', '沈砚']);
  assert.equal(payload.items[0].fromChapter, 'ch002');
  const remove = await command.handler({ agent, rawInput: 'delta remove dl_001 --project delta-test --json' });
  assert.equal(remove.kind, 'success');
  const after = JSON.parse((await command.handler({ agent, rawInput: 'delta list --project delta-test --json' })).text);
  assert.equal(after.items.length, 0);
});


