// 写作适配器：
// - stub：确定性、零违规（用于管线 smoke 与 CI）；--stub-violations 时改用植入错误稿。
// - command：把提示从 stdin 喂给任意本地模型 CLI，从 stdout 收稿。
// 真实 45 篇也可以用 DSH 子代理生成：prepare 出 prompts，agent 写 drafts，再 score。

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const CLEAN_SENTENCES = [
  '雾贴着码头漫过来，渔船的桅杆只露出半截。',
  '风从海面上拐进来，把灯苗吹得斜了一下，又立住。',
  '他把门板推严，屋里的潮气还是往骨头里钻。',
  '潮水拍在石阶上，声音一下比一下慢。',
  '塔上的灯在雾里只剩一团黄，看着很近，走起来很远。',
  '她没有马上回答，手指在碗沿上停了一会儿。',
  '远处有橹声，摇得很慢，像是怕惊动什么。',
  '两个人都没有说话，只有风灯在门框上轻轻碰了一下。',
  '他低头看着自己的手，指节上还留着灯油的痕迹。',
  '石屋里冷，纸页翻动的声音显得格外响。',
  '雾薄了一点，能看见对面屋脊上的水痕。',
  '她把灯芯拨亮，火光照出架子上一排一排的册脊。',
  '门外有人停下脚步，没有敲门。',
  '他应了一声，把东西收进怀里，转身往塔下走。',
  '夜里涨潮，泊位上的空船一只挨着一只。',
  '话音落下，雾里没有回音。',
];

function padTo(text, minChars) {
  const parts = text.split('\n\n');
  let i = 0;
  let total = parts.join('').replace(/\s/g, '').length;
  while (total < minChars) {
    parts.push(CLEAN_SENTENCES[i % CLEAN_SENTENCES.length]);
    total += CLEAN_SENTENCES[i % CLEAN_SENTENCES.length].length;
    i += 1;
  }
  return parts.join('\n\n');
}

/**
 * 生成一篇确定性的草稿。
 * @param {{scene: object, canon: object, violations?: boolean, violationText?: string}} opts
 */
export function stubDraft({ scene, canon, violations = false, violationText = '' }) {
  if (violations && violationText) return violationText;
  const shen = canon.charById.get('char_shen');
  const pei = canon.charById.get('char_pei');
  const su = canon.charById.get('char_su');
  const lines = ['【标签】原著向', '【正文】'];
  const pov = canon.charById.get(scene.pov);
  const other = (scene.present || []).map((id) => canon.charById.get(id)).find((c) => c && c.id !== scene.pov);

  lines.push(`雾在港里停了整整一夜。${pov?.name || '他'}醒来的时候，窗纸是灰的。`);
  lines.push('他披上外衣，把灯芯掐短，推门出去。石阶上有一层水，踩上去不出声。');
  lines.push('');
  lines.push(`“你来了。”${other ? other.name : '有人'}在雾里说。`);
  lines.push('“嗯。”');
  lines.push('');
  if (scene.requiredForms?.length) {
    for (const rf of scene.requiredForms) {
      const from = canon.charById.get(rf.from);
      lines.push(`“${rf.form}，”${from?.name || '他'}说，“灯芯我带来了。”`);
      lines.push('“放门口吧。”');
      lines.push('');
    }
  }
  if (scene.mustReveal?.length) {
    const secret = canon.secrets.find((s) => scene.mustReveal.includes(s.id));
    if (secret && scene.chapter === 'ch004') {
      lines.push(`“${su?.name || '她'}，我父亲的事，你是不是知道什么。”`);
      lines.push('');
      lines.push(`“……你父亲还活着。”${su?.name || '她'}说。`);
      lines.push('');
      lines.push('石屋里静下来。他没有再问，手按在桌沿上，指节发白。');
      lines.push('');
    }
  }
  lines.push('他们把话说到一半，远处望潮台上传来闷闷的一声。潮水在雾里涨上来，拍着石阶。两个人都停了停，等那声音过去。');
  lines.push('');
  lines.push('“明日雾散了再说。”');
  lines.push('“好。”');
  lines.push('');
  lines.push(`${pei ? pei.name : '他'}把风灯提起来，光在雾里晕开一小团。${shen ? shen.name : '他'}站在原处，看着那团光一点一点走远。`);
  let body = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  body = padTo(body, scene.minChars ?? 500);
  return ['【标签】原著向', '【正文】', body].join('\n');
}

/** 读取 planted-errors 里的违规稿，供 --stub-violations 用。 */
export async function loadViolationDrafts(fixtureDir) {
  const dir = path.join(fixtureDir, 'planted-errors');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const out = [];
  for (const f of files) {
    out.push({ file: f, text: await readFile(path.join(dir, f), 'utf8') });
  }
  return out;
}

/**
 * command 适配器：spawn 一个本地进程，stdin 写提示，stdout 收草稿。
 * 例：--writer command --command "my-llm --temp 0.8"
 */
export function commandWriter({ prompt, command, cwd, timeoutMs = 180000, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`writer 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`writer 退出码 ${code}\n${stderr.slice(-2000)}`));
        return;
      }
      resolve({ text: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
