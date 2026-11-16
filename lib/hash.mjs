// 共享的小工具：内容哈希。sha1 给契约对账，sha256 给原著去重。
import { createHash } from 'node:crypto';

export function sha1(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex');
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}
