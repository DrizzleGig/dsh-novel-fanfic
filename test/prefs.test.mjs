// /fic on|off 的持久化：偏好文件写在 stateDir，重启后新会话按默认值走。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function harness(stateDir) {
  const commands = [];
  apply(
    {
      tools: { register: () => () => {} },
      commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    },
    { root: repoRoot, project: 'fixture-a', fixture: 'dsh-novel-fanfic/fixtures/fixture-a', stateDir },
  );
  return commands[0].handler;
}

const snapshot = async (handler, agent) => JSON.parse((await handler({ agent, rawInput: 'status --json' })).text);

test('/fic on 把偏好写进 stateDir，并记住 enabled', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fic-prefs-'));
  const handler = harness(stateDir);
  const agent = { session: { id: 'pref-on' } };
  assert.equal((await snapshot(handler, agent)).enabled, false);
  const result = await handler({ agent, rawInput: 'on' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /记住/);
  const file = path.join(stateDir, 'prefs.json');
  assert.ok(existsSync(file), '应写出 prefs.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).enabled, true);
  const snap = await snapshot(handler, agent);
  assert.equal(snap.enabled, true);
  assert.equal(snap.persisted, true);
});

test('重启后新实例按持久默认开启，无需再 /fic on', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fic-prefs-'));
  await harness(stateDir)({ agent: { session: { id: 'first' } }, rawInput: 'on' });
  const restarted = harness(stateDir); // 模拟 DSH 重启：内存清空，只留偏好文件
  const snap = await snapshot(restarted, { session: { id: 'second' } });
  assert.equal(snap.enabled, true, '新会话应继承开启');
  assert.equal(snap.persisted, true);
});

test('/fic off 持久关闭，且显式关闭优先于旧偏好', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fic-prefs-'));
  const first = harness(stateDir);
  await first({ agent: { session: { id: 'a' } }, rawInput: 'on' });
  const second = harness(stateDir);
  const agent = { session: { id: 'b' } };
  assert.equal((await snapshot(second, agent)).enabled, true);
  await second({ agent, rawInput: 'off' });
  assert.equal((await snapshot(second, agent)).enabled, false, '本会话显式 off 立即生效');
  assert.equal(JSON.parse(readFileSync(path.join(stateDir, 'prefs.json'), 'utf8')).enabled, false);
  const third = harness(stateDir);
  assert.equal((await snapshot(third, { session: { id: 'c' } })).enabled, false, '重启后仍是关闭');
});
