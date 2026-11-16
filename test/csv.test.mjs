// CSV 工具：BOM、转义、解析往返。
import test from 'node:test';
import assert from 'node:assert/strict';

import { toCsv, csvWithBom, parseCsv } from '../eval/lib/csv.mjs';

test('逗号、引号、换行都会转义', () => {
  const csv = toCsv([{ a: 'x,y', b: '他说“好”', c: '第一行\n第二行' }], ['a', 'b', 'c']);
  const rows = parseCsv(csv);
  assert.deepEqual(rows, [{ a: 'x,y', b: '他说“好”', c: '第一行\n第二行' }]);
});

test('BOM 只加在开头', () => {
  const csv = csvWithBom('a,b\n1,2\n');
  assert.ok(csv.startsWith('\ufeff'));
  assert.equal(csv.indexOf('\ufeff'), 0);
  assert.deepEqual(parseCsv(csv), [{ a: '1', b: '2' }]);
});

test('列定义支持格式化函数', () => {
  const csv = toCsv([{ n: 3 }], [{ key: 'n', format: (r) => r.n * 2 }]);
  assert.equal(csv.trim(), 'n\n6');
});

test('空值输出为空串而不是 null', () => {
  const csv = toCsv([{ a: null, b: undefined }], ['a', 'b']);
  assert.equal(csv.trim().split('\n')[1], ',');
});
