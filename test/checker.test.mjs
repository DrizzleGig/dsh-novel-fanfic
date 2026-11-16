// 检查器验收：15 个植入用例全部按预期命中，干净对照零误报，finding 带定位与依据。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { loadFixture } from '../lib/canon.mjs';
import { runCheck, GATE_DETECTORS } from '../lib/checker.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'fixture-a');

const canon = await loadFixture(FIXTURE);

async function resultFor(c) {
  const scene = canon.sceneById.get(c.scene);
  assert.ok(scene, `${c.id} 指向未知场景 ${c.scene}`);
  const raw = await readFile(path.join(FIXTURE, 'planted-errors', c.file), 'utf8');
  return runCheck(raw, scene, canon, { arm: c.arm || 'A' });
}

test('必检门就是启动卡定的 5 类', () => {
  assert.deepEqual([...GATE_DETECTORS].sort(), ['address', 'appearance', 'auLeak', 'knowledge', 'tagDefault']);
});

test('动作＋冒号引语能定位说话人；taboo 不在 forms 里也要查', () => {
  const charById = new Map([
    ['c1', { id: 'c1', name: '小舞' }],
    ['c2', { id: 'c2', name: '唐三' }],
  ]);
  const mini = {
    characters: [...charById.values()],
    charById,
    charByName: new Map([['小舞', charById.get('c1')], ['唐三', charById.get('c2')]]),
    facts: [],
    factById: new Map(),
    formToChar: new Map([['小舞', charById.get('c1')], ['唐三', charById.get('c2')]]),
    chapterById: new Map(),
    source: '',
    worldRules: [],
    secrets: [],
    contradictions: [],
    auRules: [],
    auSignatures: [],
    headcanonSignatures: [],
    typoMap: new Map(),
    scenes: [],
    sceneById: new Map(),
    addressRules: [{
      id: 'addr_x',
      from: 'c1',
      to: 'c2',
      fromChar: charById.get('c1'),
      toChar: charById.get('c2'),
      publicForm: '小三',
      privateForm: null,
      taboo: ['小三子'],
      forms: ['小三'], // 故意不含 taboo：检查器要自己并进来
      fromChapter: 'ch001',
      fromNum: 1,
      retireNum: 0,
      retirePublicFrom: null,
      evidence: { chapter: 'ch001', quote: '小舞' },
    }],
  };
  const scene = {
    id: 'scene_x', chapter: 'ch002', pov: 'c1', present: ['c1', 'c2'], tag: '原著向',
    requiredForms: [], mustReveal: [],
  };
  const text = '【标签】原著向\n\n小舞跳起来：“小三子，你磨蹭什么？”\n';
  const result = runCheck(text, scene, mini, { arm: 'C' });
  const hit = result.findings.find((f) => f.code === 'address_taboo');
  assert.ok(hit, '应抓到称呼忌讳，实际：' + JSON.stringify(result.findings.map((f) => f.code)));
  assert.match(hit.message, /小舞 叫 唐三「小三子」/);
  assert.match(hit.suggest, /小三/, '建议里不该出现 null');
});

test('15 个植入用例全部命中 manifest 登记的检测器', async () => {
  for (const c of canon.manifest.cases) {
    const result = await resultFor(c);
    for (const exp of c.expect) {
      const found = result.findings.find(
        (f) => f.detector === exp.detector && (exp.code ? f.code === exp.code : true),
      );
      assert.ok(
        found,
        `${c.id}: 期望 ${exp.detector}${exp.code ? '/' + exp.code : ''}，实际 ${JSON.stringify(
          result.findings.map((f) => `${f.detector}:${f.code}`),
        )}`,
      );
      if (exp.severity) assert.equal(found.severity, exp.severity, `${c.id} 严重度不符`);
    }
  }
});

test('干净对照零 finding', async () => {
  for (const c of canon.manifest.cases.filter((x) => x.class === 'clean')) {
    const result = await resultFor(c);
    assert.deepEqual(
      result.findings.map((f) => `${f.detector}:${f.code}:${f.quote}`),
      [],
      `${c.id} 出现误报`,
    );
  }
});

test('每条 finding 都带「在哪、凭什么、跟哪条设定冲突」', async () => {
  for (const c of canon.manifest.cases.filter((x) => x.class !== 'clean')) {
    const result = await resultFor(c);
    for (const f of result.findings) {
      assert.ok(f.where && f.where.length > 0, `${c.id} 缺 where`);
      assert.ok(f.why && f.why.length > 0, `${c.id} 缺 why`);
      assert.ok(f.quote && f.quote.length > 0, `${c.id} 缺引文`);
      assert.ok(f.canonRef && typeof f.canonRef === 'object', `${c.id} 缺 canonRef`);
      assert.ok(Number.isInteger(f.offset) && f.offset >= 0, `${c.id} 偏移不合法`);
    }
  }
});

test('关键用例的定位与归属正确', async () => {
  const e01 = await resultFor(canon.manifest.cases.find((c) => c.id === 'e01'));
  assert.match(e01.findings[0].quote, /右眉/);

  const e03b = await resultFor(canon.manifest.cases.find((c) => c.id === 'e03b'));
  const k = e03b.findings.find((f) => f.detector === 'knowledge');
  assert.equal(k.code, 'knowledge_early_dialogue');
  assert.match(k.where, /裴照/, '应把这句话判给裴照');

  const e09 = await resultFor(canon.manifest.cases.find((c) => c.id === 'e09'));
  assert.equal(e09.findings[0].detector, 'unknown');
  assert.equal(e09.findings[0].canonRef.contradiction, 'fc_001');
});

test('同一处断言被多个变体命中时只报一条', async () => {
  const scene = canon.sceneById.get('scene_5');
  const raw = '【标签】原著向\n【正文】\n灯影里，沈砚的眼睛是浅褐色的，浅得几乎透明。\n';
  const r = runCheck(raw, scene, canon, { arm: 'A' });
  const unknown = r.findings.filter((f) => f.detector === 'unknown');
  assert.equal(unknown.length, 1, `应去重成 1 条，实际 ${unknown.length} 条`);
});

test('私有标签不触发 AU 误报，AI 标签才触发', async () => {
  const scene = canon.sceneById.get('scene_1');
  const privateDraft = '【标签】私设\n【正文】\n潮声钟响的时候，沈砚站在雾里，听见了亡者的声音。\n';
  const r = runCheck(privateDraft, scene, canon, { arm: 'A' });
  assert.equal(r.findings.filter((f) => f.detector === 'auLeak').length, 0, '私设标签下的 AU 写法不该报');
  assert.equal(r.tag, '私设');
});

test('预告钟声要来时开口不算违规（FORECAST 守卫）', () => {
  const scene = canon.sceneById.get('scene_5');
  const raw = '【标签】原著向\n【正文】\n“港上要响潮声钟。”裴照先开口，声音压得很低，“今晚得早点封港。”\n';
  const r = runCheck(raw, scene, canon, { arm: 'A' });
  assert.equal(r.findings.filter((f) => f.detector === 'worldRule').length, 0, '预告钟声不该报世界规则违规');
});