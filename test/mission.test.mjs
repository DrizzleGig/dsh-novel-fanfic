// 章节任务卡（v0.2.0 P4）：mission.json 的读写、契约里的元数据行与「不确定」注入、
// 以及最重要的一条边界——没有任务卡时契约与 v0.1 逐字相同。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { apply } from '../index.js';
import { ingestFile } from '../lib/ingest.mjs';
import { loadProject, chapterBody, saveCanon, paths } from '../lib/canon-store.mjs';
import { applyProposals, confirmEntries } from '../lib/proposals.mjs';
import { loadProjectCanon } from '../lib/canon-adapter.mjs';
import { compileContract } from '../lib/compiler.mjs';
import { saveMission, loadMission, clearMission, normalizeMission, missionDir, missionFile, assertSafeChapter, MISSION_BEATS_LIMIT } from '../lib/mission.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureDir = path.join(repoRoot, 'dsh-novel-fanfic', 'fixtures', 'fixture-a');

const root = await mkdtemp(path.join(os.tmpdir(), 'fic-mission-'));
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

async function contractOf(chapter) {
  const loaded = await loadProjectCanon(root, project);
  const scene = loaded.canon.scenes.find((row) => row.chapter === chapter);
  return compileContract(scene, loaded.canon);
}

test('任务卡章号/项目名拒绝路径穿越与保留名', async () => {
  assert.equal(assertSafeChapter('ch006'), 'ch006');
  assert.equal(assertSafeChapter('第6章'), '第6章');
  for (const bad of ['../evil', '..', '.', 'a/b', 'a\\b', 'C:', 'ch006.', 'CON', 'nul.txt', 'a\u0000b']) {
    assert.throws(() => assertSafeChapter(bad), /chapter/);
  }
  assert.throws(() => missionFile(root, '../outside', 'ch006'), /project/);
  assert.throws(() => missionFile(root, project, '../../outside'), /chapter/);
  await assert.rejects(saveMission(root, project, '../escaped', { goal: 'x' }), /chapter/);
});

test('没有任务卡时，契约里没有任务卡元数据行（v0.1 输出不变）', async () => {
  const compiled = await contractOf('ch002');
  assert.doesNotMatch(compiled.markdown, /任务卡：有/);
  assert.doesNotMatch(compiled.markdown, /任务卡里还挂着/);
});

test('saveMission / loadMission 往返：字段归一化、版本从 1 开始', async () => {
  const saved = await saveMission(root, project, 'ch002', {
    title: '冲突出在最静的地方',
    goal: '让裴照先开口',
    beats: ['a', 'b', 'c'],
    openQuestions: ['裴照为什么现在改口？'],
    status: 'draft',
    unknownField: 'should be dropped',
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.chapter, 'ch002');
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(saved.beats, ['a', 'b', 'c']);
  assert.equal(saved.unknownField, undefined, '未知字段不落盘');
  const loaded = await loadMission(root, project, 'ch002');
  assert.equal(loaded.goal, '让裴照先开口');
  assert.deepEqual(loaded.openQuestions, ['裴照为什么现在改口？']);
  const file = path.join(paths(root, project).dir, 'project', 'chapters', 'ch002', 'mission.json');
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.revision, 1);
});

test('有任务卡时契约多一行元数据，开放问题进「不确定」段', async () => {
  const compiled = await contractOf('ch002');
  assert.match(compiled.markdown, /^> 任务卡：有　3 个节拍　1 项开放　目标「让裴照先开口」/m);
  assert.match(compiled.tags.不确定, /任务卡里还挂着 1 个开放问题/);
  assert.match(compiled.tags.不确定, /裴照为什么现在改口？/);
});

test('任务卡只影响「不确定」段与那一行元数据，其它 8 段一字不变', async () => {
  const withMission = await contractOf('ch002');
  await clearMission(root, project, 'ch002');
  const without = await contractOf('ch002');
  await saveMission(root, project, 'ch002', {
    title: '冲突出在最静的地方',
    goal: '让裴照先开口',
    beats: ['a', 'b', 'c'],
    openQuestions: ['裴照为什么现在改口？'],
  });
  const keys = Object.keys(withMission.tags);
  for (const key of keys) {
    if (key === '不确定') continue;
    assert.equal(withMission.tags[key], without.tags[key], `${key} 段不该被任务卡改动`);
  }
  assert.notEqual(withMission.tags['不确定'], without.tags['不确定']);
});

test('节拍最多 7 条，超了截断（不静默无限增长）', async () => {
  const beats = Array.from({ length: 12 }, (_, i) => `beat-${i + 1}`);
  const saved = await saveMission(root, project, 'ch003', { beats, title: '长卡' });
  assert.equal(saved.beats.length, MISSION_BEATS_LIMIT);
  assert.equal(saved.beats[6], 'beat-7');
});

test('normalizeMission：status 只认 draft/ready/done，targetChars 非数就清空', () => {
  const a = normalizeMission('ch001', { status: 'weird', targetChars: 'abc' });
  assert.equal(a.status, 'draft');
  assert.equal(a.targetChars, null);
  const b = normalizeMission('ch001', { status: 'ready', targetChars: 2800 });
  assert.equal(b.status, 'ready');
  assert.equal(b.targetChars, 2800);
});

test('节拍里含「|」也不会被拆开：面板用 U+001F 拼数组，手输用 | 仍可用', async () => {
  const commands = [];
  apply(
    {
      tools: { register: () => () => {} },
      commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    },
    { root, project, fixture: fixtureDir, stateDir: mkdtempSync(path.join(os.tmpdir(), 'fic-mission-sep-')) },
  );
  const run = (line) => commands[0].handler({ agent: { session: { id: 's' } }, rawInput: line });
  // 面板通路：U+001F 分隔，单条节拍内部的 | 属于内容
  const sep = encodeURIComponent(['A|B 是一件事', 'C 是另一件事'].join('\u001f'));
  const res = await run('plan set ch005 --beats ' + sep);
  assert.equal(res.kind, 'success', res.text);
  const got = JSON.parse((await run('plan get ch005 --json')).text);
  assert.deepEqual(got.mission.beats, ['A|B 是一件事', 'C 是另一件事'], '| 属于节拍内容，不该被当分隔符');

  // CLI 通路：手输用 | 当分隔符
  await run('plan set ch006 --beats ' + encodeURIComponent('甲|乙'));
  const cli = JSON.parse((await run('plan get ch006 --json')).text);
  assert.deepEqual(cli.mission.beats, ['甲', '乙']);
});

test('/fic plan set 后再 get 能读回，clear 之后契约回到无元数据', async () => {
  const commands = [];
  apply(
    {
      tools: { register: () => () => {} },
      commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    },
    { root, project, fixture: fixtureDir, stateDir: mkdtempSync(path.join(os.tmpdir(), 'fic-mission-pref-')) },
  );
  const run = (line) => commands[0].handler({ agent: { session: { id: 's' } }, rawInput: line });
  const set = await run('plan set ch004 --goal 让苏鹤把话说一半 --open 苏鹤为什么隐瞒？|两人何时摊牌？');
  assert.equal(set.kind, 'success', set.text);
  const got = JSON.parse((await run('plan get ch004 --json')).text);
  assert.equal(got.mission.goal, '让苏鹤把话说一半');
  assert.deepEqual(got.mission.openQuestions, ['苏鹤为什么隐瞒？', '两人何时摊牌？']);
  assert.ok(Number.isInteger(got.revision) && got.revision >= 1);
  const list = JSON.parse((await run('plan list --json')).text);
  assert.ok(Object.keys(list.missions).includes('ch004'));
  await run('plan clear ch004');
  const compiled = await contractOf('ch004');
  assert.doesNotMatch(compiled.markdown, /任务卡：有/);
});
