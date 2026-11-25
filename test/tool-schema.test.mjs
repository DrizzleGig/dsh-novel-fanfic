// 参数 schema 的守卫测试：挡住「整张参数表直接交给宿主」这一类错误。
// 这类错误 0.2.0 发布过一次：它不会在单元测试里炸，只会让装着插件的人的 DSH 每条消息 400。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import { assertParameterSchema, captureToolDefinitions } from '../lib/tool-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function definitions() {
  return captureToolDefinitions(apply, {
    root: repoRoot,
    project: 'fixture-a',
    fixture: 'dsh-novel-fanfic/fixtures/fixture-a',
    stateDir: mkdtempSync(path.join(os.tmpdir(), 'fic-schema-')),
  });
}

test('八个 fic 工具的参数都是宿主可接受的 JSON Schema', () => {
  const tools = definitions();
  assert.equal(tools.length, 8);
  for (const definition of tools) {
    assertParameterSchema(definition.name, definition.parameters);
  }
});

test('工具名唯一', () => {
  const names = definitions().map((definition) => definition.name);
  assert.equal(new Set(names).size, names.length);
});

test('0.2.0 的形状一定被拦下：参数表顶在根级、title 是对象', () => {
  // 这就是 0.2.0 交给 ctx.tools.register() 的东西。
  const broken = {
    chapter: { type: 'string', required: true, description: '章 id，如 ch002' },
    action: { type: 'string', enum: ['get', 'set', 'clear'], description: '默认 get' },
    title: { type: 'string', description: '这一章的一句话标题' },
  };
  assert.throws(() => assertParameterSchema('fic_plan', broken), /根级出现 "chapter"/);
});

test('参数名都是字符串、required 里只有名字、属性里没有 required', () => {
  for (const definition of definitions()) {
    const { parameters } = definition;
    assert.equal(parameters.type, 'object');
    assert.equal(typeof parameters.properties, 'object');
    for (const [name, schema] of Object.entries(parameters.properties)) {
      assert.equal(typeof name, 'string');
      assert.equal(Object.hasOwn(schema, 'required'), false, `${definition.name}.${name} 的 schema 里有 required`);
    }
    for (const name of parameters.required || []) {
      assert.equal(typeof name, 'string');
      assert.ok(Object.hasOwn(parameters.properties, name), `${definition.name} 的 required 含未知参数 ${name}`);
    }
  }
});
