import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { avatarSummary, loadAvatars, removeAvatar, setAvatar } from '../lib/avatars.mjs';
import { matchCharacters } from '../lib/avatar-sources.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

test('20 角色：18 确认（90%）+ 2 回退；匹配全部 high 且不串人', async () => {
  const canon = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i + 1}`,
    name: `角色${i + 1}`,
    aliases: i === 0 ? ['主角'] : [],
  }));
  const source = canon.map((character, i) => ({
    source: 'bangumi',
    sourceId: `s${i + 1}`,
    name: character.name,
    aliases: character.aliases,
    imageUrl: `https://lain.bgm.tv/${i + 1}.jpg`,
    thumbUrl: `https://lain.bgm.tv/${i + 1}-m.jpg`,
  }));
  const matched = matchCharacters(canon, source);
  assert.equal(matched.length, 20);
  for (const row of matched) {
    assert.equal(row.candidates.length > 0, true, row.name);
    assert.equal(row.candidates[0].confidence, 'high', row.name);
  }
  assert.equal(new Set(matched.map((row) => row.candidates[0].sourceId)).size, 20, '20 人不能串到同一个来源角色');

  const root = await mkdtemp(path.join(os.tmpdir(), 'fanfic-avatar-20-'));
  try {
    const project = 'batch20';
    const dir = path.join(root, '.dsh-novel-fanfic', project);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'project.json'), JSON.stringify({ id: project, title: project, revision: 0, schemaVersion: 1 }));

    for (let i = 0; i < 20; i++) {
      await setAvatar(root, project, {
        characterId: `c${i + 1}`,
        name: `角色${i + 1}`,
        dataBase64: PNG_1X1.toString('base64'),
        source: { kind: 'bangumi', imageUrl: `https://lain.bgm.tv/${i + 1}.jpg`, credit: 'Bangumi' },
      });
    }
    for (let i = 18; i < 20; i++) {
      await removeAvatar(root, project, `c${i + 1}`);
    }

    const data = await loadAvatars(root, project);
    const summary = avatarSummary(data);
    assert.equal(summary.total, 20);
    assert.equal(summary.confirmed, 18);
    assert.equal(summary.none, 2);
    assert.equal(summary.confirmed / summary.total >= 0.9, true, '主要角色确认率应 ≥90%');
    assert.equal(data.assetRevision, 22);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
