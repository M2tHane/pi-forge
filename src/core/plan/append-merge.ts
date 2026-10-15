// "只追加"文件的行级三方合并。纯函数，不读写文件，由合并队列在 rebase 冲突时调用。
// 用途：S0 生成的共享代码（类型包、错误码常量、统一错误响应等）会被多个 task 同时往里追加内容，合并时产生文本冲突。
// 只在双方相对 base 都"只有插入"（base 的每一行按顺序原样出现在 ours 与 theirs 里）时合并；任何一方改动或删除了 base 的行就放弃，交回原有的冲突处理。
// 限制：同一位置双方都插入时，集成分支（ours）的内容在前；合并后语法是否仍成立（重复定义、导出顺序等）由合并后回归测试与阶段门禁的全量测试把关。
// 超过 20000 行的文件不合并；换行风格按 ours（末尾有无换行与 ours 一致）。
import type { MergeOutcome } from './contract-merge.ts';

const MAX_LINES = 20000;

/** 切成行；末尾的一个换行不产生空行，空文本是 0 行 */
function toLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

type Embedded = { inserts: string[][]; tail: string[] } | { missing: number };

/** 最左贪心把 base 嵌入 side：inserts[i] 是 base 第 i 行之前的插入块，tail 是最后一行之后的插入块；嵌不进去时给出第一个丢失的 base 行号 */
function embed(base: string[], side: string[]): Embedded {
  const inserts: string[][] = [];
  let j = 0;
  for (let i = 0; i < base.length; i++) {
    let k = j;
    while (k < side.length && side[k] !== base[i]) k++;
    if (k === side.length) return { missing: i };
    inserts.push(side.slice(j, k));
    j = k + 1;
  }
  return { inserts, tail: side.slice(j) };
}

export function mergeAppendOnlyThreeWay(base: string, ours: string, theirs: string): MergeOutcome {
  if (ours === theirs) return { ok: true, text: ours };
  if (base === theirs) return { ok: true, text: ours };
  if (base === ours) return { ok: true, text: theirs };
  const [b, o, t] = [toLines(base), toLines(ours), toLines(theirs)];
  if (Math.max(b.length, o.length, t.length) > MAX_LINES) return { ok: false, reason: `文件超过 ${MAX_LINES} 行，不做自动合并` };
  const eo = embed(b, o);
  if ('missing' in eo) return { ok: false, reason: `ours（集成分支）修改或删除了已有的第 ${eo.missing + 1} 行：${brief(b[eo.missing]!)}` };
  const et = embed(b, t);
  if ('missing' in et) return { ok: false, reason: `theirs（任务）修改或删除了已有的第 ${et.missing + 1} 行：${brief(b[et.missing]!)}` };
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(...eo.inserts[i]!, ...et.inserts[i]!, b[i]!);
  out.push(...eo.tail, ...et.tail);
  return { ok: true, text: out.join('\n') + (ours.endsWith('\n') ? '\n' : '') };
}

const brief = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
