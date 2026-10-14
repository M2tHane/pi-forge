// 来源：pi-flow src/core/stages.ts @ 31f3f15（M1 改编）
// 流程与阶段控制；P0/P1 的产物与计划在 M2/M3 接入。
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import type { FlowFile } from '../state/schemas.ts';
import { git, gitOk } from '../state/git.ts';
import { ensureIntegrationBranch } from '../workspace/worktree.ts';
import { mergeToMain } from './release.ts';
import { materializePlan, P1_STAGE, isArchitectStage } from '../plan/plan-flow.ts';
import { deliveryReport } from './signoff.ts';

export interface StageDeps { root: string; store: StateStore; config: FlowConfig }

export async function startFlow(d: StageDeps, description: string): Promise<FlowFile> {
  const mode = 'build';
  const def = d.config.raw.modes.build;
  if (!def) throw new Error('workflow.yaml 没有定义 modes.build');
  const main = d.config.raw.main_branch;
  if (!gitOk(d.root, ['show-ref', '--verify', '--quiet', `refs/heads/${main}`])) throw new Error(`主分支 ${main} 不存在，请检查 workflow.yaml 的 main_branch`);
  const base = git(d.root, ['rev-parse', main]).trim();
  const flow = await d.store.createFlow({ mode, title: description, stages: def.stages.map((s) => s.id), base_sha: base, actor: 'human' });
  ensureIntegrationBranch(d.root, flow.integration_branch, base);
  return flow;
}

/** 最后阶段先以 --no-ff 合入主分支，成功后才批准。 */
export async function approveStage(d: StageDeps, flowId: string, note?: string): Promise<string> {
  let flow = d.store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_human') throw new Error(`阶段 ${flow.stage} 当前是 ${flow.stage_status}，没有等待批准的闸门。`);
  const lines: string[] = [];
  // P1：先落地计划（追加 S 阶段），P1 才不再是最后一个阶段
  if (flow.stage === P1_STAGE) {
    lines.push(...await materializePlan(d.root, d.store, d.config, flowId));
    flow = d.store.readFlow(flowId);
  }
  if (flow.stage === flow.stages.at(-1)) {
    // 先把交付汇报存为阶段证据（失败不阻止合入），再合入
    try {
      await d.store.saveStageEvidence(flowId, flow.stage, 'delivery.md', deliveryReport(d.root, d.store, d.config, flowId), 'delivery');
      lines.push(`交付汇报已保存为阶段证据（delivery.md）；随时可用 /forge report 查看。`);
    } catch (e) {
      lines.push(`提示：交付汇报未能保存（${(e as Error).message.split('\n')[0]}），不影响合入。`);
    }
    const sha = await mergeToMain(d.root, d.store, d.config, flowId);
    lines.push(`已把 ${flow.integration_branch} 合入 ${d.config.raw.main_branch}（${sha.slice(0, 8)}）。`);
  }
  await d.store.transitionStage(flowId, { to: 'done', trigger: 'approve', actor: 'human', ...(note ? { note } : {}) });
  const next = await d.store.advanceStage(flowId, 'human');
  lines.push(`已批准阶段 ${flow.stage}。`, next.stage !== flow.stage ? `进入阶段 ${next.stage}。${next.stage === P1_STAGE ? '程序将派 architect 起草契约与计划。' : ''}` : `流程 ${flow.id} 已完成。`);
  return lines.join('\n');
}

export async function rejectStage(d: StageDeps, flowId: string, feedback: string): Promise<string> {
  const flow = d.store.readFlow(flowId);
  if (!['awaiting_human', 'needs_human'].includes(flow.stage_status)) throw new Error(`阶段 ${flow.stage} 当前是 ${flow.stage_status}，没有等待批准的闸门。`);
  if (!feedback.trim()) throw new Error('打回必须写明意见：/forge-reject "<意见>"');
  await d.store.transitionStage(flowId, { to: 'active', trigger: 'reject', actor: 'human', reason: feedback });
  if (isArchitectStage(flow.stage)) {
    await d.store.setPlanRework(flowId, `用户打回：${feedback}`, 'human');
    return `已打回阶段 ${flow.stage}，程序将派 architect 按意见返工。`;
  }
  return `已打回阶段 ${flow.stage}，意见已记录。`;
}

export async function unblockTask(d: StageDeps, flowId: string, taskId: string, answer?: string, reset = false): Promise<string> {
  const t = d.store.readTask(flowId, taskId);
  if (t.status !== 'blocked') throw new Error(`任务 ${taskId} 当前是 ${t.status}，不是 blocked。`);
  if (answer?.trim()) await d.store.appendHandoff(flowId, taskId, `用户回答：\n${answer.trim()}`, 'human');
  const next = await d.store.transitionTask(flowId, taskId, { to: t.worktree || t.branch ? 'in_progress' : 'ready', trigger: 'unblock', actor: 'human', facts: { reset } });
  return `已解除 ${taskId} 的阻塞，任务回到 ${next.status}${reset ? '（对应计数清零）' : '（保留计数）'}。`;
}
