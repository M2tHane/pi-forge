// 验收相关的纯函数：修复 task 编号、失败输出里的验收目录。worker 自己写本 task 的验收测试（tests/acceptance/<T-xxx>/），
// 由 reviewer 审查并运行；阶段门禁跑全量验收测试，失败按负责的 task 派 .fx-n（stage-fix.ts）。
import type { TaskFile } from '../state/schemas.ts';

/** 下一个修复 task 的编号：T-003.fx-1、T-003.fx-2 */
export function nextFixId(tasks: readonly Pick<TaskFile, 'id'>[], impl: string): string {
  const n = tasks.map((t) => /^(.+)\.fx-(\d+)$/.exec(t.id)).filter((m) => m?.[1] === impl).map((m) => Number(m![2]));
  return `${impl}.fx-${Math.max(0, ...n) + 1}`;
}

/** 失败输出里出现的验收测试目录所属的 task（tests/acceptance/<task>/ 与 _support/<task>/） */
export function failingAcceptanceDirs(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/tests\/acceptance\/(?:_support\/)?(T-\d{3,})(?=\/)/g)) out.add(m[1]!);
  return [...out].sort();
}
