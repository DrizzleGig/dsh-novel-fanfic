// 三臂提示模板。同一模型、同一温度、同一模板；唯一差别是注入的信息。
// 输出格式三臂完全一致，便于检查器与盲评。

import { retrieve } from '../../lib/lookup.mjs';

export const ARMS = ['A', 'B', 'C'];

export const ARM_LABEL = {
  A: '无契约',
  B: '契约',
  C: '契约+lookup',
};

function header({ scene, canon, minChars, maxChars }) {
  const pov = canon.charById.get(scene.pov);
  const lines = [
    '你是一位中文同人作者，正在为一部已完成的短篇写一段新的正文。',
    '',
    '硬约束的优先级：场景信息 > 已给出的原著信息 > 你的发挥。与它们冲突的写法一律不要。',
    '',
    '输出格式（必须严格遵守）：',
    '第一行：只写【标签】原著向 或【标签】私设 中的一个；',
    '第二行：只写【正文】；',
    '之后只写正文：不要写标题、章节号、提纲、说明、字数统计、总结，不要出现“作为 AI”“以下是”之类的话。',
    '',
    '这是一个【原著向】同人场景：背景与人物都来自原著，不是 AU、不是原创世界。除非场景明确要求写私设，第一行写【标签】原著向。',
    '',
    `正文长度：${minChars}–${maxChars} 个中文字符（不含标点也可以，但不要明显短于 ${minChars}）。`,
    `视角：${pov?.name || scene.pov}（第三人称受限视角，只写这个角色能感知到的东西）。`,
    '不要连续复制原著 20 字以上；需要引用原文时控制在很短的短语内。',
    '',
    '【场景】',
    scene.instruction,
  ];
  const probes = scene.probes || [];
  if (probes.length) {
    lines.push(
      '',
      '【这一段必须写到】',
      ...probes.map((p, i) => `${i + 1}. ${p}`),
      '',
      '注意：这些要求不得越过场景契约里的【禁忌】和【不确定】。两者冲突时，以契约为准——宁可写得含混，也不要写错。',
      '',
    );
  }
  return lines.join('\n');
}

function tail({ scene }) {
  return [
    '',
    '【收尾要求】',
    '1. 只写这一段，不要续写下一章。',
    '2. 人物说的话要符合各自的身份和此刻的知情程度。',
    '3. 如果下面给了场景契约，契约里的【禁忌】和【不确定】优先于任何文学发挥。',
    '',
    '现在开始写。',
  ].join('\n');
}

function lookupBlock(canon, scene) {
  const queries = scene.lookupQueries || [];
  const contested = [];
  for (const c of canon.contradictions || []) {
    if (c.status && c.status !== 'open') continue;
    for (const v of c.variants || []) if (v) contested.push(v);
  }
  const contestedHint = (quote) => (contested.some((v) => quote.includes(v)) ? '（属未裁决矛盾，不得据此断言）' : '');
  const lines = [];
  lines.push('【预取的原文检索结果】');
  lines.push('下面是编译器根据本章需要，从原著里预取的片段（可能不完整；不确定的地方不要编）。');
  lines.push('这些片段只帮你弄清事实，写作时请转述，不要连续照抄 15 字以上。');
  const seen = new Set();
  let n = 0;
  const shorten = (q) => {
    const t = q.trim();
    return t.length > 46 ? `${t.slice(0, 45)}…` : t;
  };
  for (const q of queries) {
    const res = retrieve(canon, { question: q, entities: [], limit: 3, window: 1 });
    for (const p of res.passages) {
      const cut = shorten(p.quote);
      const key = `${p.chapter}:${cut}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n += 1;
      lines.push(`- ${p.chapter}：${cut}（命中：${q}）`);
      if (n >= 5) break;
    }
    if (n >= 5) break;
  }
  if (!n) {
    lines.push('- （没有检索到直接相关的原文；按契约写，不要编造原文里没有的事实。）');
  }
  return lines.join('\n');
}

function contractBlock(canon, scene) {
  const md = scene.contract?.markdown || '';
  return ['【场景契约】', md.trim()].join('\n');
}

/**
 * 生成某臂某场景某次写作的完整提示。
 * @returns {{ text: string, meta: object }}
 */
export function buildPrompt({ scene, canon, arm, rep = 1 }) {
  if (!ARMS.includes(arm)) throw new Error(`未知实验臂：${arm}`);
  const minChars = scene.minChars ?? 500;
  const maxChars = scene.maxChars ?? 900;
  const parts = [header({ scene, canon, minChars, maxChars })];
  if (arm === 'B' || arm === 'C') {
    parts.push('', contractBlock(canon, scene));
  }
  if (arm === 'C') {
    parts.push('', lookupBlock(canon, scene));
  }
  parts.push(tail({ scene }));
  const text = parts.join('\n');
  return {
    text,
    meta: {
      arm,
      armLabel: ARM_LABEL[arm],
      scene: scene.id,
      chapter: scene.chapter,
      rep,
      chars: text.length,
      hasContract: arm !== 'A',
      hasLookup: arm === 'C',
    },
  };
}

export function sampleId(arm, sceneId, rep) {
  return `${arm}-${sceneId}-r${String(rep).padStart(2, '0')}`;
}

export function sampleFileName(arm, sceneId, rep) {
  return `${sampleId(arm, sceneId, rep)}.md`;
}
