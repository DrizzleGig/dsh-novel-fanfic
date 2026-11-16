// 侧边栏「草稿检查」的宿主命令：/fic check <章> --json --text <URI 编码正文>。
// 这条命令是面板唯一能携带多行正文的通道（commands.execute 只收一行字符串）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureDir = path.join(repoRoot, 'dsh-novel-fanfic', 'fixtures', 'fixture-a');

function harness(root, project) {
  const commands = [];
  apply(
    {
      tools: { register: () => () => {} },
      commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    },
    { root, project, fixture: fixtureDir, stateDir: mkdtempSync(path.join(os.tmpdir(), 'fic-pref-')) },
  );
  const handler = commands[0].handler;
  const agent = { session: { id: 'session-check' } };
  return (line) => handler({ agent, rawInput: line });
}

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fic-check-'));
  return root;
}

test('check：称呼违规被检出，返回结构化 findings', async () => {
  const root = await tempRoot();
  try {
    const run = harness(root, 't');
    const text = '“沈先生。”裴照说。';
    const result = await run(`check ch002 --json --text ${encodeURIComponent(text)}`);
    assert.equal(result.kind, 'success', result.text);
    const payload = JSON.parse(result.text);
    assert.equal(payload.ok, true);
    assert.equal(payload.source, 'fixture');
    assert.equal(payload.chapter, 'ch002');
    assert.ok(payload.findings.some((f) => f.detector === 'address' && f.code === 'address_retired'));
    assert.ok(payload.summary.blockers >= 1);
    assert.ok(Array.isArray(payload.gate), 'gate 检测器清单随 payload 返回');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check：守规矩的钟声写法不报世界规则违规', async () => {
  const root = await tempRoot();
  try {
    const run = harness(root, 't');
    const text = '钟声散了，苏鹤才开口。';
    const payload = JSON.parse((await run(`check ch003 --json --text ${encodeURIComponent(text)}`)).text);
    assert.equal(payload.findings.filter((f) => f.detector === 'worldRule').length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check：缺 --text、坏编码、空正文都给可读错误', async () => {
  const root = await tempRoot();
  try {
    const run = harness(root, 't');
    const missing = await run('check ch002 --json');
    assert.equal(missing.kind, 'error');
    assert.match(missing.text, /--text/);

    const bad = await run('check ch002 --json --text %E0%A4%A');
    assert.equal(bad.kind, 'error');
    assert.match(bad.text, /URI/);

    const empty = await run(`check ch002 --json --text ${encodeURIComponent('   ')}`);
    assert.equal(empty.kind, 'error');
    assert.match(empty.text, /空的/);

    const noChapter = await run(`check --json --text ${encodeURIComponent('字')}`);
    assert.equal(noChapter.kind, 'error');
    assert.match(noChapter.text, /用法/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check：source=canon 在未导入项目上给出可执行提示', async () => {
  const root = await tempRoot();
  try {
    const run = harness(root, 't');
    const result = await run(`check ch002 --json --text ${encodeURIComponent('字')} --source canon`);
    assert.equal(result.kind, 'error');
    assert.match(result.text, /导入|import|项目不存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


