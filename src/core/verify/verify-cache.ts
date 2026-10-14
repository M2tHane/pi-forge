// 同一棵代码树只验证一次：预检、合并验证、门禁通过的命令记成事件（代码树 SHA + 命令名 + 命令内容的哈希 + evidence），
// 之后在同一棵树上、命令内容没变的同名命令直接沿用，并写一份沿用记录指向被沿用的 evidence（状态可审计）。
// 只记通过的命令；工作区有未提交改动时不记也不沿用。
import { createHash } from 'node:crypto';
import { git, gitOk } from '../state/git.ts';
import type { StateStore } from '../state/state-store.ts';

export const VERIFIED = 'verified';

export interface VerifiedRun { name: string; hash: string; evidence: string }
export interface PlannedCommand { name: string; shell: string }

export const commandHash = (shell: string) => createHash('sha256').update(shell.trim()).digest('hex').slice(0, 16);

/** 工作区 HEAD 的代码树；有未提交的改动（含未被忽略的新文件）时为 null，结果不可沿用 */
export function cleanTreeOf(dir: string): string | null {
  try {
    if (git(dir, ['status', '--porcelain']).trim()) return null;
    return git(dir, ['rev-parse', 'HEAD^{tree}']).trim();
  } catch { return null; }
}

/** 提交对应的代码树 */
export function treeOfCommit(root: string, sha: string): string | null {
  return gitOk(root, ['rev-parse', '--verify', '-q', `${sha}^{tree}`]) ? git(root, ['rev-parse', `${sha}^{tree}`]).trim() : null;
}

/** 记下在 tree 上通过的命令（runs 为空时不记） */
export async function recordVerified(store: StateStore, flowId: string, tree: string | null, runs: readonly { name: string; shell: string; evidence: string }[],
  where: { task?: string; stage?: string; actor: string }): Promise<void> {
  if (!tree || !runs.length) return;
  await store.recordEvent({ flow: flowId, ...(where.task ? { task: where.task } : {}), actor: where.actor, type: 'note', reason: `代码树 ${tree.slice(0, 8)} 上通过：${runs.map((r) => r.name).join('、')}`,
    data: { kind: VERIFIED, tree, ...(where.stage ? { stage: where.stage } : {}), runs: runs.map((r) => ({ name: r.name, hash: commandHash(r.shell), evidence: r.evidence })) } });
}

/** 纯函数：plan 中哪些命令在同一棵树上、以相同内容通过过；返回 命令名 → 被沿用的 evidence（取最近一次） */
export function reusableRuns(events: readonly { type: string; flow: string | null; data?: Record<string, unknown> | undefined }[], flowId: string, tree: string | null, plan: readonly PlannedCommand[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!tree) return out;
  const want = new Map(plan.map((c) => [c.name, commandHash(c.shell)]));
  for (let i = events.length - 1; i >= 0 && out.size < want.size; i--) {
    const e = events[i]!;
    if (e.flow !== flowId || e.type !== 'note' || e.data?.['kind'] !== VERIFIED || e.data['tree'] !== tree) continue;
    for (const r of (e.data['runs'] as VerifiedRun[] | undefined) ?? []) {
      if (want.get(r.name) === r.hash && !out.has(r.name)) out.set(r.name, r.evidence);
    }
  }
  return out;
}

/** 沿用记录的正文 */
export function reuseText(tree: string, reused: ReadonlyMap<string, string>): string {
  return [`代码树：${tree}`, '以下命令在同一棵代码树上、以相同的命令内容已经通过，本次沿用结果、不再运行：', ...[...reused].map(([name, ev]) => `- ${name}：沿用 ${ev}`)].join('\n');
}
