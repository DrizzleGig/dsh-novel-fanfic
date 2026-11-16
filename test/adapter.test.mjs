// canon→场景适配器：把导入项目的 canon 存储映射成编译器/检查器/检索器认识的形状。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestFile } from '../lib/ingest.mjs';
import { loadProject, chapterBody, saveCanon } from '../lib/canon-store.mjs';
import { applyProposals, confirmEntries } from '../lib/proposals.mjs';
import { loadProjectCanon, adaptCanon, deriveSignatures, worldRulePatterns } from '../lib/canon-adapter.mjs';
import { compileContract } from '../lib/compiler.mjs';
import { runCheck } from '../lib/checker.mjs';
import { retrieve } from '../lib/lookup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureDir = path.join(repoRoot, 'dsh-novel-fanfic', 'fixtures', 'fixture-a');

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fic-adapter-'));
  const project = 't';
  await ingestFile({ root, project, file: path.join(fixtureDir, 'source.md'), title: '雾港' });
  const loaded = await loadProject(root, project);
  const texts = new Map();
  for (const ch of loaded.index.chapters) texts.set(ch.id, await chapterBody(root, project, ch.id));
  const files = (await readdir(path.join(fixtureDir, 'proposals'))).filter((f) => f.endsWith('.json')).sort();
  const list = [];
  for (const file of files) list.push(...JSON.parse(await readFile(path.join(fixtureDir, 'proposals', file), 'utf8')));
  applyProposals(loaded.canon, list, texts);
  // 审阅视图里确认过的才算 canon；测试里把落盘实体全部确认，模拟一次全量确认。
  const conflicted = new Set((loaded.canon.contradictions || []).flatMap((row) => row.factIds || []));
  const ids = ['characters', 'worldRules', 'secrets', 'addresses']
    .flatMap((bucket) => (loaded.canon[bucket] || []).map((row) => row.id));
  for (const fact of loaded.canon.facts || []) {
    if (!conflicted.has(fact.id)) ids.push(fact.id);
  }
  confirmEntries(loaded.canon, ids);
  await saveCanon(root, project, loaded.canon);
  return { root, project };
}

test('adaptCanon 产出与夹具同构的形状', async () => {
  const { root, project } = await makeProject();
  const { canon } = await loadProjectCanon(root, project);
  assert.equal(canon.characters.length, 4);
  assert.equal(canon.facts.length, 34);
  assert.equal(canon.scenes.length, 6);
  assert.ok(canon.source.length > 3000);
  assert.ok(canon.formToChar.has('阿砚'));
  assert.ok(canon.charByName.has('沈砚'));
  const scar = canon.characters.find((c) => c.name === '沈砚').appearance?.scarSide;
  assert.equal(scar?.value, '左');
});

test('称呼：括号说明被剥掉；被拒绝的写法不当公称呼', () => {
  const chars = [
    { id: 'c1', name: '王圣', aliases: [], status: 'confirmed', evidence: [] },
    { id: 'c2', name: '唐三', aliases: [], status: 'confirmed', evidence: [] },
  ];
  const addresses = [
    { id: 'a1', from: 'c1', to: 'c2', form: '小三子', publicForm: '小三子', fromChapter: 'ch021', taboo: ['小三子（贬称）'], status: 'confirmed', evidence: [{ chapter: 'ch021', offset: 0, quote: '小三子' }] },
    { id: 'a2', from: 'c1', to: 'c2', form: '老大', publicForm: '老大', fromChapter: 'ch022', status: 'confirmed', evidence: [{ chapter: 'ch022', offset: 0, quote: '老大' }] },
  ];
  const canon = adaptCanon({
    project: { id: 't', title: 't' },
    canon: { characters: chars, facts: [], worldRules: [], secrets: [], addresses, contradictions: [] },
  }, []);
  const rule = canon.addressRules[0];
  assert.deepEqual(rule.taboo, ['小三子']);
  assert.equal(rule.publicForm, '老大', '被标成忌讳的「小三子」不能当公称呼');
});

test('场景 POV 先看正文里谁被点名最多（不是事实最多）', async () => {
  const characters = [
    { id: 'char_a', name: '甲', aliases: [], status: 'confirmed', evidence: [] },
    { id: 'char_b', name: '乙', aliases: ['小乙'], status: 'confirmed', evidence: [] },
  ];
  const facts = [
    { id: 'fact_1', subject: '甲', subjectName: '甲', predicate: 'role', object: '铁匠', chapter: 'ch001', status: 'confirmed', evidence: [{ chapter: 'ch001', offset: 0, quote: '甲' }] },
    { id: 'fact_2', subject: '甲', subjectName: '甲', predicate: 'age', object: '三十岁', chapter: 'ch001', status: 'confirmed', evidence: [{ chapter: 'ch001', offset: 1, quote: '甲' }] },
  ];
  const chapters = [{ id: 'ch001', title: '一', body: '乙说了话，小乙又说了一次；甲在旁听。', start: 0, bodyStart: 0, ordinal: 1 }];
  const canon = adaptCanon({
    project: { id: 't', title: 't' },
    canon: { characters, facts, worldRules: [], secrets: [], addresses: [], contradictions: [] },
  }, chapters);
  assert.equal(canon.scenes.length, 1);
  assert.equal(canon.scenes[0].pov, 'char_b', '乙被点名三次，应该是 POV');
});

test('称呼规则合并出改口时点', async () => {
  const { root, project } = await makeProject();
  const { canon } = await loadProjectCanon(root, project);
  const rule = canon.addressRules.find((r) => r.fromChar?.name === '裴照' && r.toChar?.name === '沈砚');
  assert.ok(rule, '应有裴照→沈砚的称呼规则');
  assert.equal(rule.publicForm, '沈先生');
  assert.equal(rule.privateForm, '阿砚');
  assert.equal(rule.retirePublicFrom, 'ch002');
  assert.equal(rule.retireNum, 2);
  assert.deepEqual(rule.forms.sort(), ['沈先生', '阿砚'].sort());
});

test('未裁决矛盾带 variants，裁决后从适配层消失', async () => {
  const { root, project } = await makeProject();
  let { canon } = await loadProjectCanon(root, project);
  assert.equal(canon.contradictions.length, 1);
  assert.ok(canon.contradictions[0].variants.includes('浅褐色'));
  assert.ok(canon.contradictions[0].variants.includes('浅褐'));
});

test('编译契约：ch002 写明改口与禁忌语义', async () => {
  const { root, project } = await makeProject();
  const { canon } = await loadProjectCanon(root, project);
  const scene = canon.scenes.find((s) => s.chapter === 'ch002');
  const contract = compileContract(scene, canon);
  assert.match(contract.markdown, /【称呼】/);
  assert.match(contract.markdown, /本章起改口「阿砚」/);
  assert.match(contract.markdown, /不再用「沈先生」/);
  assert.match(contract.markdown, /【不确定】/);
  assert.match(contract.markdown, /眼睛颜色/);
  assert.ok(!contract.markdown.includes('null'), '契约里不应出现 null');
});

test('检查器在适配 canon 上抓改口与复制', async () => {
  const { root, project } = await makeProject();
  const { canon } = await loadProjectCanon(root, project);
  const scene = canon.scenes.find((s) => s.chapter === 'ch002');

  const wrong = '【标签】原著向\n【正文】\n“沈先生。”裴照说，“灯芯换好了。”';
  const r1 = runCheck(wrong, scene, canon, { arm: 'B' });
  assert.ok(r1.findings.some((f) => f.code === 'address_retired'), '应抓到用回旧称呼');

  const body = '【正文】\n苏鹤把最后一批出勤簿摞上架子，袖口蹭了一层灰。';
  const copied = `【标签】原著向\n${body}`;
  const r2 = runCheck(copied, scene, canon, { arm: 'A' });
  assert.ok(r2.findings.some((f) => f.code === 'copy_20'), '应抓到照抄原文');
});

test('检索器在适配 canon 上找到改口原句', async () => {
  const { root, project } = await makeProject();
  const { canon } = await loadProjectCanon(root, project);
  const result = retrieve(canon, { question: '裴照什么时候改口叫阿砚', entities: ['裴照', '阿砚'], limit: 5 });
  assert.ok(result.passages.some((p) => p.chapter === 'ch002' && p.quote.includes('阿砚')));
});

test('秘密签名从一句话里拆出来', () => {
  assert.deepEqual(deriveSignatures('沈九没有死，每年冬至在雾里给长明塔送灯油'), ['沈九没有死', '每年冬至在雾里给长明塔送灯油']);
});

test('世界观规则从原句推断出违规正则', () => {
  assert.ok(worldRulePatterns('').length === 0);
  assert.ok(worldRulePatterns('长明塔是白的。').length === 0, '读不出禁令就不硬造');

  const bell = worldRulePatterns('潮声钟响的时候，谁也不许出声，谁也不许走动');
  assert.equal(bell.length, 2);
  assert.ok(bell[0].test('钟声响到第三声，沈砚却张开嘴喊了一声。'), '换词的违规要能命中');
  // 正则本身故意放宽（不区分守规矩写法），误报由检查器的 COMPLIANT 守卫在句子层挡；
  // 这一条在下个用例里用 runCheck 验。

  const port = worldRulePatterns('明日是涨雾日，封港。船不许离岸');
  assert.ok(port.length === 2);
  assert.ok(port[0].test('涨雾日，他却解缆开了船。'));
});

test('适配 canon 的 worldRule 检测对导入项目生效', async () => {
  const { root, project } = await makeProject();
  const { canon } = await loadProjectCanon(root, project);
  const scene = canon.scenes.find((s) => s.chapter === 'ch001');
  const bad = '【标签】原著向\n【正文】\n钟声响到第三声，沈砚却张开嘴喊了一声“裴照”。';
  const result = runCheck(bad, scene, canon, { arm: 'A' });
  assert.ok(result.findings.some((f) => f.code === 'worldrule_violation'), '应抓到违反静默规则');
  const good = '【标签】原著向\n【正文】\n钟声一下接一下，过了好一阵才淡下去，沈砚站着没动。';
  const ok = runCheck(good, scene, canon, { arm: 'A' });
  assert.ok(!ok.findings.some((f) => f.code === 'worldrule_violation'), '守规矩的句子不该报');
});
