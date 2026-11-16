// /fic status --json：侧边栏面板的只读数据源。用假 ctx 直接调命令 handler。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function harness() {
  const commands = [];
  apply(
    {
      tools: { register: () => () => {} },
      commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    },
    { root: repoRoot, project: 'fixture-a', fixture: 'dsh-novel-fanfic/fixtures/fixture-a', stateDir: mkdtempSync(path.join(os.tmpdir(), 'fic-pref-')) },
  );
  return { commands, handler: commands[0].handler };
}

test('/fic status --json 返回夹具与 canon 快照', async () => {
  const { handler } = harness();
  const result = await handler({ agent: { session: { id: 'session-json' } }, rawInput: 'status --json' });
  assert.equal(result.kind, 'success');
  const snap = JSON.parse(result.text);
  assert.equal(snap.ok, true);
  assert.equal(snap.project, 'fixture-a');
  assert.equal(snap.enabled, false, '没执行 /fic on 时快照是关闭状态');
  assert.equal(snap.fixture.chapters, 6);
  assert.equal(snap.fixture.chars, 3804);
  assert.equal(snap.fixture.scenes, 5);
  assert.equal(snap.fixture.controlScenes, 1);
  assert.equal(snap.drift, 0);
  if (!snap.canonError) {
    assert.equal(snap.canon.characters.confirmed, 4);
    assert.equal(snap.canon.facts.total, 36);
    assert.equal(snap.canon.contradictions.open, 1);
  }
});

test('快照的 enabled 跟随 /fic on，且不改变项目数据', async () => {
  const { handler } = harness();
  const agent = { session: { id: 'session-toggle' } };
  const before = JSON.parse((await handler({ agent, rawInput: 'status --json' })).text);
  handler({ agent, rawInput: 'on' });
  const after = JSON.parse((await handler({ agent, rawInput: 'status --json' })).text);
  assert.equal(before.enabled, false);
  assert.equal(after.enabled, true);
  assert.deepEqual(after.canon, before.canon);
  assert.deepEqual(after.fixture, before.fixture);
});

test('不带 --json 的 /fic status 仍回人类可读文案', async () => {
  const { handler } = harness();
  const agent = { session: { id: 'session-text' } };
  const off = handler({ agent, rawInput: 'status' });
  assert.equal(off.kind, 'success');
  assert.match(off.text, /关闭/);
  handler({ agent, rawInput: 'on' });
  const on = handler({ agent, rawInput: 'status' });
  assert.match(on.text, /已开启/);
});


