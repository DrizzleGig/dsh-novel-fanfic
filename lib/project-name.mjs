// 项目目录名校验：拒绝路径穿越、Windows 保留名、非法字符；并做根目录包含性校验。
import path from 'node:path';

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

export function projectDirSafe(root, project) {
  assertSafeProject(project);
  const base = path.resolve(String(root || '.'), '.dsh-novel-fanfic');
  const dir = path.resolve(base, project);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new Error('project 目录越界');
  return dir;
}
