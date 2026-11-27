// 项目目录名校验：拒绝路径穿越、Windows 保留名、非法字符；并做根目录包含性校验。
import path from 'node:path';
import { existsSync, lstatSync, realpathSync } from 'node:fs';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function assertSafeProject(project) {
  const name = String(project ?? '');
  if (!name || name.length > 200) throw new Error('project 必须是 1–200 字符的目录名');
  if (name === '.' || name === '..' || name.endsWith('.') || name.endsWith(' ')) {
    throw new Error('project 不能是 . / ..，也不能以点或空格结尾');
  }
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name) || RESERVED.test(name)) {
    throw new Error('project 含非法路径字符或 Windows 保留名');
  }
  return name;
}

/** 现有路径组件中的 junction/symlink 不能靠字符串前缀拦住。 */
function rejectReparse(base, dir) {
  if (!existsSync(base)) return;
  if (lstatSync(base).isSymbolicLink()) throw new Error('项目路径含符号链接');
  const rel = path.relative(base, dir);
  let current = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new Error('项目路径含符号链接');
  }
  try {
    const realBase = realpathSync(base);
    const realDir = realpathSync(dir);
    if (realDir !== realBase && !realDir.startsWith(realBase + path.sep)) {
      throw new Error('项目目录经符号链接越界');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function projectDirSafe(root, project) {
  assertSafeProject(project);
  const base = path.resolve(String(root || '.'), '.dsh-novel-fanfic');
  const dir = path.resolve(base, project);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new Error('project 目录越界');
  rejectReparse(base, dir);
  return dir;
}
