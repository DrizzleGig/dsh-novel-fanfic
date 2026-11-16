// 确定性检查器：只做可复核的规则匹配，不调用 LLM，不改稿，不打分。
// 每个 finding 必须能回答：在哪（draft 引文 + 偏移）、凭什么（canon 引文/规则）、跟哪条设定冲突。

import { deltaSuppresses } from './deltas.mjs';
import {
  parseDraft,
  splitParagraphs,
  splitSentences,
  findQuotes,
  findAll,
  contextAround,
  charCount,
  normalizeWithOffsets,
  normalize,
  chapterNum,
} from './text.mjs';

const SPEECH_VERB = '说|问|道|答|喊|叫|开口|回应|回答|低声|轻声|笑道|应道|答道|叹道|嘟囔|念叨';
const GUARD = /(不知道|并不知情|还不知道|不许|不得|不能|不准|不要|禁止|若|如果|要是|假如)/;

export const GATE_DETECTORS = ['appearance', 'address', 'knowledge', 'auLeak', 'tagDefault'];

let seq = 0;
function mkFinding(f) {
  seq += 1;
  return {
    id: `f${String(seq).padStart(4, '0')}`,
    detector: f.detector,
    code: f.code,
    severity: f.severity || 'blocker',
    chapter: f.chapter || null,
    quote: f.quote || '',
    offset: f.offset ?? -1,
    where: f.where || (f.offset >= 0 ? `正文偏移 ${f.offset}` : '正文'),
    why: f.why || '',
    canonRef: f.canonRef || null,
    message: f.message || '',
    suggest: f.suggest || '',
  };
}

/** 给正文里的对话标注说话人（启发式，只用于称呼/知情两类判定）。 */
export function annotateDialogue(body, canon) {
  const paragraphs = splitParagraphs(body);
  const names = canon.characters.map((c) => c.name);
  let lastNamed = null;
  const out = [];
  for (const para of paragraphs) {
    const quotes = findQuotes(para.text);
    const mentions = [];
    for (const name of names) {
      for (const idx of findAll(para.text, name)) mentions.push({ idx, name });
    }
    mentions.sort((a, b) => a.idx - b.idx);
    let mi = 0;
    for (const q of quotes) {
      while (mi < mentions.length && mentions[mi].idx < q.start) {
        lastNamed = mentions[mi].name;
        mi += 1;
      }
      const before = para.text.slice(0, q.start);
      const after = para.text.slice(q.end);
      const tail = before.slice(-40);
      const head = after.slice(0, 40);
      let speaker = null;
      let confidence = 'none';
      let evidence = '';

      // 1) 引号前：X说 / X问 …
      for (const name of names) {
        const re = new RegExp(`${name}[^。！？\\n]{0,12}?(${SPEECH_VERB})`, 'g');
        let m;
        let last = null;
        while ((m = re.exec(tail)) !== null) last = m;
        if (last) {
          speaker = name;
          confidence = 'explicit';
          evidence = tail.slice(Math.max(0, last.index - 4));
          break;
        }
      }
      // 1.5) 引号前以冒号收尾：小舞跳起来：“…” / 唐三：“…”
      // 中文小说里「动作＋冒号＋引语」很常见，但动作不是「说/道」类动词，规则 1 抓不到。
      if (!speaker && /[：:]\s*$/.test(tail)) {
        for (const name of names) {
          const at = tail.lastIndexOf(name);
          if (at >= 0 && tail.length - (at + name.length) <= 12) {
            speaker = name;
            confidence = 'explicit';
            evidence = tail.slice(at);
            break;
          }
        }
      }
      // 2) 引号后：X说 / 是X的声音
      if (!speaker) {
        for (const name of names) {
          const re = new RegExp(`^[，,]?\\s*${name}(?:的声音|(?:[^。！？\\n]{0,8}?(${SPEECH_VERB})))?`, 'g');
          const m = re.exec(head);
          if (m && (head.includes(name))) {
            speaker = name;
            confidence = 'explicit';
            evidence = head.slice(0, 24);
            break;
          }
        }
      }
      // 3) 引号前：他说 / 她问（代词回指最近提到的角色）
      if (!speaker) {
        const m = tail.match(new RegExp(`(?:^|[，。\\n])(他|她)[^。！？\\n]{0,6}?(${SPEECH_VERB})`));
        if (m && lastNamed) {
          speaker = lastNamed;
          confidence = 'pronoun';
          evidence = m[0];
        }
      }
      // 4) 引号后：他说 / 她问
      if (!speaker) {
        const m = head.match(new RegExp(`^[，,]?(他|她)[^。！？\\n]{0,6}?(${SPEECH_VERB})`));
        if (m && lastNamed) {
          speaker = lastNamed;
          confidence = 'pronoun';
          evidence = m[0];
        }
      }
      out.push({
        ...q,
        text: para.text.slice(q.start, q.end),
        inner: q.text.slice(1, -1),
        speaker,
        confidence,
        evidence,
        paragraphOffset: para.offset,
        absoluteStart: para.offset + q.start,
        absoluteEnd: para.offset + q.end,
        absoluteInnerStart: para.offset + q.innerStart,
      });
    }
    // 段落内最后提到的名字留给下一段做代词回指
    if (mentions.length) lastNamed = mentions[mentions.length - 1].name;
  }
  return out;
}

function quoteContaining(quotes, absIdx) {
  return quotes.find((q) => absIdx >= q.absoluteStart && absIdx < q.absoluteEnd) || null;
}

function sentenceContaining(sentences, absIdx) {
  return sentences.find((s) => absIdx >= s.offset && absIdx < s.end) || null;
}

function isVocative(inner, form) {
  const segments = inner.split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (seg === form) return true;
    if (seg.startsWith(form)) {
      const next = seg[form.length];
      if (next && '，,、：:　 '.includes(next)) return true;
    }
    if (seg.endsWith(form)) {
      const prev = seg[seg.length - form.length - 1];
      if (prev && '，,、：:　 '.includes(prev)) return true;
    }
  }
  return false;
}

function characterByName(canon, name) {
  return canon.charByName.get(name) || null;
}

/* ---------------- 各检测器 ---------------- */

function checkTag(parsed, scene, findings) {
  const tag = parsed.tag;
  const firstLine = String(parsed.raw || '').split(/\r?\n/)[0].trim();
  if (!tag) {
    findings.push(mkFinding({
      detector: 'tagDefault',
      code: 'tag_missing',
      severity: 'warning',
      chapter: scene.chapter,
      quote: firstLine || '（空稿）',
      offset: 0,
      where: '首行',
      why: '写作要求：首行必须标注【标签】原著向 或【标签】私设',
      canonRef: { scene: scene.id, expected: scene.tag },
      message: '缺少【标签】行，无法判断这是原著向还是私设',
      suggest: `在首行补【标签】${scene.tag}`,
    }));
    return;
  }
  if (tag !== scene.tag) {
    findings.push(mkFinding({
      detector: 'tagDefault',
      code: 'tag_mismatch',
      severity: 'blocker',
      chapter: scene.chapter,
      quote: firstLine,
      offset: 0,
      where: '首行',
      why: `场景 ${scene.id} 标签为「${scene.tag}」，草稿标成「${tag}」`,
      canonRef: { scene: scene.id, expected: scene.tag, actual: tag },
      message: `标签违约：标成「${tag}」，与场景「${scene.tag}」不符`,
      suggest: `改回【标签】${scene.tag}，或把这段明确当作另一条 AU 线来写`,
    }));
  }
}

function checkName(body, canon, scene, findings) {
  for (const [variant, info] of canon.typoMap) {
    for (const idx of findAll(body, variant)) {
      findings.push(mkFinding({
        detector: 'name',
        code: 'name_typo',
        severity: 'blocker',
        chapter: scene.chapter,
        quote: contextAround(body, idx, idx + variant.length, 60),
        offset: idx,
        where: `正文偏移 ${idx}`,
        why: `错字表登记：${variant} → ${info.correct}`,
        canonRef: { character: info.charId, correct: info.correct, variant },
        message: `错名「${variant}」，应为「${info.correct}」`,
        suggest: `改成「${info.correct}」`,
      }));
    }
  }
}

function checkAppearance(body, canon, scene, findings) {
  const shen = canon.charById.get('char_shen');
  const scarFact = canon.factById.get(shen?.appearance?.scarSide?.factId || 'fact_02');
  const patterns = [
    /右(?:边|侧|边儿)?眉(?:骨|梢|尾|毛|头)?[^。！？\n]{0,12}(?:疤|伤痕|伤)/g,
    /(?:疤|伤痕)[^。！？\n]{0,12}右(?:边|侧|边儿)?眉(?:骨|梢|尾|毛|头)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) !== null) {
      findings.push(mkFinding({
        detector: 'appearance',
        code: 'appearance_scar_side',
        severity: 'blocker',
        chapter: scene.chapter,
        quote: contextAround(body, m.index, m.index + m[0].length, 50),
        offset: m.index,
        where: `正文偏移 ${m.index}`,
        why: scarFact ? `canon：${scarFact.quote}` : 'canon：疤在左眉骨',
        canonRef: scarFact ? { fact: scarFact.id, chapter: scarFact.chapter, quote: scarFact.quote } : null,
        message: `外貌错误：${shen?.name || '沈砚'} 的疤在左眉骨，草稿写成右眉`,
        suggest: '把「右眉」改成「左眉」',
      }));
    }
  }
}

function checkAddress(body, canon, scene, quotes, findings) {
  const chapNum = chapterNum(scene.chapter);
  for (const rule of canon.addressRules) {
    // 忌讳写法不一定同时出现在 forms 里（导入项目的称呼矩阵常常只有公开/私下两种），
    // 所以单独并进来一起查。
    const candidates = [...new Set([...(rule.forms || []), ...(rule.taboo || [])])];
    for (const q of quotes) {
      if (q.speaker !== rule.fromChar?.name) continue;
      for (const form of candidates) {
        if (!isVocative(q.inner, form)) continue;
        const base = {
          detector: 'address',
          chapter: scene.chapter,
          quote: q.text,
          offset: q.absoluteStart,
          where: `正文偏移 ${q.absoluteStart}（${rule.fromChar.name} 对 ${rule.toChar.name} 的称呼）`,
        };
        if ((rule.taboo || []).includes(form)) {
          const ev = Array.isArray(rule.evidence) ? rule.evidence[0] : rule.evidence;
          findings.push(mkFinding({
            ...base,
            code: 'address_taboo',
            severity: 'blocker',
            why: `称呼矩阵：${rule.id} 的 taboo 含「${form}」${ev?.quote ? `；evidence「${ev.quote}」（${ev.chapter || ''}）` : ''}`,
            canonRef: { rule: rule.id, taboo: rule.taboo, evidence: rule.evidence },
            message: `称呼忌讳：${rule.fromChar.name} 叫 ${rule.toChar.name}「${form}」`,
            suggest: `改用「${rule.privateForm || rule.publicForm || '公开称呼'}」`,
          }));
          continue;
        }
        if (form === rule.publicForm && rule.retireNum && chapNum >= rule.retireNum) {
          findings.push(mkFinding({
            ...base,
            code: 'address_retired',
            severity: 'blocker',
            why: `称呼矩阵：${rule.id} 从 ${rule.retirePublicFrom} 起改口为「${rule.privateForm}」；evidence「${rule.evidence?.quote}」（${rule.evidence?.chapter}）`,
            canonRef: { rule: rule.id, retiredFrom: rule.retirePublicFrom, evidence: rule.evidence },
            message: `称呼过期：${scene.chapter} 已改口，仍用「${form}」`,
            suggest: `改成「${rule.privateForm}」`,
          }));
          continue;
        }
        if (form === rule.privateForm && chapNum < rule.fromNum) {
          findings.push(mkFinding({
            ...base,
            code: 'address_early',
            severity: 'blocker',
            why: `称呼矩阵：${rule.id} 从 ${rule.fromChapter} 才改口，${scene.chapter} 尚未到`,
            canonRef: { rule: rule.id, fromChapter: rule.fromChapter, evidence: rule.evidence },
            message: `提前改口：${scene.chapter} 就叫「${form}」`,
            suggest: `先用「${rule.publicForm}」`,
          }));
        }
      }
    }
  }
}

function checkKnowledge(body, canon, scene, quotes, findings) {
  const chapNum = chapterNum(scene.chapter);
  const sentences = splitSentences(body);
  const povName = canon.charById.get(scene.pov)?.name || scene.pov;
  for (const secret of canon.secrets) {
    for (const sig of secret.signatures || []) {
      for (const idx of findAll(body, sig)) {
        const sent = sentenceContaining(sentences, idx);
        if (sent && GUARD.test(sent.text)) continue;
        const q = quoteContaining(quotes, idx);
        if (q) {
          const speaker = q.speaker;
          if (!speaker) {
            findings.push(mkFinding({
              detector: 'knowledge',
              code: 'knowledge_attribution_unclear',
              severity: 'info',
              chapter: scene.chapter,
              quote: q.text,
              offset: q.absoluteStart,
              where: `正文偏移 ${q.absoluteStart}`,
              why: `秘密 ${secret.id} 的签名「${sig}」出现在对话里，但说话人归属不确定`,
              canonRef: { secret: secret.id },
              message: `秘密出现在对话中，但无法确定是谁说的`,
              suggest: '补一个明确的说话人，避免歧义',
            }));
            continue;
          }
          const known = secret.knownByMap.get(speaker);
          const knownNum = known ? chapterNum(known.fromChapter) : Infinity;
          if (knownNum > chapNum) {
            findings.push(mkFinding({
              detector: 'knowledge',
              code: 'knowledge_early_dialogue',
              severity: 'blocker',
              chapter: scene.chapter,
              quote: q.text,
              offset: q.absoluteStart,
              where: `正文偏移 ${q.absoluteStart}（说话人：${speaker}）`,
              why: known
                ? `canon：${speaker} 从 ${known.fromChapter} 才知情（evidence「${known.evidence?.quote}」）；本场景 ${scene.chapter}`
                : `canon：${speaker} 不在该秘密的 knownBy 列表里`,
              canonRef: { secret: secret.id, knownBy: known || null },
              message: `提前知情（对话）：${speaker} 在 ${scene.chapter} 说出了秘密`,
              suggest: '改成不知情的措辞，或把这段挪到知情之后',
            }));
          } else if (chapNum < secret.forbiddenNum) {
            findings.push(mkFinding({
              detector: 'knowledge',
              code: 'knowledge_spoken_early',
              severity: 'blocker',
              chapter: scene.chapter,
              quote: q.text,
              offset: q.absoluteStart,
              where: `正文偏移 ${q.absoluteStart}（说话人：${speaker}）`,
              why: `canon：秘密 ${secret.id} 在对话中不得早于 ${secret.dialogueForbiddenBefore} 公开`,
              canonRef: { secret: secret.id, dialogueForbiddenBefore: secret.dialogueForbiddenBefore },
              message: `秘密过早说出口：${scene.chapter} 的对话里出现「${sig}」`,
              suggest: `把公开时间挪到 ${secret.dialogueForbiddenBefore} 之后`,
            }));
          }
        } else {
          const pov = scene.pov;
          const known = secret.knownByMap.get(pov);
          const knownNum = known ? chapterNum(known.fromChapter) : Infinity;
          if (knownNum > chapNum) {
            findings.push(mkFinding({
              detector: 'knowledge',
              code: 'knowledge_early_narration',
              severity: 'blocker',
              chapter: scene.chapter,
              quote: contextAround(body, idx, idx + sig.length, 60),
              offset: idx,
              where: `正文偏移 ${idx}（POV：${povName}）`,
              why: known
                ? `canon：${povName} 从 ${known.fromChapter} 才知情（evidence「${known.evidence?.quote}」）`
                : `canon：${povName} 不在该秘密的 knownBy 列表里`,
              canonRef: { secret: secret.id, knownBy: known || null },
              message: `提前知情（叙述）：${scene.chapter} 的 POV 叙述里出现「${sig}」`,
              suggest: '删掉或改成不知情视角能观察到的东西',
            }));
          }
        }
      }
    }
  }
}

function checkWorldRules(body, canon, scene, findings) {
  const sentences = splitSentences(body);
  // 钟声类规则只在“钟还在响、人还在动”时才算违反；散/尽/之后/等/站直/不喊 这些
  // 都说明人物在守规矩或钟已过，不能报。（实测真实稿里 5 条误报全出在这里。）
  const COMPLIANT = /(散|停|止|住|完|落|歇|过|尽|之后|以后|之前|以前|才|等|直到|静|不动|动不了|不了|不许|不准|不得|不能|不要|别|没|谁也没|噤声|站直|站定|垂手)/;
  // 预告/计划里的钟声不算违规：「港上要响潮声钟」后面有人开口，是钟还没响时的对话。
  const FORECAST = /(?:要|将|快|马上|就要|即将|会)[^，。！？\n]{0,8}(?:潮声钟|钟声|钟响|钟)|(?:潮声钟|钟声|钟响|钟)[^，。！？\n]{0,6}(?:要|将|快|马上|就要|即将|会)(?:响|敲)/;
  for (const rule of canon.worldRules) {
    for (const re of rule.patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body)) !== null) {
        const sent = sentenceContaining(sentences, m.index);
        if (sent && GUARD.test(sent.text)) continue;
        if (sent && COMPLIANT.test(sent.text)) continue;
        if (sent && FORECAST.test(sent.text)) continue;
        findings.push(mkFinding({
          detector: 'worldRule',
          code: 'worldrule_violation',
          severity: 'blocker',
          chapter: scene.chapter,
          quote: contextAround(body, m.index, m.index + m[0].length, 50),
          offset: m.index,
          where: `正文偏移 ${m.index}`,
          why: `canon 规则「${rule.name}」：${rule.evidence?.quote}（${rule.evidence?.chapter}）`,
          canonRef: { rule: rule.id, name: rule.name, evidence: rule.evidence },
          message: `世界规则违反：${rule.name}`,
          suggest: rule.severity === 'blocker' ? '删掉这个动作或改写时机' : '核对规则',
        }));
      }
    }
  }
}

function checkAuLeak(body, canon, scene, findings, declaredTag) {
  // AU 只在“原著向”语境里算泄漏：场景本身是私设，或稿件自己声明了私设，
  // 都不再重复报 AU（标签与场景不符由 tagDefault 负责）。
  if (scene.tag === '私设' || declaredTag === '私设') return;
  const declared = new Set(scene.declaredAu || []);
  for (const { sig, rule } of canon.auSignatures) {
    if (declared.has(rule.id)) continue;
    for (const idx of findAll(body, sig)) {
      findings.push(mkFinding({
        detector: 'auLeak',
        code: 'au_leak',
        severity: 'blocker',
        chapter: scene.chapter,
        quote: contextAround(body, idx, idx + sig.length, 60),
        offset: idx,
        where: `正文偏移 ${idx}`,
        why: `AU 规则「${rule.name}」不在原著 canon 里（${rule.text}）；场景标签为「${scene.tag}」`,
        canonRef: { auRule: rule.id, name: rule.name, signatures: rule.signatures },
        message: `AU 规则泄漏：出现「${sig}」`,
        suggest: `删掉，或把这章明确标成「私设」并声明 ${rule.id}`,
      }));
    }
  }
}

function checkUnknown(body, canon, scene, findings) {
  for (const fc of canon.contradictions) {
    if ((fc.status || 'open') !== 'open') continue;
    for (const variant of fc.variants) {
      for (const idx of findAll(body, variant)) {
        const win = body.slice(Math.max(0, idx - 12), Math.min(body.length, idx + variant.length + 12));
        if (!/[眼睛瞳眸]/.test(win)) continue;
        findings.push(mkFinding({
          detector: 'unknown',
          code: 'unknown_asserted',
          severity: 'blocker',
          chapter: scene.chapter,
          quote: contextAround(body, idx, idx + variant.length, 60),
          offset: idx,
          where: `正文偏移 ${idx}`,
          why: `canon 矛盾 ${fc.id}（未裁决）：${fc.values.join(' / ')}；证据 ${fc.evidence?.map((e) => `${e.chapter}「${e.quote}」`).join('；')}`,
          canonRef: { contradiction: fc.id, values: fc.values, chapters: fc.chapters, factIds: fc.factIds },
          message: `断言了未定事实：${fc.subject} 的${fc.predicate}写成「${variant}」`,
          suggest: '删掉颜色断言，或改写成不确定的观察（“灯下看不清”）',
        }));
      }
    }
  }
}

function checkHeadcanon(body, canon, scene, findings) {
  for (const sig of canon.headcanonSignatures) {
    for (const idx of findAll(body, sig)) {
      findings.push(mkFinding({
        detector: 'headcanon',
        code: 'headcanon_undeclared',
        severity: 'warning',
        chapter: scene.chapter,
        quote: contextAround(body, idx, idx + sig.length, 60),
        offset: idx,
        where: `正文偏移 ${idx}`,
        why: `canon 没有这条设定；场景标签「${scene.tag}」未声明私设`,
        canonRef: { signature: sig, sceneTag: scene.tag },
        message: `未声明私设：出现「${sig}」`,
        suggest: '删掉，或在场景里显式声明这条私设',
      }));
    }
  }
}

function checkBranchCross(body, scene, findings) {
  const re = /(IF\s*线|if\s*线|平行世界|平行时空|另一条时间线|另一条世界线|世界线分叉|另一条线)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    findings.push(mkFinding({
      detector: 'branchCross',
      code: 'branch_cross',
      severity: 'info',
      chapter: scene.chapter,
      quote: contextAround(body, m.index, m.index + m[0].length, 50),
      offset: m.index,
      where: `正文偏移 ${m.index}`,
      why: 'v0.1 单分支：正文不该出现分支意识',
      canonRef: { scene: scene.id },
      message: `分支串线：出现「${m[0]}」`,
      suggest: '删掉元叙述',
    }));
  }
}

function checkCopy20(body, canon, scene, findings) {
  const N = 20;
  const srcNorm = normalizeWithOffsets(canon.source);
  if (srcNorm.text.length < N) return;
  const draftNorm = normalizeWithOffsets(body);
  const srcText = srcNorm.text;
  let i = 0;
  const spans = [];
  while (i + N <= draftNorm.chars.length) {
    const sub = draftNorm.chars.slice(i, i + N).join('');
    if (srcText.includes(sub)) {
      let j = i + N;
      while (j + 1 <= draftNorm.chars.length && srcText.includes(draftNorm.chars.slice(i, j + 1).join(''))) j += 1;
      spans.push([i, j]);
      i = j;
    } else {
      i += 1;
    }
  }
  for (const [s, e] of spans) {
    const startOrig = draftNorm.offsets[s];
    const endOrig = draftNorm.offsets[e - 1] + 1;
    const copied = body.slice(startOrig, endOrig);
    const normCopied = normalize(copied);
    const chapter = canon.chapters.find((ch) => normalize(ch.body).includes(normCopied))?.id || null;
    findings.push(mkFinding({
      detector: 'copy20',
      code: 'copy_20',
      severity: 'warning',
      chapter: scene.chapter,
      quote: contextAround(body, startOrig, endOrig, 40),
      offset: startOrig,
      where: `正文偏移 ${startOrig}`,
      why: `与原著连续重合 ${normCopied.length} 字（阈值 20）${chapter ? `，出自 ${chapter}` : ''}`,
      canonRef: chapter ? { chapter, quote: copied } : { quote: copied },
      message: `复制原著 ${normCopied.length} 字`,
      suggest: '改写这段，只保留必要的短引文',
    }));
  }
}

function checkContractGap(body, canon, scene, quotes, findings) {
  const contract = scene.contract;
  if (!contract) return;
  for (const rf of scene.requiredForms || []) {
    const rule = canon.addressRules.find((m) => m.from === rf.from && m.to === rf.to);
    // 称呼可能单独成句（“阿砚。”）而没有归属，这种也算用上了；只要不是别人在叫。
    const ok = quotes.some((q) => {
      if (!q.inner.includes(rf.form)) return false;
      if (q.speaker === rule?.fromChar?.name) return true;
      return !q.speaker && isVocative(q.inner, rf.form);
    });
    if (!ok) {
      findings.push(mkFinding({
        detector: 'contractGap',
        code: 'contract_missing_form',
        severity: 'warning',
        chapter: scene.chapter,
        why: `契约 ${scene.contractFile} 要求 ${rule?.fromChar?.name}→${rule?.toChar?.name} 使用「${rf.form}」`,
        canonRef: { contract: scene.contractFile, requiredForm: rf },
        message: `契约遗漏：没有出现称呼「${rf.form}」`,
        suggest: `在对话里让 ${rule?.fromChar?.name} 叫一声「${rf.form}」`,
      }));
    }
  }
  for (const secretId of scene.mustReveal || []) {
    const secret = canon.secrets.find((s) => s.id === secretId);
    if (!secret) continue;
    const ok = (secret.signatures || []).some((sig) => body.includes(sig));
    if (!ok) {
      findings.push(mkFinding({
        detector: 'contractGap',
        code: 'contract_missing_reveal',
        severity: 'warning',
        chapter: scene.chapter,
        why: `契约 ${scene.contractFile} 要求本章必须揭示 ${secretId}`,
        canonRef: { contract: scene.contractFile, secret: secretId },
        message: '契约遗漏：本章承诺揭示的秘密没有出现',
        suggest: '把秘密写进本章的对话或叙述',
      }));
    }
  }
}

/**
 * 主入口：跑全部确定性检查。
 * @param {string} raw 草稿原文（含【标签】【正文】）
 * @param {object} scene 场景（含 chapter/tag/pov/requiredForms/mustReveal/contract）
 * @param {object} canon loadFixture 的返回值
 * @param {{arm?: string}} opts
 */
export function runCheck(raw, scene, canon, opts = {}) {
  seq = 0;
  const parsed = parseDraft(raw);
  const body = parsed.body;
  const findings = [];
  const quotes = annotateDialogue(body, canon);

  checkTag(parsed, scene, findings);
  checkName(body, canon, scene, findings);
  checkAppearance(body, canon, scene, findings);
  checkAddress(body, canon, scene, quotes, findings);
  checkKnowledge(body, canon, scene, quotes, findings);
  checkWorldRules(body, canon, scene, findings);
  checkAuLeak(body, canon, scene, findings, parsed.tag);
  checkUnknown(body, canon, scene, findings);
  checkHeadcanon(body, canon, scene, findings);
  checkBranchCross(body, scene, findings);
  checkCopy20(body, canon, scene, findings);
  if (opts.arm === 'B' || opts.arm === 'C') checkContractGap(body, canon, scene, quotes, findings);

  // 同一个位置可能被同一条规则的多个变体命中（「浅褐色」「浅褐」），只留一条。
  const seenKeys = new Set();
  const unique = [];
  for (const f of findings) {
    const key = `${f.detector}:${f.code}:${f.offset}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(f);
  }
  findings.length = 0;
  findings.push(...unique);

  // 本作设定：作者明确改过的，不再按原著报。放过不是静音——suppressed 会随结果返回，
  // 面板和 CLI 都能看到「按哪条本作设定放过了什么」。
  const suppressed = [];
  const deltas = Array.isArray(canon?.deltas) ? canon.deltas : [];
  if (deltas.length) {
    const kept = [];
    for (const finding of findings) {
      const owner = deltas.find((row) => deltaSuppresses(row, finding));
      if (owner) suppressed.push({ ...finding, suppressedBy: { id: owner.id, title: owner.title } });
      else kept.push(finding);
    }
    findings.length = 0;
    findings.push(...kept);
  }

  findings.sort((a, b) => a.offset - b.offset || a.detector.localeCompare(b.detector));
  const bySeverity = { blocker: 0, warning: 0, info: 0 };
  const byDetector = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byDetector[f.detector] = (byDetector[f.detector] || 0) + 1;
  }
  const gateFindings = findings.filter((f) => GATE_DETECTORS.includes(f.detector));
  return {
    tag: parsed.tag,
    chars: charCount(body),
    paragraphs: splitParagraphs(body).length,
    dialogueQuotes: quotes.length,
    findings,
    suppressed,
    summary: {
      bySeverity,
      byDetector,
      blockers: bySeverity.blocker,
      warnings: bySeverity.warning,
      infos: bySeverity.info,
      gateBlockers: gateFindings.filter((f) => f.severity === 'blocker').length,
      gateFindings: gateFindings.length,
      suppressed: suppressed.length,
    },
    quotes,
  };
}

/** 简短可读输出（CLI 用）。 */
export function formatFindings(result) {
  const lines = [];
  const { summary } = result;
  lines.push(`标签：${result.tag ?? '（缺失）'}　字数：${result.chars}　段落：${result.paragraphs}`);
  lines.push(`结论：blocker ${summary.blockers}　warning ${summary.warnings}　info ${summary.infos}　（必检门 blocker：${summary.gateBlockers}）`);
  if (result.suppressed?.length) {
    lines.push(`本作设定放过 ${result.suppressed.length} 条：`);
    for (const f of result.suppressed) {
      lines.push(`  - ${f.detector}/${f.code}「${f.quote}」按「${f.suppressedBy?.title || '本作设定'}」放过`);
    }
  }
  for (const f of result.findings) {
    lines.push('');
    lines.push(`[${f.severity}] ${f.detector}/${f.code}${f.chapter ? ` @${f.chapter}` : ''}　${f.where}`);
    lines.push(`  问题：${f.message}`);
    lines.push(`  草稿：${f.quote}`);
    lines.push(`  依据：${f.why}`);
    if (f.canonRef?.quote) lines.push(`  canon：${f.canonRef.quote}`);
    if (f.suggest) lines.push(`  建议：${f.suggest}`);
  }
  return lines.join('\n');
}
