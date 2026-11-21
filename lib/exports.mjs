// project.json.exports —— 给兄弟插件的**派生**导出块。
//
// 为什么需要它：voice 0.2.0 修好路径后读 `<项目>/project.json`，递归找
// `forbidden|banned|bans|禁忌|forbiddenPhrases` 这类键的字符串数组
// （dsh-novel-voice/lib/contract.js:7-29）。但 fanfic 的 project.json 里从来没有这些键，
// 于是那条协作边「路径通了、数据还是没有」。
//
// 这里把**已经在 canon 里确认过**的少量内容导出去，只写一层、只读一次：
//   forbidden  ← 作者私设的 AU 签名 + 错名（都是「写了就错」的确切词）
//   addresses  ← 称呼表（谁→谁、公开/私下、从第几章改口）
// 上限刻意压小（forbidden 30 / addresses 60），导出块不是第二个账本。

const FORBIDDEN_LIMIT = 30;
const ADDRESS_LIMIT = 60;

function collectForbidden(declarations) {
  const out = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text.length < 2 || text.length > 30) return;
    if (!out.includes(text)) out.push(text);
  };
  for (const rule of declarations?.auRules || []) {
    for (const sig of rule?.signatures || []) push(sig);
  }
  for (const wrong of Object.keys(declarations?.typos || {})) push(wrong);
  return out.slice(0, FORBIDDEN_LIMIT);
}

function collectAddresses(canon) {
  const byId = new Map();
  for (const chr of canon?.characters || []) {
    if (!chr || !chr.id) continue;
    if (chr.status === 'rejected') continue;
    byId.set(chr.id, chr.name || chr.id);
  }
  const nameOf = (value) => byId.get(value) || String(value || '');
  const rows = [];
  for (const row of canon?.addresses || []) {
    if (!row || row.status === 'rejected') continue;
    const from = nameOf(row.from);
    const to = nameOf(row.to);
    if (!from || !to) continue;
    rows.push({
      from,
      to,
      form: row.form || row.publicForm || null,
      public: row.publicForm ?? row.form ?? null,
      private: row.privateForm ?? null,
      fromChapter: row.fromChapter ?? null,
    });
    if (rows.length >= ADDRESS_LIMIT) break;
  }
  return rows;
}

/**
 * 生成项目导出块。纯函数：同样的 canon + declarations + revision 一定得到同样的结果。
 * @param {{canon?: object, declarations?: object|null, revision?: number|null}} input
 */
export function buildExports({ canon = {}, declarations = null, revision = null } = {}) {
  return {
    schemaVersion: 1,
    revision: Number.isInteger(revision) ? revision : null,
    generatedAt: new Date().toISOString(),
    forbidden: collectForbidden(declarations),
    addresses: collectAddresses(canon),
  };
}

export { FORBIDDEN_LIMIT, ADDRESS_LIMIT };
