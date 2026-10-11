// 来源：pi-flow src/core/test-adjust.ts @ 31f3f15
// 适配已有测试（第四轮后续）：合并时跑全量测试，改了接口的模块会让别的模块已有的测试失败，
// 而有权改那些测试的任务往往排在后面。实施类任务因此可以修改基线上已有的测试文件（不限角色可写范围），
// 只能修改，不能新增或删除；改了哪些记在任务上与 handoff 里。
import type { FlowConfig } from '../state/config.ts';
import type { TaskFile } from '../state/schemas.ts';
import { git } from '../state/git.ts';
import { matchesAny } from '../state/paths.ts';

export const TEST_GLOBS = ['tests/**', 'test/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'] as const;

/** 本任务能否适配已有测试：testing.adjust_tests 未关闭、有可写范围的实施类任务（不含 merge-fix 与只读任务） */
export function testAdjustEnabled(config: FlowConfig, t: TaskFile): boolean {
  if (config.raw.testing?.adjust_tests === false) return false;
  if (!['impl', 'fix'].includes(t.kind)) return false;
  return config.role(t.role).writes.length > 0;
}

/** 基线上已有、在任务 writes 之外的测试文件 */
export function adjustableTests(worktree: string, base: string, writes: readonly string[]): string[] {
  return git(worktree, ['ls-tree', '-r', '--name-only', base]).split('\n')
    .filter((f) => f && !f.startsWith('tests/acceptance/') && matchesAny(f, TEST_GLOBS) && !matchesAny(f, writes));
}

/** 相对基线只修改过（不是新增、删除）的 writes 之外的已有测试文件 */
export function testAdjustments(worktree: string, base: string, writes: readonly string[]): string[] {
  return git(worktree, ['diff', '--name-status', '--no-renames', base, 'HEAD']).split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([st, f]) => st === 'M' && !!f && !f.startsWith('tests/acceptance/') && matchesAny(f, TEST_GLOBS) && !matchesAny(f, writes))
    .map(([, f]) => f!).sort();
}
