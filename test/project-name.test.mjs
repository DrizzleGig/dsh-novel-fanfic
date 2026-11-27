import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { projectDirSafe } from '../lib/project-name.mjs';

test('projectDirSafe：项目目录是 junction 时拒绝', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fic-project-name-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'fic-project-outside-'));
  try {
    mkdirSync(path.join(root, '.dsh-novel-fanfic'), { recursive: true });
    symlinkSync(outside, path.join(root, '.dsh-novel-fanfic', 'linked'), 'junction');
    assert.throws(() => projectDirSafe(root, 'linked'), /符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
