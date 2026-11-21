// 侧边栏写入视图的宿主命令：panel / chapters / chapter / confirm / reject / resolve。
// 用临时项目跑完整链路（导入原文 → 应用提案 → 命令读写），不碰仓库里的 fixture-a 项目。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import { ingestFile } from '../lib/ingest.mjs';
import { loadProject, chapterBody, saveCanon, ensureProject } from '../lib/canon-store.mjs';
import { applyProposals } from '../lib/proposals.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureDir = path.join(repoRoot, 'dsh-novel-fanfic', 'fixtures', 'fixture-a');

const root = await mkdtemp(path.join(os.tmpdir(), 'fic-review-'));
const project = 't';

// 一次性搭好项目：导入夹具原文，再把 6 章提案灌进去。
await ingestFile({ root, project, file: path.join(fixtureDir, 'source.md') });
{
  const loaded = await loadProject(root, project);
  const texts = new Map();
  for (const ch of loaded.index.chapters) texts.set(ch.id, await chapterBody(root, project, ch.id));
  const files = (await readdir(path.join(fixtureDir, 'proposals'))).filter((f) => f.endsWith('.json')).sort();
  const list = [];
  for (const file of files) list.push(...JSON.parse(await readFile(path.join(fixtureDir, 'proposals', file), 'utf8')));
  applyProposals(loaded.canon, list, texts);
  await saveCanon(root, project, loaded.canon);
}

function harness(stateDir) {
  const commands = [];
  apply(
    {
      tools: { register: () => () => {} },
      commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    },
    { root, project, fixture: fixtureDir, stateDir: stateDir || mkdtempSync(path.join(os.tmpdir(), 'fic-pref-')) },
  );
  const handler = commands[0].handler;
  const agent = { session: { id: 'session-review' } };
  return async function run(line) {
    return handler({ agent, rawInput: line });
  };
}

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('panel --json：总览 + 章节 + 待审 + 未裁决矛盾一次取齐', async () => {
  const run = harness();
  const data = JSON.parse((await run('panel --json')).text);
  assert.equal(data.ok, true);
  // v0.2.0：面板要带整数 revision 与任务卡表（v0.1 里这两个字段不存在）
  assert.ok(Number.isInteger(data.revision), `panel.revision 应是整数，实际 ${JSON.stringify(data.revision)}`);
  assert.ok(data.revision >= 1);
  assert.equal(typeof data.missions, 'object');
  assert.equal(data.revisionDrift, false);
  assert.equal(data.project, project);
  assert.equal(data.chapters.length, 7, '6 正文 + ch000 序');
  assert.equal(data.chapters[0].id, 'ch000');
  assert.equal(data.status.fixture.chapters, 6);
  assert.equal(data.status.drift, 0);
  assert.ok(data.pending.length > 0, '提案落盘后应有待审条目');
  assert.equal(data.contradictions.length, 1);
  assert.deepEqual(data.contradictions[0].values, ['浅褐色', '灰蓝色']);
  assert.equal(data.contradictions[0].status, undefined, '面板只送 open 矛盾，不带状态字段');
  // 侧边栏「原著档案」用的完整视图：一次取齐人物/势力/关系/世界/冲突/剧情。
  assert.ok(data.book, 'panel 应带完整 book 视图');
  assert.equal(data.book.chapters.length, 7);
  assert.ok(data.book.characters.length >= 3, '至少 3 个人物卡');
  assert.ok(data.book.characters.every((ch) => typeof ch.mentions === 'number'));
  assert.ok(data.book.factions.length >= 2, '身份事实应归纳出至少 2 个势力');
  assert.ok(data.book.matrix.people.length === data.book.characters.length);
  assert.ok(data.book.world.rules.length >= 2);
  assert.ok(data.book.timeline.length === 7);
  assert.ok(Array.isArray(data.book.analysis) && data.book.analysis.length >= 5);
  assert.equal(data.book.coverage.facts.total, data.status.canon.facts.total);
});

test('chapters / chapter --json：能列出章节并读回正文', async () => {
  const run = harness();
  const chapters = JSON.parse((await run('chapters --json')).text);
  assert.ok(chapters.chapters.some((ch) => ch.id === 'ch001'));
  const one = JSON.parse((await run('chapter ch001 --json')).text);
  assert.equal(one.id, 'ch001');
  assert.ok(one.chars > 300);
  assert.match(one.text, /沈砚/);
  assert.doesNotMatch(one.text, /第1章/);
});

test('confirm：条目从待审消失，落盘为 confirmed，写审计', async () => {
  const run = harness();
  const before = JSON.parse((await run('panel --json')).text);
  const item = before.pending.find((p) => p.bucket === 'facts');
  assert.ok(item, '待审里应有事实');
  const result = await run(`confirm ${item.id}`);
  assert.equal(result.kind, 'success');
  assert.match(result.text, new RegExp(item.id));
  const afterSnap = JSON.parse((await run('panel --json')).text);
  assert.equal(afterSnap.pending.length, before.pending.length - 1);
  const loaded = await loadProject(root, project);
  assert.equal(loaded.canon.facts.find((f) => f.id === item.id).status, 'confirmed');
  const auditText = await readFile(path.join(root, '.dsh-novel-fanfic', project, 'audit.jsonl'), 'utf8');
  assert.match(auditText, /canon\.confirm/);
});

test('reject：标 rejected，不再出现在待审', async () => {
  const run = harness();
  const before = JSON.parse((await run('panel --json')).text);
  const item = before.pending.find((p) => p.bucket === 'characters') || before.pending[0];
  const result = await run(`reject ${item.id}`);
  assert.equal(result.kind, 'success');
  const afterSnap = JSON.parse((await run('panel --json')).text);
  assert.equal(afterSnap.pending.length, before.pending.length - 1);
  const loaded = await loadProject(root, project);
  const where = ['characters', 'facts', 'worldRules', 'secrets', 'addresses'];
  const entity = where.flatMap((b) => loaded.canon[b]).find((x) => x.id === item.id);
  assert.equal(entity.status, 'rejected');
});

test('resolve later：矛盾关闭，后章那条 confirmed、前章那条 rejected，两条都保留', async () => {
  const run = harness();
  const result = await run('resolve fc_001 later');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /fc_001/);
  const snap = JSON.parse((await run('panel --json')).text);
  assert.equal(snap.contradictions.length, 0);
  const loaded = await loadProject(root, project);
  const fc = loaded.canon.contradictions.find((c) => c.id === 'fc_001');
  assert.equal(fc.status, 'resolved');
  assert.equal(fc.resolution, 'later');
  const [first, second] = fc.factIds.map((id) => loaded.canon.facts.find((f) => f.id === id));
  assert.equal(first.status, 'rejected');
  assert.equal(second.status, 'confirmed');
  assert.ok(first && second, '两条事实都保留');
});

test('错误路径：缺参数、未知章节、未知裁决都给可读错误', async () => {
  const run = harness();
  assert.equal((await run('chapter')).kind, 'error');
  assert.equal((await run('chapter ch999')).kind, 'error');
  assert.equal((await run('confirm')).kind, 'error');
  assert.equal((await run('resolve fc_001 nope')).kind, 'error');
});

test('projects --json 列出项目；preview --json 只预览不落盘', async () => {
  const run = harness();
  const projects = JSON.parse((await run('projects --json')).text);
  assert.equal(projects.ok, true);
  assert.equal(projects.current, project);
  const mine = projects.projects.find((p) => p.id === project);
  assert.ok(mine, '应列出当前项目');
  assert.equal(mine.chapters, 7);
  assert.ok(mine.chars > 3000);

  const preview = JSON.parse((await run(`preview ${path.join(fixtureDir, 'source.md')} --json`)).text);
  assert.equal(preview.ok, true);
  assert.equal(preview.chapterCount, 7);
  assert.equal(preview.encoding, 'utf-8');
  assert.equal(preview.duplicate, true, '同一份文件再预览时应提示去重');
  assert.ok(preview.chapters.every((ch) => ch.id && typeof ch.chars === 'number'));
  assert.match(preview.title, /雾港/);

  // 预览不能创建项目目录
  const before = (await readdir(path.join(root, '.dsh-novel-fanfic'))).sort();
  const other = JSON.parse((await run(`preview ${path.join(fixtureDir, 'source.md')} --json --project ghost`)).text);
  assert.equal(other.ok, true);
  assert.equal(other.duplicate, false, '另一个项目里没有这份文件，不该判重复');
  const after = (await readdir(path.join(root, '.dsh-novel-fanfic'))).sort();
  assert.deepEqual(after, before, '预览不应写任何项目文件');

  const missing = await run('preview D:/no/such/file.txt --json');
  assert.equal(missing.kind, 'error');
});

test('pickdir 在无选择器的宿主上给可读提示；files 列出目录里的 txt/md', async () => {
  const run = harness();
  const picked = await run('pickdir --json');
  assert.equal(picked.kind, 'error', '测试宿主没有 directoryPicker，应报不可用');
  const data = JSON.parse(picked.text);
  assert.equal(data.ok, false);
  assert.equal(data.reason, 'unavailable');

  const listed = JSON.parse((await run(`files ${fixtureDir} --json`)).text);
  assert.equal(listed.ok, true);
  const source = listed.files.find((f) => f.name === 'source.md');
  assert.ok(source, '应列出 source.md');
  assert.ok(source.bytes > 1000);
  assert.ok(source.path.endsWith('source.md'));
  assert.ok(listed.files.every((f) => /\.(txt|md|markdown|text)$/i.test(f.name)));

  assert.equal((await run('files D:/no/such/dir --json')).kind, 'error');
});

test('pickdir 走 directoryPicker 的 native 能力；browse 后端给可读提示', async () => {
  const runWith = (capability) => {
    const commands = [];
    apply(
      {
        tools: { register: () => () => {} },
        commands: { register: (definition) => { commands.push(definition); return () => {}; } },
        get: (name) => (name === 'directoryPicker' ? { capability: () => capability } : undefined),
      },
      { root, project, fixture: fixtureDir, stateDir: mkdtempSync(path.join(os.tmpdir(), 'fic-pref-')) },
    );
    const handler = commands[0].handler;
    const agent = { session: { id: 'session-pick' } };
    return (line) => handler({ agent, rawInput: line });
  };

  let seenSignal = null;
  const native = runWith({
    kind: 'native',
    pick: async (signal) => {
      seenSignal = signal;
      return 'D:/books';
    },
  });
  const picked = JSON.parse((await native('pickdir --json')).text);
  assert.deepEqual(picked, { ok: true, path: 'D:/books', cancelled: false });
  assert.ok(seenSignal && typeof seenSignal.aborted === 'boolean');

  const cancelled = JSON.parse((await runWith({ kind: 'native', pick: async () => null })('pickdir --json')).text);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.path, null);

  const browse = await runWith({ kind: 'browse' })('pickdir --json');
  assert.equal(browse.kind, 'error');
  assert.equal(JSON.parse(browse.text).reason, 'not-native');
});

test('waive：忽略一条 finding 落 waivers.json 并写审计；unwaive 撤销；没理由被拒', async () => {
  const run = harness();
  const before = JSON.parse((await run('panel --json')).text);
  assert.deepEqual(before.waivers, [], '新项目没有忽略记录');

  const created = JSON.parse((await run('waive ch002 address/address_retired --quote 沈先生 --reason 想保留这句 --json')).text);
  assert.equal(created.ok, true);
  assert.equal(created.waiver.detector, 'address');
  assert.equal(created.waiver.code, 'address_retired');
  assert.equal(created.waiver.reason, '想保留这句');
  assert.equal(created.waiver.quote, '沈先生');

  const after = JSON.parse((await run('panel --json')).text);
  assert.equal(after.waivers.length, 1);
  const auditText = await readFile(path.join(root, '.dsh-novel-fanfic', project, 'audit.jsonl'), 'utf8');
  assert.match(auditText, /finding\.waive/);

  const removed = JSON.parse((await run(`unwaive ${created.waiver.id} --json`)).text);
  assert.equal(removed.ok, true);
  assert.deepEqual(JSON.parse((await run('panel --json')).text).waivers, []);

  const noReason = await run('waive ch002 address/address_retired');
  assert.equal(noReason.kind, 'error');
  assert.match(noReason.text, /理由/);
  assert.equal((await run('unwaive wv_999')).kind, 'error');
});

test('作者私设声明：AU / 私设 / 错名进检查器，删除后不再触发', async () => {
  const run = harness();
  const snap = JSON.parse((await run('panel --json')).text);
  const charItem = snap.pending.find((p) => p.bucket === 'characters');
  if (charItem) await run(`confirm ${charItem.id}`);
  const facts = snap.pending.filter((p) => p.bucket === 'facts').slice(0, 5).map((p) => p.id);
  if (facts.length) await run(`confirm ${facts.join(',')}`);

  const au = JSON.parse((await run('declare au --name 回魂钟 --signatures 回魂,亡者的声音 --text AU：钟声能送亡者回来 --json')).text);
  assert.equal(au.ok, true);
  assert.equal(au.auRules.length, 1);
  assert.deepEqual(au.auRules[0].signatures, ['回魂', '亡者的声音']);
  const hc = JSON.parse((await run('declare headcanon --text 苏鹤其实是沈九的女儿 --json')).text);
  assert.equal(hc.headcanonSignatures.length, 1);
  const typo = JSON.parse((await run('declare typo --wrong 沈研 --right 沈砚 --json')).text);
  assert.equal(typo.typos['沈研'], '沈砚');

  const panel = JSON.parse((await run('panel --json')).text);
  assert.equal(panel.declarations.auRules.length, 1);
  assert.equal(panel.declarations.headcanonSignatures.length, 1);

  const body = '【标签】原著向\n\n他听见回魂的钟声。沈研抬起头。苏鹤其实是沈九的女儿，港里人都知道。';
  const checked = JSON.parse((await run(`check ch002 --json --text ${encodeURIComponent(body)}`)).text);
  const codes = checked.findings.map((f) => f.detector + '/' + f.code);
  assert.ok(codes.includes('auLeak/au_leak'), 'AU 规则应被抓到，实际：' + codes.join(','));
  assert.ok(codes.includes('name/name_typo'), '错名应被抓到，实际：' + codes.join(','));
  assert.ok(codes.includes('headcanon/headcanon_undeclared'), '私设签名应被抓到，实际：' + codes.join(','));

  await run('declare au --remove au_001');
  const after = JSON.parse((await run('panel --json')).text);
  assert.equal(after.declarations.auRules.length, 0);
  const recheck = JSON.parse((await run(`check ch002 --json --text ${encodeURIComponent(body)}`)).text);
  assert.ok(!recheck.findings.some((f) => f.code === 'au_leak'), '删掉声明后不再报 AU');

  assert.equal((await run('declare au --name 空签名 --signatures ,')).kind, 'error');
  assert.equal((await run('declare typo --wrong 沈砚 --right 沈砚')).kind, 'error');
});

test('/fic use 切换当前项目：面板默认跟着走，写进 prefs.json', async () => {
  const prefDir = mkdtempSync(path.join(os.tmpdir(), 'fic-pref-use-'));
  const run = harness(prefDir);
  const before = JSON.parse((await run('panel --json')).text);
  assert.equal(before.project, project, '默认还是插件配置的项目');

  await ensureProject(root, 'second', { title: '第二本' });
  const used = JSON.parse((await run('use second --json')).text);
  assert.equal(used.ok, true);
  assert.equal(used.project, 'second');

  const after = JSON.parse((await run('panel --json')).text);
  assert.equal(after.project, 'second', '不带 --project 时用记住的项目');
  assert.equal(after.book.chapters.length, 0);

  const missing = await run('use nope --json');
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /没有这个项目/);

  const prefs = JSON.parse(await readFile(path.join(prefDir, 'prefs.json'), 'utf8'));
  assert.equal(prefs.project, 'second');

  // 显式 --project 仍然优先
  const explicit = JSON.parse((await run(`panel --json --project ${project}`)).text);
  assert.equal(explicit.project, project);
  await run('use ' + project + ' --json');
});

test('contract --json：九段契约；search --json：原文命中带章节与偏移', async () => {
  const run = harness();
  // 契约由 confirmed canon 编译：先把一个人物和几条事实确认掉。
  const snap = JSON.parse((await run('panel --json')).text);
  const charItem = snap.pending.find((p) => p.bucket === 'characters');
  if (charItem) assert.equal((await run(`confirm ${charItem.id}`)).kind, 'success');
  const facts = snap.pending.filter((p) => p.bucket === 'facts').slice(0, 5).map((p) => p.id);
  if (facts.length) assert.equal((await run(`confirm ${facts.join(',')}`)).kind, 'success');

  const contract = JSON.parse((await run('contract ch002 --json')).text);
  assert.equal(contract.ok, true);
  assert.equal(contract.chapter, 'ch002');
  for (const tag of ['视角', '在场', '称呼', '知情', '世界规则', '时间线', '禁忌', '不确定', '锚点']) {
    assert.ok(contract.tags[tag], `契约缺【${tag}】`);
  }
  assert.match(contract.markdown, /【视角】/);

  const found = JSON.parse((await run('search 阿砚 --json')).text);
  assert.equal(found.ok, true);
  assert.ok(found.total > 0, '应能搜到「阿砚」');
  assert.ok(found.hits.every((hit) => hit.chapter && typeof hit.offset === 'number' && hit.quote));
  const missing = JSON.parse((await run('search 绝不存在的词 --json')).text);
  assert.equal(missing.total, 0);
});


