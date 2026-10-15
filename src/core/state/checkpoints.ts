// 自动检查点（第六轮 7.4）：运行中定时给任务工作区拍快照，存到 refs/pi-forge/checkpoints/<流程>/<任务>。
// 用临时索引（GIT_INDEX_FILE）做 add -A、write-tree、commit-tree：包含未跟踪的新文件，不动 agent 的索引与工作区，
// 也不和 agent 自己的 git 操作冲突。工作区被改坏或丢失时用 /forge checkpoint restore 取回；任务结束后删除。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, gitOk } from './git.ts';

export const DEFAULT_CHECKPOINT_MINUTES = 10;
export const checkpointRef = (flow: string, task: string) => `refs/pi-forge/checkpoints/${flow}/${task}`;

/** 给工作区拍快照；内容与上一个检查点相同时不新建。返回检查点提交（没有变化返回 null） */
export function createCheckpoint(root: string, worktree: string, flow: string, task: string, now = new Date()): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-ckpt-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    git(worktree, ['read-tree', 'HEAD'], { env });
    git(worktree, ['add', '-A', '--', '.'], { env });
    const tree = git(worktree, ['write-tree'], { env }).trim();
    const ref = checkpointRef(flow, task);
    const prev = gitOk(root, ['rev-parse', '--verify', '-q', ref]) ? git(root, ['rev-parse', ref]).trim() : null;
    if (prev && git(root, ['rev-parse', `${prev}^{tree}`]).trim() === tree) return null;
    if (!prev && git(worktree, ['rev-parse', 'HEAD^{tree}']).trim() === tree) return null;
    const head = git(worktree, ['rev-parse', 'HEAD']).trim();
    const sha = git(worktree, ['commit-tree', tree, '-p', head, '-m', `pi-forge 检查点 ${flow}/${task} ${now.toISOString()}`], { engineIdentity: true }).trim();
    git(root, ['update-ref', ref, sha]);
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Checkpoint { flow: string; task: string; sha: string; at: string }

export function listCheckpoints(root: string): Checkpoint[] {
  const out = git(root, ['for-each-ref', '--format=%(refname) %(objectname) %(committerdate:iso-strict)', 'refs/pi-forge/checkpoints/']).trim();
  return out ? out.split('\n').map((l) => {
    const [ref, sha, at] = l.split(' ') as [string, string, string];
    const [flow, task] = ref.slice('refs/pi-forge/checkpoints/'.length).split('/') as [string, string];
    return { flow, task, sha, at };
  }) : [];
}

export function dropCheckpoint(root: string, flow: string, task: string): void {
  if (gitOk(root, ['rev-parse', '--verify', '-q', checkpointRef(flow, task)])) git(root, ['update-ref', '-d', checkpointRef(flow, task)]);
}

/**
 * 把检查点的内容写回工作区（不动索引）：检查点里有的文件恢复成快照时的内容；之后新增的文件保留。
 * 返回恢复的文件数。
 */
export function restoreCheckpoint(root: string, worktree: string, flow: string, task: string): number {
  const ref = checkpointRef(flow, task);
  if (!gitOk(root, ['rev-parse', '--verify', '-q', ref])) throw new Error(`任务 ${task} 没有检查点`);
  const sha = git(root, ['rev-parse', ref]).trim();
  const files = git(worktree, ['diff', '--name-only', 'HEAD', sha]).split('\n').filter(Boolean);
  if (files.length) git(worktree, ['restore', `--source=${sha}`, '--worktree', '--', ...files]);
  return files.length;
}
