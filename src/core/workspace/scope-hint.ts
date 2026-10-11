// 失败提示里引导范围申请（F7 第一步，docs/ADVERSARIAL-REVIEW.md §4.7）：
// 语义冲突时，后合并的 task 在预检或合并验证里失败，失败的文件常常不在它的可写范围里；
// worker 不知道可以用 forge_request_scope 申请，只会把预检次数用完。纯函数 + 一个读 git 的小辅助。
import { git } from '../state/git.ts';
import { matchesAny } from '../state/paths.ts';
import type { TaskFile } from '../state/schemas.ts';

// 来自 stage/gates.ts（偏离 106）：workspace 在 stage 之下，不能反过来 import 它。
/** 从失败输出中找出仓库里的文件（测试文件、报错位置） */
export function failingFiles(output: string, tracked: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/[\w@.\-/]+\.[A-Za-z0-9]+/g)) {
    let p = m[0].replace(/^\.\//, '');
    if (!tracked.has(p)) {
      const parts = p.split('/');
      p = parts.map((_, i) => parts.slice(i).join('/')).find((x) => tracked.has(x)) ?? '';
    }
    if (p) out.add(p);
  }
  return [...out].slice(0, 20);
}

export const SCOPE_HINT_MAX_FILES = 10;
const UNREQUESTABLE = ['tests/acceptance/**', 'docs/spec/**', 'docs/contracts/**'];

/**
 * 失败输出里出现的、不在本 task 可写范围内的仓库文件（writes、shared、test_adjustments 之内的不算；
 * tests/acceptance/** 另走第 9.4 节的路径，也不算）。没有返回空串，有则返回一段中文提示。
 */
export function scopeHint(output: string, t: Pick<TaskFile, 'writes' | 'shared' | 'test_adjustments'>, tracked: ReadonlySet<string>): string {
  const own = [...t.writes, ...(t.shared ?? []), ...(t.test_adjustments ?? [])];
  // 申请不了的路径（scope.ts 的硬限制：验收测试另走第 9.4 节、规格走规格修订、契约走变更请求）不列出，免得误导
  const outside = failingFiles(output, tracked).filter((f) => !matchesAny(f, own) && !matchesAny(f, UNREQUESTABLE));
  if (!outside.length) return '';
  const shown = outside.slice(0, SCOPE_HINT_MAX_FILES).map((f) => `- ${f}`).join('\n');
  const more = outside.length > SCOPE_HINT_MAX_FILES ? `\n……还有 ${outside.length - SCOPE_HINT_MAX_FILES} 个` : '';
  return `失败输出里出现了不在你可写范围内的文件：\n${shown}${more}\n如果修好需要改它们，用 forge_request_scope 申请：属于已完成 task 的文件会被直接批准，与后续还没开工的 task 重叠的要主会话批准，与正在进行的 task 重叠的会被拒绝。`;
}

/** worktree 里已跟踪的文件（集成分支已同步进来，是集成分支文件集合的超集）；读不出时为空集 */
export function trackedFilesOf(dir: string): Set<string> {
  try { return new Set(git(dir, ['ls-files']).split('\n').filter(Boolean)); } catch { return new Set(); }
}

/** 给失败 reason 追加范围申请提示（没有越界文件时原样返回） */
export function withScopeHint(reason: string, output: string, t: Pick<TaskFile, 'writes' | 'shared' | 'test_adjustments'>, dir: string): string {
  const hint = scopeHint(output, t, trackedFilesOf(dir));
  return hint ? `${reason}\n${hint}` : reason;
}
