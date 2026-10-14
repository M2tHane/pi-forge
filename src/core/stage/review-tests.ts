// 审查者要运行的、本 task 范围内的测试：预检不再跑命令，由审查者读 diff 并运行本 task 自己的单元测试与验收测试；
// 全量 test 与全量 acceptance 留到阶段门禁。这里只做纯计算（选哪些命令、哪些文件），命令写进审查任务说明，审查者按说明运行。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { TaskFile } from '../state/schemas.ts';
import { git, taskBaseOf } from '../state/git.ts';
import { acceptanceDirOf, matchesAny, writesOwnAcceptance } from '../state/paths.ts';
import { TEST_GLOBS } from '../verify/test-adjust.ts';
import { scanAcCoverage } from '../acceptance/coverage.ts';

/** 选择依据：本 task 改动的单元测试文件，以及 lean 共享验收目录下本 task 新增或修改的场景文件（相对 tests/acceptance/，如 suite/a.test.js）；accFiles 为 undefined 表示按目录名运行 */
export interface TestSelection {
  testFiles: string[];
  accFiles?: string[];
}

export interface ReviewTestPlan {
  /** 审查者要运行的命令（name 是 workflow.yaml commands 里的键） */
  run: { name: 'test' | 'acceptance'; shell: string }[];
  /** 被跳过的步骤及原因（写进任务说明，让审查者知道没有漏） */
  skipped: string[];
}

const shq = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;

/**
 * 本 task 范围内的测试命令（纯函数）：
 * - test：有改动的单元测试文件才运行，没有改动就跳过。命令含 {files} 占位时替换成这些文件；没有占位时把文件追加在命令末尾
 *   （多数栈 `pnpm test <文件>` 能按文件运行；不支持时会多跑一些，审查者只看这些文件的结果）。
 * - acceptance：只跑本 task 自己的：`-- <目录名>`；lean 共享目录时是 `-- suite/<文件>`（只含本 task 新增或修改的场景，没有就跳过）。
 */
export function reviewTestCommands(commands: Record<string, string>, accDir: string, hasAcceptance: boolean, sel: TestSelection = { testFiles: [] }): ReviewTestPlan {
  const run: ReviewTestPlan['run'] = [];
  const skipped: string[] = [];
  const test = commands['test']?.trim();
  if (test) {
    if (!sel.testFiles.length) skipped.push('单元测试：本 task 没有改动单元测试文件，全量单元测试在阶段门禁运行');
    else {
      const files = sel.testFiles.map(shq).join(' ');
      run.push({ name: 'test', shell: test.includes('{files}') ? test.replaceAll('{files}', files).trim() : `${test} ${files}` });
    }
  }
  const acc = commands['acceptance']?.trim();
  if (acc && hasAcceptance) {
    if (sel.accFiles === undefined) run.push({ name: 'acceptance', shell: `${acc} -- ${accDir}` });
    else if (!sel.accFiles.length) skipped.push(`验收测试：本 task 没有新增或修改 tests/acceptance/${accDir}/ 下的场景，全部验收测试在阶段门禁运行`);
    else run.push({ name: 'acceptance', shell: `${acc} -- ${sel.accFiles.join(' ')}` });
  }
  return { run, skipped };
}

/** 本 task 相对基线新增或修改的文件（已删除的不算）；基线算不出时返回空 */
export function changedFilesOf(t: Pick<TaskFile, 'base_sha' | 'worktree'>, integrationBranch?: string): string[] {
  const base = taskBaseOf(t, integrationBranch);
  if (!base || !t.worktree) return [];
  try {
    return git(t.worktree, ['diff', '--name-only', '--diff-filter=AM', '--no-renames', base, 'HEAD']).split('\n').filter(Boolean);
  } catch { return []; }
}

/** 为一个 impl / fix task 算出审查者要运行的测试（在任务 worktree 当前的 HEAD 上） */
export function reviewTestPlan(config: FlowConfig, t: TaskFile, integrationBranch?: string): ReviewTestPlan {
  const wt = t.worktree;
  if (!wt) return { run: [], skipped: [] };
  const accDir = acceptanceDirOf(t);
  const changed = changedFilesOf(t, integrationBranch);
  const testFiles = changed.filter((f) => !f.startsWith('tests/acceptance/') && matchesAny(f, TEST_GLOBS));
  return reviewTestCommands(config.commands, accDir, existsSync(path.join(wt, 'tests/acceptance', accDir)), { testFiles });
}

/** worker 自己写的验收测试的 AC 覆盖（程序扫描，不交给 LLM 数）。给审查者核对：缺失的 AC 是阻塞问题 */
export interface AcceptanceAudit {
  /** 本 task 的每条 AC（REQ-xxx.ACn）及带它编号的测试文件 */
  rows: { ac: string; files: string[] }[];
  missing: string[];
}

export function acceptanceAudit(t: TaskFile): AcceptanceAudit | null {
  if (!t.worktree || !writesOwnAcceptance(t)) return null;
  const acs = (t.ac ?? []).filter((a) => /^REQ-\d+\.AC\d+$/.test(a));
  if (!acs.length) return null;
  const files: { path: string; content: string }[] = [];
  try {
    for (const f of git(t.worktree, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', 'tests/acceptance/']).split('\0').filter(Boolean)) {
      try { files.push({ path: f, content: readFileSync(path.join(t.worktree, f), 'utf8') }); } catch { /* 已删除或读不了的文件不计 */ }
    }
  } catch { return null; }
  const cov = scanAcCoverage(files);
  const rows = acs.map((ac) => ({ ac, files: cov.get(ac) ?? [] }));
  return { rows, missing: rows.filter((r) => !r.files.length).map((r) => r.ac) };
}
