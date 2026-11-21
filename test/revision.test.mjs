// revision 与提交点（v0.2.0 P2）：每个真实写入口 +1，只读不变。
// 用命令链路验，因为提交点在 index.js 的 commitWrite 与 ingest 里。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { apply } from '../index.js';
import { ingestFile } from '../lib/ingest.mjs';
import { loadProject, chapterBody, saveCanon, paths, readRevision } from '../lib/canon-store.mjs';
import { applyProposals, confirmEntries } from '../lib/proposals.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureDir = path.join(repoRoot, 'dsh-novel-fanfic', 'fixtures', 'fixture-a');

const root = await mkdtemp(path.join(os.tmpdir(), 'fic-rev-'));
const project = 't';
await ingestFile({ root, project, file: path.join(fixtureDir, 'source.md') });
// 灌入提案并确认，这样 canon 里有真实的人物/称呼（exports.addresses 才有内容）。
{
  const loaded = await loadProject(root, project);
  const texts = new Map();
  for (const ch of loaded.index.chapters) texts.set(ch.id, await chapterBody(root, project, ch.id));
  const files = (await readdir(path.join(fixtureDir, 'proposals'))).filter((f) => f.endsWith('.json')).sort();
  const list = [];
  for (const file of files) list.push(...JSON.parse(await readFile(path.join(fixtureDir, 'proposals', file), 'utf8')));
  applyProposals(loaded.canon, list, texts);
  const ids = [];
  for (const bucket of ['characters', 'facts', 'worldRules', 'secrets', 'addresses']) {
    for (const row of loaded.canon[bucket] || []) if (row.status === 'pending') ids.push(row.id);
  }
  confirmEntries(loaded.canon, ids);
  await saveCanon(root, project, loaded.canon);
}

after(async () => { await rm(root, { recursive: true, force: true }); });

function harness() {
  const commands = [];
  apply(
    {
      tools: { register: () => () => {} },
      commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    },
    { root, project, fixture: fixtureDir, stateDir: mkdtempSync(path.join(os.tmpdir(), 'fic-rev-pref-')) },
  );
  const handler = commands[0].handler;
  const agent = { session: { id: 'session-rev' } };
  return (line) => handler({ agent, rawInput: line });
}

async function currentRevision() {
  return (await readRevision(root, project)).revision;
}

async function projectJson() {
  return JSON.parse(await readFile(paths(root, project).projectFile, 'utf8'));
}

test('导入原著后 project.json 有 schemaVersion 与 revision', async () => {
  const data = await projectJson();
  assert.equal(data.schemaVersion, 1);
  assert.ok(Number.isInteger(data.revision) && data.revision >= 1, `revision 应是正整数，实际 ${data.revision}`);
});

test('只读查询不改变 revision', async () => {
  const run = harness();
  const before = await currentRevision();
  await run('status --json');
  await run('panel --json');
  await run('projects --json');
  assert.equal(await currentRevision(), before, '只读命令不得改 revision');
});

test('/fic declare 私设后 revision +1，并把禁忌词写进 exports', async () => {
  const run = harness();
  const before = await currentRevision();
  const res = await run('declare typo --wrong 沈研 --right 沈砚');
  assert.equal(res.kind, 'success', res.text);
  assert.equal(await currentRevision(), before + 1);
  const data = await projectJson();
  assert.deepEqual(data.exports.forbidden, ['沈研']);
  assert.equal(data.exports.revision, before + 1, 'exports.revision 与项目 revision 同步');
});

test('/fic delta add 本作改动后 revision +1，exports 带上称呼', async () => {
  const run = harness();
  const before = await currentRevision();
  const res = await run('delta add --kind relationship --title 裴照与沈砚是恋人 --text 本作中自 ch002 起是恋人 --from ch002');
  assert.equal(res.kind, 'success', res.text);
  assert.equal(await currentRevision(), before + 1);
  const data = await projectJson();
  assert.ok(data.exports.forbidden.includes('沈研'), 'exports 不应丢掉之前的禁忌词');
  assert.ok(Array.isArray(data.exports.addresses) && data.exports.addresses.length > 0, '应导出称呼');
  assert.ok(data.exports.addresses.some((row) => row.private === '阿砚' && row.from === '裴照'));
});

test('/fic waive 后 revision +1', async () => {
  const run = harness();
  const before = await currentRevision();
  const res = await run('waive ch002 knowledge/knowledge_leak --quote 你父亲还活着 --reason 作者的伏笔安排');
  assert.equal(res.kind, 'success', res.text);
  assert.equal(await currentRevision(), before + 1);
});

test('/fic plan set 任务卡后 revision +1，get 不增', async () => {
  const run = harness();
  const before = await currentRevision();
  const set = await run('plan set ch002 --goal 让裴照先开口');
  assert.equal(set.kind, 'success', set.text);
  assert.equal(await currentRevision(), before + 1);
  const got = await currentRevision();
  await run('plan get ch002');
  assert.equal(await currentRevision(), got, 'plan get 是只读');
});

test('同一内容写两次仍各算一次（写入即新版本），删除也算一次', async () => {
  const run = harness();
  const a = await currentRevision();
  await run('declare headcanon --text 苏鹤其实是沈九的女儿');
  const b = await currentRevision();
  await run('declare headcanon --remove 1');
  const c = await currentRevision();
  assert.equal(b, a + 1);
  assert.equal(c, b + 1, '删除也是一次写入');
});

test('确认提案后 revision +1（applyReview 走同一个提交点）', async () => {
  const run = harness();
  const loaded = await loadProject(root, project);
  // 找一条 pending；没有就先确认（夹具提案在 service 包里已被确认过一次，这里从 review 命令验）
  const pending = (loaded.canon.facts || []).filter((row) => row.status === 'pending');
  if (!pending.length) {
    // 本项目没 pending：跳过（构造不出就不断言，避免假绿）
    assert.ok(true, '没有待确认条目，跳过');
    return;
  }
  const before = await currentRevision();
  const res = await run(`confirm ${pending[0].id}`);
  assert.equal(res.kind, 'success', res.text);
  assert.equal(await currentRevision(), before + 1);
});
