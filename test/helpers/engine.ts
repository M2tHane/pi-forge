// 来源：pi-flow test/helpers/engine.ts @ 31f3f15
// 引擎测试夹具：fake-subagent 按角色与第几次派发选择脚本。
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Engine, type EngineDeps } from '../../src/core/engine/dispatcher.ts';
import type { MergeHooks, MergeResult } from '../../src/core/engine/merge-queue.ts';
import type { RoleSettingsFile } from '../../src/core/state/schemas.ts';
import { FakeLauncher, type FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import type { Project } from './project.ts';
const PACKAGE_ROOT = new URL('../..', import.meta.url).pathname;

/** 子进程只加载包内的七个角色定义。 */
export const AGENTS = path.join(PACKAGE_ROOT, 'agents');
export const ALL_FAKE: RoleSettingsFile = { version: 1, roles: Object.fromEntries(
  ['orchestrator', 'architect', 'worker', 'reviewer', 'stage-qa'].map((r) => [r, { model: 'fake/model', thinking: 'low' as const }])) };

export type RoleScript = (role: string, nth: number, a: FakeAgent) => Promise<void>;

export function makeEngine(p: Project, scripts: RoleScript, settings = ALL_FAKE, mergeHooks?: MergeHooks, extra: Partial<EngineDeps> = {}) {
  // impl / fix 一律审查。脚本里没有出现 reviewer 的（按任务编号分支的老脚本）不会处理审查者，默认审查者直接通过；
  // 脚本处理了 reviewer 但没有提交结论的（forge_review_*、forge_block）同样补一次通过
  const handlesReviewer = /forge_review_|'reviewer'|"reviewer"/.test(scripts.toString());
  const launcher = new FakeLauncher(p.store, p.config, (spec, nth) => async (a) => {
    const role = spec.env['PI_FORGE_ROLE']!;
    if (role === 'reviewer' && !handlesReviewer) { await a.call('forge_review_report', { verdict: 'pass', issues: [] }); return; }
    let concluded = false;
    const watched: FakeAgent = { ...a, call: async (tool, input) => { if (/^forge_review_|^forge_block$/.test(tool)) concluded = true; return a.call(tool, input); } };
    await scripts(role, nth, watched);
    if (role === 'reviewer' && !concluded) await a.call('forge_review_report', { verdict: 'pass', issues: [] });
  });
  const errors: unknown[] = [];
  const merges: MergeResult[] = [];
  const engine = new Engine({
    root: p.dir, store: p.store, config: p.config, roleSettings: () => settings, launcher,
    packageAgentsDir: AGENTS, subagentExtension: '/dev/null/subagent.ts',
    onError: (e) => errors.push(e), onMerge: (r) => merges.push(r), ...(mergeHooks ? { mergeHooks } : {}), ...extra,
  });
  return { engine, launcher, errors, merges, store: p.store };
}

/** 模拟他人直接向某分支提交（不切换主工作区） */
export function commitToBranch(root: string, branch: string, files: Record<string, string>, message: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-ext-'));
  rmSync(dir, { recursive: true });
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  git(root, 'worktree', 'add', '-q', dir, branch);
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=other', '-c', 'user.email=o@x', 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  } finally {
    git(root, 'worktree', 'remove', '--force', dir);
  }
}
