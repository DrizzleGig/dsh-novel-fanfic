import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  avatarPaths,
  avatarSummary,
  imageInfo,
  loadAvatars,
  removeAvatar,
  resolveAvatar,
  setAvatar,
} from '../lib/avatars.mjs';

// 1×1 PNG（透明）。只用于校验魔数/尺寸/哈希，不承载任何作品内容。
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

let root;

test.before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'fanfic-avatar-'));
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeProject(name = `p${Math.random().toString(36).slice(2, 8)}`) {
  const dir = path.join(root, '.dsh-novel-fanfic', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({ id: name, title: name, sourceId: null, revision: 0, schemaVersion: 1 }),
    'utf8',
  );
  return name;
}

test('imageInfo 只认 PNG/JPEG/WebP，并读出宽高', () => {
  const info = imageInfo(PNG_1X1);
  assert.deepEqual(info, { mime: 'image/png', ext: 'png', width: 1, height: 1 });
  assert.equal(imageInfo(Buffer.from('not an image')), null);
  assert.equal(imageInfo(Buffer.from('<svg></svg>')), null);
});

test('setAvatar 写文件与元数据，但不 bump project revision', async () => {
  const project = await makeProject();
  const result = await setAvatar(root, project, {
    characterId: 'char_tangsan',
    name: '唐三',
    dataBase64: PNG_1X1.toString('base64'),
    source: { kind: 'upload', credit: 'test' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.assetRevision, 1);
  assert.equal(result.avatar.status, 'confirmed');
  assert.equal(result.avatar.width, 1);
  assert.equal(result.avatar.height, 1);
  assert.match(result.avatar.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.file, /^assets\/avatars\/char_tangsan-[0-9a-f]{64}\.png$/);

  const p = avatarPaths(root, project);
  await assert.doesNotReject(readFile(path.join(p.dir, result.file)));
  const data = await loadAvatars(root, project);
  assert.equal(data.assetRevision, 1);
  assert.equal(data.characters.char_tangsan.status, 'confirmed');

  const projectFile = JSON.parse(await readFile(path.join(p.dir, 'project.json'), 'utf8'));
  assert.equal(projectFile.revision, 0, '头像不应改 project.json.revision');

  const audit = await readFile(path.join(p.dir, 'audit.jsonl'), 'utf8');
  assert.match(audit, /"action":"avatar\.set"/);
});

test('resolveAvatar 返回 base64；替换后只保留当前文件', async () => {
  const project = await makeProject();
  const first = await setAvatar(root, project, {
    characterId: 'char_a',
    dataBase64: PNG_1X1.toString('base64'),
    source: { kind: 'upload' },
  });
  const p = avatarPaths(root, project);
  const oldFile = path.join(p.dir, first.file);

  const resolved = await resolveAvatar(root, project, 'char_a');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.base64, PNG_1X1.toString('base64'));
  assert.equal(resolved.mime, 'image/png');

  const second = await setAvatar(root, project, {
    characterId: 'char_a',
    dataBase64: PNG_1X1.toString('base64'),
    source: { kind: 'web-image', query: '唐三 动画 形象' },
  });
  assert.equal(second.assetRevision, 2);
  assert.equal(second.file, first.file, '同一图片哈希应复用文件名');
  const data = await loadAvatars(root, project);
  assert.equal(data.assetRevision, 2);
  assert.equal(data.characters.char_a.source.kind, 'web-image');
  await assert.doesNotReject(readFile(oldFile));
});

test('removeAvatar 删除文件并保留 none 记录', async () => {
  const project = await makeProject();
  const set = await setAvatar(root, project, {
    characterId: 'char_b',
    dataBase64: PNG_1X1.toString('base64'),
    source: { kind: 'upload' },
  });
  const p = avatarPaths(root, project);
  const file = path.join(p.dir, set.file);

  const removed = await removeAvatar(root, project, 'char_b');
  assert.equal(removed.removed, true);
  assert.equal(removed.assetRevision, 2);
  await assert.rejects(readFile(file));
  const data = await loadAvatars(root, project);
  assert.equal(data.characters.char_b.status, 'none');
  assert.deepEqual(avatarSummary(data), {
    total: 1,
    confirmed: 0,
    candidate: 0,
    none: 1,
    stale: 0,
    assetRevision: 2,
  });
});

test('文件被改/hash 不符时 resolveAvatar 返回 stale，不写盘', async () => {
  const project = await makeProject();
  const set = await setAvatar(root, project, {
    characterId: 'char_c',
    dataBase64: PNG_1X1.toString('base64'),
    source: { kind: 'upload' },
  });
  const p = avatarPaths(root, project);
  await writeFile(path.join(p.dir, set.file), Buffer.from('tampered'));

  const resolved = await resolveAvatar(root, project, 'char_c');
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'stale');
  const data = await loadAvatars(root, project);
  assert.equal(data.characters.char_c.status, 'confirmed', '只读检查不应改元数据');
});

test('手改 avatars.json 的越界 file 不会被读取/删除', async () => {
  const project = await makeProject();
  const p = avatarPaths(root, project);
  await writeFile(
    p.file,
    JSON.stringify({
      schemaVersion: 1,
      project,
      assetRevision: 1,
      works: [],
      characters: {
        char_z: {
          status: 'confirmed',
          file: '../../outside.png',
          hash: `sha256:${'0'.repeat(64)}`,
          mime: 'image/png',
          width: 1,
          height: 1,
        },
      },
    }),
    'utf8',
  );
  const resolved = await resolveAvatar(root, project, 'char_z');
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'invalid');
  const removed = await removeAvatar(root, project, 'char_z');
  assert.equal(removed.removed, true);
  assert.equal((await resolveAvatar(root, project, 'char_z')).reason, 'none');
});

test('拒绝坏图/超大/非方形/路径穿越/缺项目', async () => {
  const project = await makeProject();
  const nonSquare = Buffer.from(PNG_1X1);
  nonSquare.writeUInt32BE(3, 16); // 只改 IHDR 宽高让 imageInfo 读到 3×1；CRC 不参与本校验。
  await assert.rejects(
    setAvatar(root, project, { characterId: 'char_x', buffer: nonSquare }),
    /正方形/,
  );
  await assert.rejects(
    setAvatar(root, project, { characterId: 'char_x', dataBase64: Buffer.from('nope').toString('base64') }),
    /PNG\/JPEG\/WebP/,
  );
  await assert.rejects(
    setAvatar(root, project, { characterId: 'char_x', buffer: Buffer.alloc(512 * 1024 + 1) }),
    /超过/,
  );
  await assert.rejects(
    setAvatar(root, project, { characterId: '../escape', dataBase64: PNG_1X1.toString('base64') }),
    /characterId/,
  );
  await assert.rejects(
    setAvatar(root, '../../outside', { characterId: 'char_x', dataBase64: PNG_1X1.toString('base64') }),
    /project/,
  );
  await assert.rejects(
    setAvatar(root, 'missing-project', { characterId: 'char_x', dataBase64: PNG_1X1.toString('base64') }),
    /项目不存在/,
  );
});
