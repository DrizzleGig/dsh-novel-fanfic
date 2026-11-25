import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addComicSource,
  addHongguoSource,
  addMediaEvidence,
  listMedia,
  loadMedia,
  removeMediaSource,
  verifyMediaEvidence,
} from '../lib/media.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

async function projectRoot(name = 'demo') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fanfic-media-'));
  const dir = path.join(root, '.dsh-novel-fanfic', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'project.json'), JSON.stringify({ id: name, title: name, revision: 0, schemaVersion: 1 }));
  return { root, project: name, dir };
}

test('漫画来源：登记页数/hash，重复文件不重复加；不动 project revision', async () => {
  const { root, project, dir } = await projectRoot();
  try {
    const file = path.join(root, 'page.png');
    await writeFile(file, PNG_1X1);
    const first = await addComicSource(root, project, { file, title: '第一话' });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.source.pageCount, 1);
    assert.equal(first.source.type, 'image');
    assert.equal(first.mediaRevision, 1);

    const again = await addComicSource(root, project, { file });
    assert.equal(again.duplicate, true);
    assert.equal(again.mediaRevision, 1);

    const data = await loadMedia(root, project);
    assert.equal(data.sources.length, 1);
    const projectJson = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'));
    assert.equal(projectJson.revision, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('红果来源 + 证据 + 删除来源级联删除证据', async () => {
  const { root, project } = await projectRoot('hongguo');
  try {
    const added = await addHongguoSource(root, project, { seriesId: 's1', title: '测试短剧', coverUrl: 'https://example.com/c.jpg' });
    assert.equal(added.ok, true);
    assert.equal(added.source.kind, 'hongguo');
    assert.equal((await addHongguoSource(root, project, { seriesId: 's1' })).duplicate, true);

    const evidence = await addMediaEvidence(root, project, {
      sourceId: added.source.id,
      kind: 'hongguo-episode',
      locator: { episode: 1, time: 12.5 },
      quote: '第1集台词摘录',
      method: 'manual',
      hash: 'sha256:abc',
    });
    assert.equal(evidence.ok, true);
    assert.equal(evidence.mediaRevision, 2);

    const listed = await listMedia(root, project);
    assert.equal(listed.sources.length, 1);
    assert.equal(listed.evidence.length, 1);
    assert.deepEqual(listed.evidence[0].locator, { episode: 1, time: 12.5 });

    const removed = await removeMediaSource(root, project, added.source.id);
    assert.equal(removed.removed, true);
    assert.equal(removed.mediaRevision, 3);
    const after = await loadMedia(root, project);
    assert.equal(after.sources.length, 0);
    assert.equal(after.evidence.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('拒绝缺项目/缺 seriesId/缺 quote/未知来源', async () => {
  const { root, project } = await projectRoot('bad');
  try {
    await assert.rejects(addHongguoSource(root, 'missing', { seriesId: 's1' }), /项目不存在/);
    await assert.rejects(addHongguoSource(root, project, {}), /seriesId/);
    await assert.rejects(addMediaEvidence(root, project, { sourceId: 'nope', quote: 'x' }), /来源不存在/);
    const h = await addHongguoSource(root, project, { seriesId: 's1' });
    await assert.rejects(addMediaEvidence(root, project, { sourceId: h.source.id, quote: '  ' }), /quote/);
    await assert.rejects(addComicSource(root, project, { file: path.join(root, 'missing.png') }), /找不到/);
    await assert.rejects(loadMedia(root, '..'), /project/);
    await assert.rejects(loadMedia(root, '.'), /project/);
    await assert.rejects(loadMedia(root, 'CON'), /project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('图片目录来源：清单 hash 可登记/校验，改页后 stale', async () => {
  const { root, project } = await projectRoot('directory');
  try {
    const dir = path.join(root, 'comic-dir');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '001.png'), PNG_1X1);
    await writeFile(path.join(dir, '002.png'), PNG_1X1);
    const added = await addComicSource(root, project, { file: dir, title: '图片目录' });
    assert.equal(added.source.type, 'directory');
    assert.equal(added.source.pageCount, 2);
    assert.equal(added.source.hashKind, 'directory');
    assert.match(added.source.fileHash, /^dir:/);
    const ev = await addMediaEvidence(root, project, {
      sourceId: added.source.id, kind: 'comic-page', locator: { page: 0 }, quote: '第一页',
    });
    const first = await verifyMediaEvidence(root, project);
    assert.equal(first.items.find((item) => item.evidenceId === ev.evidence.id).status, 'valid');

    await writeFile(path.join(dir, '002.png'), Buffer.from('changed'));
    const second = await verifyMediaEvidence(root, project);
    assert.equal(second.items.find((item) => item.evidenceId === ev.evidence.id).status, 'stale');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('证据 verifier：漫画 hash/页码通过；改文件 stale；红果 unverified；坏集号 invalid', async () => {
  const { root, project } = await projectRoot('verify');
  try {
    const file = path.join(root, 'page.png');
    await writeFile(file, PNG_1X1);
    const comic = await addComicSource(root, project, { file });
    const good = await addMediaEvidence(root, project, {
      sourceId: comic.source.id, kind: 'comic-page', locator: { page: 0, panel: 0 }, quote: '第一格',
    });
    const badPage = await addMediaEvidence(root, project, {
      sourceId: comic.source.id, kind: 'comic-page', locator: { page: 9 }, quote: '越界页',
    });
    const hong = await addHongguoSource(root, project, { seriesId: 's1' });
    const hongEv = await addMediaEvidence(root, project, {
      sourceId: hong.source.id, kind: 'hongguo-episode', locator: { episode: 1, time: 3 }, quote: '台词',
    });
    const badEpisode = await addMediaEvidence(root, project, {
      sourceId: hong.source.id, kind: 'hongguo-episode', locator: { episode: 0 }, quote: '坏集',
    });

    const first = await verifyMediaEvidence(root, project);
    assert.equal(first.summary.valid, 1);
    assert.equal(first.summary.invalid, 2, '越界页 + 坏集号');
    assert.equal(first.summary.unverified, 1, '红果只有元数据');
    assert.equal(first.items.find((item) => item.evidenceId === good.evidence.id).status, 'valid');
    assert.equal(first.items.find((item) => item.evidenceId === hongEv.evidence.id).status, 'unverified');

    await writeFile(file, Buffer.from('changed'));
    const second = await verifyMediaEvidence(root, project);
    assert.equal(second.items.find((item) => item.evidenceId === good.evidence.id).status, 'stale');
    assert.equal(second.items.find((item) => item.evidenceId === badPage.evidence.id).status, 'stale');
    assert.equal(second.items.find((item) => item.evidenceId === badEpisode.evidence.id).status, 'invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
