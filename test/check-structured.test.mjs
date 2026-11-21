// fic_check 的结构化返回（v0.2.0 P3）：
//   status 说「执行成功」，pass 说「检查通过」；waiver 在服务端先应用，不靠面板过滤。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { apply } from '../index.js';
import { ingestFile } from '../lib/ingest.mjs';
import { loadProject, chapterBody, saveCanon } from '../lib/canon-store.mjs';
import { applyProposals, confirmEntries } from '../lib/proposals.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureDir = path.join(repoRoot, 'dsh-novel-fanfic', 'fixtures', 'fixture-a');

const root = await mkdtemp(path.join(os.tmpdir(), 'fic-check-'));
const project = 't';
await ingestFile({ root, project, file: path.join(fixtureDir, 'source.md') });
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

const tools = [];
const commands = [];
apply(
  {
    tools: { register: (definition, options) => { tools.push({ definition, options }); return () => {}; } },
    commands: { register: (definition) => { commands.push(definition); return () => {}; } },
  },
  { root, project, fixture: fixtureDir, stateDir: path.join(root, '.prefs') },
);
const toolOf = (name) => tools.find(({ definition }) => definition.name === name).definition;
const runCmd = (line) => commands[0].handler({ agent: { session: { id: 's' } }, rawInput: line });

// ch002 的草稿：用了本作已弃用的旧称呼（blocker），并混入一条 info
const DRAFT = '“沈先生。”裴照说。\n\n沈砚没应声。明日是涨雾日，封港。船不许离岸';

test('fic_check 返回 status/pass/revision/findings，且仍带人读的 text', async () => {
  const res = await toolOf('fic_check').execute({ root, project, source: 'canon', chapter: 'ch002', text: DRAFT });
  assert.equal(res.status, 'completed', '执行成功');
  assert.equal(typeof res.ok, 'boolean');
  assert.match(res.text, /blocker/);
  assert.ok(Number.isInteger(res.revision) && res.revision >= 1, '要报这是哪一版的检查');
  assert.ok(Array.isArray(res.findings));
  assert.ok(res.findings.length > 0, '应至少有一条 finding');
  for (const finding of res.findings) {
    for (const key of ['severity', 'detector', 'code', 'quote']) assert.ok(key in finding, `findings 缺 ${key}`);
  }
  assert.equal(res.pass, res.summary.blockers === 0, 'pass 只看剩下（未被放过）的 blocker');
});

test('检查不通过时 status 仍是 completed，pass=false', async () => {
  const res = await toolOf('fic_check').execute({ root, project, source: 'canon', chapter: 'ch002', text: DRAFT });
  assert.equal(res.status, 'completed');
  assert.equal(res.pass, false);
  const blockers = res.findings.filter((f) => f.severity === 'blocker');
  assert.ok(blockers.length >= 1);
});

test('waiver 在服务端生效：放过之后 pass 变 true，且 waived 里能看到理由', async () => {
  const before = await toolOf('fic_check').execute({ root, project, source: 'canon', chapter: 'ch002', text: DRAFT });
  const blocker = before.findings.find((f) => f.severity === 'blocker');
  assert.ok(blocker, '需要一条 blocker 才能测放过');
  const waived = await runCmd(`waive ch002 ${blocker.detector}/${blocker.code} --quote ${encodeURIComponent(blocker.quote)} --reason ${encodeURIComponent('作者的伏笔安排')}`);
  assert.equal(waived.kind, 'success', waived.text);
  const after = await toolOf('fic_check').execute({ root, project, source: 'canon', chapter: 'ch002', text: DRAFT });
  assert.equal(after.pass, true, '放过后不再有未处理的 blocker');
  assert.ok(after.waived.length >= 1);
  assert.equal(after.waived[0].waivedBy.reason, '作者的伏笔安排');
  assert.equal(after.summary.waived >= 1, true);
});

test('fic_contract 返回 sections（= tags）与 revision，text 仍是 markdown', async () => {
  const res = await toolOf('fic_contract').execute({ root, project, source: 'canon', chapter: 'ch002' });
  assert.equal(res.status, 'completed');
  assert.match(res.text, /^# 场景契约 ch002/);
  assert.ok(res.sections && Object.keys(res.sections).length >= 9);
  assert.deepEqual(res.sectionOrder, Object.keys(res.sections));
  for (const tag of res.sectionOrder) {
    assert.ok(res.text.includes(`【${tag}】${res.sections[tag]}`), `markdown 缺【${tag}】`);
  }
  assert.ok(Number.isInteger(res.revision));
  assert.equal(res.source, 'canon');
});
