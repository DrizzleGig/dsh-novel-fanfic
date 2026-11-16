// CSV 输出：带 BOM，Excel 打开中文不乱码；列顺序固定。

export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows, columns) {
  const head = columns.map((c) => csvEscape(typeof c === 'string' ? c : c.key)).join(',');
  const lines = [head];
  for (const row of rows) {
    lines.push(columns.map((c) => {
      const key = typeof c === 'string' ? c : c.key;
      return csvEscape(typeof c === 'object' && c.format ? c.format(row) : row[key]);
    }).join(','));
  }
  return lines.join('\n') + '\n';
}

export function csvWithBom(text) {
  return '\ufeff' + text;
}

/** 极简 CSV 解析（支持引号与转义），用于读盲评结果。 */
export function parseCsv(text) {
  const src = String(text).replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((v) => v.trim())).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}
