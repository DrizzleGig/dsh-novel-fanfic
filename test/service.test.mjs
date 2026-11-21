// 只读服务 novelFanfic（v0.2.0）：identity / getStatus / getRevision / getContract / getCanonSummary。
// 重点验四件事：绝对 cwd、永不回落夹具、sections 与 markdown 同源、revision 与内容同快照。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ingestFile } from '../lib/ingest.mjs';
import { loadProject, chapterBody, saveCanon, ensureProject, commitProject, readRevision, paths } from '../lib/canon-store.mjs';
import { loadDeltas, saveDeltas, deltaFile, emptyDeltas, addDelta, setPremise } from '../lib/deltas.mjs';
import { applyProposals, confirmEntries } from '../lib/proposals.mjs';
import { buildExports } from '../lib/exports.mjs';
import { identity, getStatus, getRevision, getContract, getCanonSummary, CAPABILITIES } from '../lib/service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureDir = path.join(repoRoot, 'dsh-novel-fanfic', 'fixtures', 'fixture-a');

const root = await mkdtemp(path.join(os.tmpdir(), 'fic-service-'));
const project = 't';
after(async () => { await rm(root, { recursive: true, force: true }); });

// 一次性搭好项目：导入夹具原文 + 灌入 6 章提案（与 review.test.mjs 同法）。
await ingestFile({ root, project, file: path.join(fixtureDir, 'source.md') });
{
  const loaded = await loadProject(root, project);
  const texts = new Map();
  for (const ch of loaded.index.chapters) texts.set(ch.id, await chapterBody(root, project, ch.id));
  const files = (await readdir(path.join(fixtureDir, 'proposals'))).filter((f) => f.endsWith('.json')).sort();
  const list = [];
  for (const file of files) list.push(...JSON.parse(await readFile(path.join(fixtureDir, 'proposals', file), 'utf8')));
  applyProposals(loaded.canon, list, texts);
  // 提案默认 pending，服务要的是「作者确认过」的 canon：全量确认一遍。
  const ids = [];
  for (const bucket of ['characters', 'facts', 'worldRules', 'secrets', 'addresses']) {
    for (const row of loaded.canon[bucket] || []) if (row.status === 'pending') ids.push(row.id);
  }
  confirmEntries(loaded.canon, ids);
  await saveCanon(root, project, loaded.canon);
  // 加两条本作设定：契约里要出现【本作】段（10 段），导出块也要有称呼。
  let deltas = emptyDeltas();
  deltas = setPremise(deltas, '裴照在 ch002 就认出了沈砚，而不是等到 ch005。');
  deltas = addDelta(deltas, {
    kind: 'relationship',
    title: '裴照与沈砚是恋人',
    statement: '本作中两人自 ch002 起是恋人；原著里的上下级关系不再适用。',
    subjects: ['char_002', 'char_001'],
    fromChapter: 'ch002',
  });
  await saveDeltas(deltaFile(paths(root, project).dir), deltas);
  // 作者私设：AU 签名 + 错名（导出块 forbidden 的来源）
  await writeFile(
    path.join(paths(root, project).dir, 'declarations.json'),
    JSON.stringify({
      schemaVersion: 1,
      auRules: [{ id: 'au_001', name: '回魂钟', text: '', signatures: ['回魂', '亡者的声音'] }],
      headcanonSignatures: [],
      typos: { 沈研: '沈砚' },
    }, null, 2),
    'utf8',
  );
}

test('identity() 是可调用函数，字段与契约一致', () => {
  const id = identity('0.2.0');
  assert.equal(id.plugin, 'dsh-novel-fanfic');
  assert.equal(id.version, '0.2.0');
  assert.equal(id.service_version, 1);
  assert.equal(id.dir, '.dsh-novel-fanfic');
  assert.equal(id.readOnly, true);
  assert.deepEqual([...id.capabilities].sort(), [...CAPABILITIES].sort());
  for (const cap of ['fanfic.contract', 'fanfic.canon', 'fanfic.status', 'fanfic.revision']) {
    assert.ok(id.capabilities.includes(cap), `缺能力 ${cap}`);
  }
});

test('getStatus 返回真实计数与 revision（同一次读盘）', async () => {
  const res = await getStatus({ cwd: root, project });
  assert.equal(res.status, 'ok');
  assert.equal(res.code, null);
  assert.equal(res.data.project, project);
  assert.equal(res.data.imported, true);
  assert.ok(Number.isInteger(res.data.revision) && res.data.revision >= 1);
  assert.equal(res.data.chapters, 7);
  assert.equal(res.data.buckets.characters.confirmed + res.data.buckets.characters.total > 0, true);
  assert.equal(res.source.plugin, 'fanfic');
  assert.equal(res.source.revision, res.data.revision);
});

test('相对 cwd 直接失败（BAD_DIR），不 resolve、不回落 process.cwd()', async () => {
  for (const fn of [getStatus, getRevision, getCanonSummary]) {
    const res = await fn({ cwd: 'relative/dir', project });
    assert.equal(res.status, 'failed', `${fn.name} 应失败`);
    assert.equal(res.code, 'BAD_DIR');
  }
  const contract = await getContract({ cwd: '.', project, chapter: 'ch002' });
  assert.equal(contract.status, 'failed');
  assert.equal(contract.code, 'BAD_DIR');
});

test('服务永不回落夹具：工作区里有夹具目录、但没有项目时返回 skipped', async () => {
  const bare = await mkdtemp(path.join(os.tmpdir(), 'fic-bare-'));
  // 摆一份「看起来像夹具」的目录：服务若回落，就会拿到夹具契约。
  const fake = path.join(bare, 'dsh-novel-fanfic', 'fixtures', 'fixture-a');
  await mkdir(fake, { recursive: true });
  await writeFile(path.join(fake, 'ground-truth.json'), JSON.stringify({ scenes: [{ id: 's', chapter: 'ch002' }] }), 'utf8');
  const res = await getContract({ cwd: bare, project: 'nope', chapter: 'ch002' });
  assert.equal(res.status, 'skipped');
  assert.equal(res.code, 'NO_PROJECT');
  assert.equal(res.data, null, '不得返回任何契约数据');
  const auto = await getContract({ cwd: bare, chapter: 'ch002' });
  assert.equal(auto.status, 'skipped');
  assert.equal(auto.code, 'NO_PROJECT');
  await rm(bare, { recursive: true, force: true });
});

test('getContract：sections 就是 tags，每一段都逐字出现在 markdown 里', async () => {
  const res = await getContract({ cwd: root, project, chapter: 'ch002' });
  assert.equal(res.status, 'ok');
  const data = res.data;
  assert.equal(data.chapter, 'ch002');
  assert.ok(data.chars > 100);
  assert.equal(data.chars, data.markdown.length);
  assert.match(data.hash, /^[0-9a-f]{40}$/);
  const order = data.sectionOrder;
  assert.ok(order.includes('本作'), '有本作设定时应有【本作】段');
  for (const tag of order) {
    const line = `【${tag}】${data.sections[tag]}`;
    assert.ok(data.markdown.includes(line), `markdown 里缺这一段：${tag}`);
  }
  // 九段 + 本作 = 10 段（夹具 A 有两类本作设定）
  assert.equal(order.length, 10);
});

test('getContract 缺章返回 skipped + 可用章节，不抛错', async () => {
  const res = await getContract({ cwd: root, project, chapter: 'ch999' });
  assert.equal(res.status, 'skipped');
  assert.equal(res.code, 'NO_CHAPTER');
  assert.match(res.message, /ch001/);
});

test('getContract 没有 chapter 参数时明确报 BAD_CHAPTER', async () => {
  const res = await getContract({ cwd: root, project });
  assert.equal(res.status, 'failed');
  assert.equal(res.code, 'BAD_CHAPTER');
});

test('commitProject 单调 +1，readRevision 只读不写盘', async () => {
  const before = await readRevision(root, project);
  const first = await commitProject(root, project, {});
  const second = await commitProject(root, project, {});
  assert.equal(second.revision, first.revision + 1);
  assert.equal(first.revision, before.revision + 1);
  const after = await readRevision(root, project);
  assert.equal(after.revision, second.revision);
  assert.equal(after.revDrift, false);
});

test('旧项目没有 revision 时按 audit 行数兜底，并标 revDrift，不写盘', async () => {
  const oldRoot = await mkdtemp(path.join(os.tmpdir(), 'fic-old-'));
  await ensureProject(oldRoot, 'old', { title: '旧项目' });
  const file = paths(oldRoot, 'old').projectFile;
  const data = JSON.parse(await readFile(file, 'utf8'));
  delete data.revision;
  delete data.schemaVersion;
  await writeFile(file, JSON.stringify(data), 'utf8');
  const rev = await readRevision(oldRoot, 'old');
  assert.equal(rev.revDrift, true);
  // ensureProject 自己写过一条 project.create 审计，所以兜底值是 1（不是 0）
  assert.equal(rev.revision, 1, '按 audit 行数兜底（project.create 一行）');
  const stillRaw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stillRaw.revision, undefined, '只读查询不得写盘');
  const committed = await commitProject(oldRoot, 'old', {});
  assert.equal(committed.revision, rev.revision + 1, '兜底值也算基线，写入后 +1');
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.schemaVersion, 1, '第一次写入把 schemaVersion 落盘');
  await rm(oldRoot, { recursive: true, force: true });
});

test('buildExports：禁忌词来自 AU 签名与错名，称呼用姓名并带改口章', async () => {
  const loaded = await loadProject(root, project);
  const declarations = {
    auRules: [{ id: 'au_001', name: '回魂钟', text: '', signatures: ['回魂', '亡者的声音'] }],
    headcanonSignatures: [],
    typos: { 沈研: '沈砚' },
  };
  const exported = buildExports({ canon: loaded.canon, declarations, revision: 7 });
  assert.deepEqual(exported.forbidden, ['回魂', '亡者的声音', '沈研']);
  assert.equal(exported.revision, 7);
  const addr = exported.addresses.find((row) => row.private === '阿砚');
  assert.ok(addr, '应有「阿砚」这条私下称呼');
  assert.equal(addr.from, '裴照');
  assert.equal(addr.to, '沈砚');
  assert.equal(addr.fromChapter, 'ch002');
  // 导出的称呼不出现内部 id
  for (const row of exported.addresses) {
    assert.doesNotMatch(row.from, /^char_/);
    assert.doesNotMatch(row.to, /^char_/);
  }
});
