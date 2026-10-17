// 把集成分支合入主分支：S0（架构）批准时一次，流程最后一个闸门经用户确认后一次。
// 中止的流程不再合入，集成分支保留；S0 已经合入主分支的骨架不撤回。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import { dirtyFiles, git, gitOk } from '../state/git.ts';
import { worktreesRoot, removeWorktree } from '../workspace/worktree.ts';

export async function mergeToMain(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string> {
  const flow = store.readFlow(flowId);
  const main = config.raw.main_branch;
  const integ = flow.integration_branch;
  const msg = `pi-forge: 合入 ${flow.id} ${flow.title}`.slice(0, 200);
  if (gitOk(root, ['merge-base', '--is-ancestor', integ, main])) throw new Error(`${integ} 已经包含在 ${main} 中，无需合入`);
  const current = gitOk(root, ['symbolic-ref', '-q', 'HEAD']) ? git(root, ['symbolic-ref', '--short', 'HEAD']).trim() : null;

  let dir = root;
  let temp: string | null = null;
  if (current === main) {
    const dirty = [...dirtyFiles(root)];
    if (dirty.length) throw new Error(`主工作区有未提交的改动，无法合入 ${main}：${dirty.slice(0, 10).join('、')}。请先提交或暂存后再执行 /forge-approve。`);
  } else {
    temp = path.join(worktreesRoot(root), `${flowId}-release`);
    mkdirSync(path.dirname(temp), { recursive: true });
    removeWorktree(root, temp);
    try {
      git(root, ['worktree', 'add', '-q', temp, main]);
    } catch (e) {
      throw new Error(`无法检出 ${main} 进行合入（可能已在其他 worktree 中检出）：${(e as Error).message}`);
    }
    dir = temp;
  }
  try {
    try {
      git(dir, ['merge', '--no-ff', '--no-edit', '-m', msg, integ], { engineIdentity: true, allowFail: true });
    } catch {
      const conflicts = git(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      gitOk(dir, ['merge', '--abort']);
      throw new Error(`合入 ${main} 时冲突：${conflicts.join('、') || '（未知）'}。主分支在流程期间被修改过；请人工合并 ${integ} 后再执行 /forge-approve。`);
    }
    const sha = git(dir, ['rev-parse', 'HEAD']).trim();
    await store.recordEvent({ flow: flowId, actor: 'human', type: 'merge', evidence: sha, data: { from: integ, to: main } });
    return sha;
  } finally {
    if (temp) removeWorktree(root, temp);
  }
}

/**
 * S0 批准时：架构产出（连同 PRD、原型、骨架、契约、计划、rules/、commands.yaml）先合入主分支，再把集成分支移到合入后的提交，
 * 之后的阶段在它上面继续。这样主分支上就有 S0 写的规则与命令，用户也能提前看到骨架。
 */
export async function publishSkeleton(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string> {
  const integ = store.readFlow(flowId).integration_branch;
  const before = git(root, ['rev-parse', `refs/heads/${integ}`]).trim();
  const sha = await mergeToMain(root, store, config, flowId);
  git(root, ['update-ref', `refs/heads/${integ}`, sha, before]);
  return sha;
}
