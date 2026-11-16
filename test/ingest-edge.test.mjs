// 导入的异常路径：扩展名、缺失、空文件、二进制、编码回退、BOM、CRLF、无标题、超限。
// 这些是「大文件/异常路径实测」里能离线钉住的部分；真实大书的速度另由 scripts/fanfic-perf.mjs 量。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceText, splitChapters, bookTitleOf, decodeText } from '../lib/ingest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'fic-edge-'));
const file = (name) => path.join(root, name);

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('扩展名：只收 txt / md，其余直接拒', async () => {
  const target = file('book.pdf');
  await writeFile(target, '第一章 测试\n\n正文');
  await assert.rejects(() => readSourceText(target), /只支持 txt \/ md/);
  await assert.rejects(() => readSourceText(file('book.exe')), /只支持/);
});

test('文件不存在 / 是目录：给可读错误而不是 ENOENT', async () => {
  await assert.rejects(() => readSourceText(file('nope.txt')), /文件不存在/);
  await assert.rejects(() => readSourceText(root, { checkExt: false }), /目录/);
});

test('空文件与纯空白：拒绝', async () => {
  await writeFile(file('empty.txt'), '');
  await assert.rejects(() => readSourceText(file('empty.txt')), /文件是空的/);
  await writeFile(file('blank.txt'), '   \n\n\t\n');
  await assert.rejects(() => readSourceText(file('blank.txt')), /没有可读的文字/);
});

test('二进制：含 NUL 或大量控制字符的文件不当文本导入', async () => {
  const bin = Buffer.concat([Buffer.from('第一章 测试\n\n'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])]);
  await writeFile(file('bin.txt'), bin);
  await assert.rejects(() => readSourceText(file('bin.txt')), /二进制/);

  const ctrl = Buffer.from(Array.from({ length: 400 }, () => 0x01));
  await writeFile(file('ctrl.txt'), ctrl);
  await assert.rejects(() => readSourceText(file('ctrl.txt')), /二进制/);
});

test('GB18030 回退：GBK 文件能读出来并分章', async () => {
  const text = await readSourceText(path.join(here, 'fixtures', 'gbk-sample.txt'));
  assert.equal(text.encoding, 'gb18030');
  assert.match(text.text, /第一章 雾港/);
  const chapters = splitChapters(text.text);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '雾港');
});

test('UTF-8 BOM 与 CRLF：都能分章，正文不带 \\r', async () => {
  const crlf = '\uFEFF第一章 雾港\r\n\r\n沈砚把灯油搬上栈桥。\r\n\r\n第二章 夜巡\r\n\r\n裴照提着风灯。\r\n';
  await writeFile(file('crlf.txt'), crlf);
  const read = await readSourceText(file('crlf.txt'));
  assert.equal(read.encoding, 'utf-8-bom');
  const chapters = splitChapters(read.text);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '雾港');
  assert.ok(!chapters[0].body.includes('\r'), '正文不应残留 \\r');
});

test('没有章节标题：按段落自动分块，书名取文件名', async () => {
  const body = Array.from({ length: 40 }, (_, i) => `第${i}段：雾从港口漫上来，灯还亮着。`).join('\n\n');
  await writeFile(file('no-heading.txt'), body);
  const read = await readSourceText(file('no-heading.txt'));
  const chapters = splitChapters(read.text);
  assert.ok(chapters.length >= 1);
  assert.match(chapters[0].title, /自动分块/);
  assert.equal(bookTitleOf(read.text, file('no-heading.txt')), 'no-heading');
});

test('超限：按上限拒绝，提示里带实际大小', async () => {
  await writeFile(file('big.txt'), 'x'.repeat(200));
  await assert.rejects(() => readSourceText(file('big.txt'), { maxBytes: 100 }), /超过 100 字节\s*上限/);
});

test('decodeText：UTF-8 正常、坏字节回退 GB18030', () => {
  const utf8 = decodeText(Buffer.from('第一章', 'utf8'));
  assert.equal(utf8.encoding, 'utf-8');
  assert.equal(utf8.text, '第一章');
  const gbk = decodeText(Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]));
  assert.equal(gbk.encoding, 'gb18030');
  assert.equal(gbk.text, '第一章');
});
