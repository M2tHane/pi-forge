// 来源：pi-flow src/core/stages.ts @ 31f3f15（M1 改编）
// 流程与阶段控制；P0/P1 的产物与计划在 M2/M3 接入。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { FlowFile } from './schemas.ts';
import { git, gitOk } from './git.ts';
import { ensureIntegrationBranch } from './worktree.ts';
import { mergeToMain } from './release.ts';

export interface StageDeps { root: string; store: StateStore; config: FlowConfig }

export function nextTaskId(store: StateStore, flowId: string, offset = 0): string {
  const nums = store.listTasks(flowId).map((t) => Number(t.id.match(/^T-(\d+)/)?.[1] ?? 0));
  return `T-${String(Math.max(0, ...nums) + 1 + offset).padStart(3, '0')}`;
}

export async function startFlow(d: StageDeps, mode: 'build' | 'feature', description: string): Promise<FlowFile> {
  const def = d.config.raw.modes[mode];
  if (!def) throw new Error(`workflow.yaml 没有定义 modes.${mode}`);
  const main = d.config.raw.main_branch;
  if (!gitOk(d.root, ['show-ref', '--verify', '--quiet', `refs/heads/${main}`])) throw new Error(`主分支 ${main} 不存在，请检查 workflow.yaml 的 main_branch`);
  const base = git(d.root, ['rev-parse', main]).trim();
  const flow = await d.store.createFlow({ mode, title: description, stages: def.stages.map((s) => s.id), base_sha: base, actor: 'human' });
  ensureIntegrationBranch(d.root, flow.integration_branch, base);
  return flow;
}

/** 最后阶段先以 --no-ff 合入主分支，成功后才批准。 */
export async function approveStage(d: StageDeps, flowId: string, note?: string): Promise<string> {
  const flow = d.store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_human') throw new Error(`阶段 ${flow.stage} 当前是 ${flow.stage_status}，没有等待批准的闸门。`);
  const lines: string[] = [];
  if (flow.stage === flow.stages.at(-1)) {
    const sha = await mergeToMain(d.root, d.store, d.config, flowId);
    lines.push(`已把 ${flow.integration_branch} 合入 ${d.config.raw.main_branch}（${sha.slice(0, 8)}）。`);
  }
  await d.store.transitionStage(flowId, { to: 'done', trigger: 'approve', actor: 'human', ...(note ? { note } : {}) });
  const next = await d.store.advanceStage(flowId, 'human');
  lines.push(`已批准阶段 ${flow.stage}。`, next.stage !== flow.stage ? `进入阶段 ${next.stage}。` : `流程 ${flow.id} 已完成。`);
  return lines.join('\n');
}

export async function rejectStage(d: StageDeps, flowId: string, feedback: string): Promise<string> {
  const flow = d.store.readFlow(flowId);
  if (!['awaiting_human', 'needs_human'].includes(flow.stage_status)) throw new Error(`阶段 ${flow.stage} 当前是 ${flow.stage_status}，没有等待批准的闸门。`);
  if (!feedback.trim()) throw new Error('打回必须写明意见：/forge-reject "<意见>"');
  await d.store.transitionStage(flowId, { to: 'active', trigger: 'reject', actor: 'human', reason: feedback });
  return `已打回阶段 ${flow.stage}，意见已记录。`;
}

export async function unblockTask(d: StageDeps, flowId: string, taskId: string, answer?: string, reset = false): Promise<string> {
  const t = d.store.readTask(flowId, taskId);
  if (t.status !== 'blocked') throw new Error(`任务 ${taskId} 当前是 ${t.status}，不是 blocked。`);
  if (answer?.trim()) await d.store.appendHandoff(flowId, taskId, `用户回答：\n${answer.trim()}`, 'human');
  const next = await d.store.transitionTask(flowId, taskId, { to: t.worktree || t.branch ? 'in_progress' : 'ready', trigger: 'unblock', actor: 'human', facts: { reset } });
  return `已解除 ${taskId} 的阻塞，任务回到 ${next.status}${reset ? '（对应计数清零）' : '（保留计数）'}。`;
}
