// 适配已有测试：实施类任务可以改任何测试文件（不受 writes 限制）；这里只负责记录 writes 之外有哪些已有测试被修改过，
// 记在任务上与 handoff 里，给审查者看。
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

/** 相对基线只修改过（不是新增、删除）的 writes 之外的已有测试文件 */
export function testAdjustments(worktree: string, base: string, writes: readonly string[]): string[] {
  return git(worktree, ['diff', '--name-status', '--no-renames', base, 'HEAD']).split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([st, f]) => st === 'M' && !!f && !f.startsWith('tests/acceptance/') && matchesAny(f, TEST_GLOBS) && !matchesAny(f, writes))
    .map(([, f]) => f!).sort();
}
