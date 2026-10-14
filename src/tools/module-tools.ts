// 来源：pi-flow src/tools/module-tools.ts @ 31f3f15（M1 改编）
// forge_sync 与引擎共用同步逻辑；token 校验仅属于工具入口。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import type { TaskFile } from '../core/state/schemas.ts';
import type { StateStore } from '../core/state/state-store.ts';
import { git, gitOk } from '../core/state/git.ts';
import { snapshot } from '../core/workspace/worktree.ts';
import { appendMergeAllowed, resolveConflictsStructured } from '../core/engine/merge-queue.ts';
import { FlowToolError, checkRunOf, type ToolContext, type ToolResult } from './tool-common.ts';

export const SyncParams = Type.Object({}, { additionalProperties: false });
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;
export interface TaskSyncResult { text: string; conflicts: string[] }

/** 合入集成分支；冲突标记保留，解决后再次调用完成提交。 */
export async function syncTaskInputs(store: StateStore, flowId: string, t: TaskFile, actor = 'engine'): Promise<TaskSyncResult> {
  if (!t.worktree || !t.base_sha) throw new FlowToolError('任务没有工作区，无法同步。');
  // merge-fix 的基线包含冲突标记，由合并队列准备，不能在这里再次合入。
  if (t.kind === 'merge-fix') return { text: '冲突修复工作区由合并队列准备。', conflicts: [] };
  const wt = t.worktree;
  const integ = store.readFlow(flowId).integration_branch;
  if (gitOk(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
    const files = [...new Set([...git(wt, ['diff', '--name-only', 'HEAD']).split('\n'), ...git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n')].filter(Boolean))];
    const conflicts = files.filter((f) => existsSync(path.join(wt, f)) && CONFLICT_MARKER.test(readFileSync(path.join(wt, f), 'utf8')));
    if (conflicts.length) return { text: `这些文件还有冲突标记：${conflicts.join('、')}。解决后再调用 forge_sync。`, conflicts };
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '--no-edit', '--no-verify'], { engineIdentity: true });
  } else {
    snapshot(wt, `[${flowId}/${t.id}] 同步前的进度`);
    const head = git(wt, ['rev-parse', integ]).trim();
    if (gitOk(wt, ['merge-base', '--is-ancestor', head, 'HEAD'])) return { text: '工作区已经包含集成分支的最新代码，不需要同步。', conflicts: [] };
    try { git(wt, ['merge', '--no-edit', '--no-ff', '--no-verify', head], { engineIdentity: true, allowFail: true }); }
    catch {
      const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      if (!conflicts.length) { gitOk(wt, ['merge', '--abort']); throw new FlowToolError('合并失败但没有冲突文件，已放弃这次同步。'); }
      // 契约文件与只追加的普通文件先做结构化三方合并（merge 时 stage 2 是任务、stage 3 是集成分支）
      if (!resolveConflictsStructured(wt, conflicts, { integration: 3, task: 2 }, appendMergeAllowed(t))) {
        return { text: `同步时有冲突，冲突标记留在：${conflicts.join('、')}。解决后再调用 forge_sync。`, conflicts };
      }
      git(wt, ['commit', '-q', '--no-edit', '--no-verify'], { engineIdentity: true });
      await store.recordEvent({ flow: flowId, task: t.id, actor, type: 'note', reason: `冲突文件已结构化合并：${conflicts.join('、')}`, data: { files: conflicts } });
    }
  }
  const base = git(wt, ['merge-base', 'HEAD', integ]).trim();
  await store.updateTask(flowId, t.id, { base_sha: base }, { actor, type: 'note', reason: `同步集成分支（${base.slice(0, 8)}）` });
  return { text: `同步完成：已合入集成分支 ${base.slice(0, 8)}。跑一下相关测试，确认改动一起能工作。`, conflicts: [] };
}

export async function flowSync(ctx: ToolContext): Promise<ToolResult> {
  const t = checkRunOf(ctx);
  if (t.kind === 'merge-fix') throw new FlowToolError('解决合并冲突的任务不需要同步。');
  const r = await syncTaskInputs(ctx.store, ctx.env.flow, t, `run:${ctx.env.run}`);
  return { text: r.text, details: { conflicts: r.conflicts } };
}
