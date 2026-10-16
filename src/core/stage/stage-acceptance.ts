// 实施阶段的验收编排：确定性门禁与覆盖率 → stage-qa → 修复 → 只确认 → 人工签收。
// 引擎在每次 pump 时调用 stageStep；它只根据持久化的状态（任务、evidence、事件）决定下一步，崩溃后重入结果相同。
// 阶段状态的用法：
// - active：本阶段任务在做；各类修复（.fx-n）也在 active 时进行；
// - awaiting_gate：门禁命令与覆盖率在跑，或 stage-qa（S1.qa）在跑（state-store 允许 qa 在 awaiting_gate 派发）；
// - needs_human：门禁修复、覆盖率补测、stage-qa 的轮数用尽，或问题找不到负责的 task；
// - awaiting_human：全部通过，等用户签收（最后一个阶段的签收即交付）。
import type { FlowConfig } from '../state/config.ts';
import type { TaskFile } from '../state/schemas.ts';
import type { StateStore } from '../state/state-store.ts';
import { isSettled } from '../state/state-machine.ts';
import { isOpenChange } from '../plan/change-request.ts';
import { headSha } from '../workspace/worktree.ts';
import { gateFailed, stageDef, type ImplementationChecks } from './gates.ts';
import { QA_INPUT, createQaTask, qaTasksOf, resolveQa } from './stage-qa.ts';
import { isStageLevelTask } from '../workspace/stage-worktree.ts';
import { SUGGESTIONS_PATH, readReviewEvidence, type ReviewInputFile } from './review-flow.ts';
import { git } from '../state/git.ts';
import type { StageRoundOutcome } from './stage-rounds.ts';

export interface AcceptanceDeps { root: string; store: StateStore; config: FlowConfig }

/**
 * 下一步：wait 什么都不做；gate 阶段已在 awaiting_gate，由引擎在后台跑 runImplementationChecks，结果交给 afterChecks；
 * changed 已建任务或转移了状态；done 阶段已通过且不需要人工，调用方进入下一阶段。
 */
export type StageStep = 'wait' | 'gate' | 'changed' | 'done';

const GATE_PASSED = 'gate_checks_passed';

export const qaEnabled = (config: FlowConfig) => config.raw.implementation_gate?.qa !== false;

/** 本阶段最近一次确定性检查通过时的集成分支 HEAD（阶段被打回后作废）；纯函数 */
export function gatePassedHead(events: readonly { type: string; flow: string | null; data?: Record<string, unknown> | undefined }[], flowId: string, stage: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.flow !== flowId || e.data?.['stage'] !== stage) continue;
    if (e.type === 'stage_reopened') return null;
    if (e.type === 'note' && e.data?.['kind'] === GATE_PASSED) return String(e.data['head']);
  }
  return null;
}

/**
 * 两个提交之间是否只有程序记录的文档变化（审查建议、覆盖率矩阵）：这些提交不改代码，
 * 不应让已经通过的门禁与 stage-qa 作废（否则"通过 → 记录建议 → 重新验收"会一直循环）。
 */
export function sameWork(root: string, a: string | null, b: string): boolean {
  if (a === b) return true;
  if (!a) return false;
  try {
    return git(root, ['diff', '--name-only', a, b]).split('\n').filter(Boolean)
      .every((f) => f === SUGGESTIONS_PATH || f.startsWith('docs/qa/'));
  } catch { return false; }
}

/** 本阶段除阶段级 task（S1.qa）外是否都已结束；纯函数 */
export const stageWorkSettled = (tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'stage' | 'status'>[], stage: string) =>
  tasks.filter((t) => t.stage === stage && !isStageLevelTask(t)).every(isSettled);

async function toNeedsHuman(store: StateStore, flowId: string, reason: string): Promise<void> {
  const flow = store.readFlow(flowId);
  if (flow.stage_status === 'active') await store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  await store.transitionStage(flowId, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'gate', reason: reason.slice(0, 4000) });
}

async function backToActive(store: StateStore, flowId: string, reason: string): Promise<void> {
  await store.transitionStage(flowId, { to: 'active', trigger: 'gate_failed', actor: 'gate', reason: reason.slice(0, 4000) });
}

/** 全部通过：需要人工 → awaiting_human（签收）；否则 → done（由调用方进入下一阶段）。返回是否已 done */
async function finalize(d: AcceptanceDeps, flowId: string, head: string): Promise<boolean> {
  const flow = d.store.readFlow(flowId);
  const def = stageDef(d.config, flow.stage);
  // S0 与最后一个阶段批准时要合入主分支，一律人工
  const needsHuman = !!def.gate.human || flow.stage === 'S0' || flow.stage === flow.stages.at(-1);
  await d.store.transitionStage(flowId, { to: needsHuman ? 'awaiting_human' : 'done', trigger: 'gate_passed', actor: 'gate', needs_human: needsHuman, data: { head } });
  return !needsHuman;
}

const roundNote = (o: StageRoundOutcome, what: string) =>
  o.kind === 'fix' ? `${what}发现必须修改的问题，已生成修复任务：${o.tasks.join('、')}${o.unowned.length ? `（找不到负责 task 的文件：${o.unowned.join('、')}）` : ''}` : '';

/**
 * 阶段 active 时：本阶段的工作都结束后提交门禁。返回 gate 时调用方把阶段转 awaiting_gate 后跑检查（已转好）。
 * 阶段 awaiting_gate 且没有检查在跑时：看 stage-qa 的结论。
 */
export async function stageStep(d: AcceptanceDeps, flowId: string, opts: { force?: boolean; gateFailedWithoutChange: () => boolean }): Promise<StageStep> {
  const { store } = d;
  const flow = store.readFlow(flowId);
  const stage = flow.stage;
  if (flow.stage_status === 'needs_human') {
    if (!opts.force) return 'wait';
    await store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'gate_rerun', actor: 'human' });
    return 'gate';
  }
  if (flow.stage_status === 'active') {
    const tasks = store.listTasks(flowId);
    if (!stageWorkSettled(tasks, stage)) return 'wait';
    // 变更请求还没结束（起草中、等待批准、被打回）：批准后可能在本阶段新增 task，先不提交门禁
    if (store.listChanges(flowId).some(isOpenChange)) return 'wait';
    if (!opts.force && opts.gateFailedWithoutChange()) return 'wait';
    await store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    return 'gate';
  }
  if (flow.stage_status !== 'awaiting_gate') return 'wait';
  // awaiting_gate 且没有检查在跑：stage-qa 在跑或已结束；崩溃后没有 qa 的，重跑检查
  if (!qaEnabled(d.config)) return 'gate';
  const r = await resolveQa(d.root, store, d.config, flowId, stage);
  switch (r.kind) {
    case 'running': return 'wait';
    case 'none': case 'fix-done': return 'gate';
    case 'fix': await backToActive(store, flowId, roundNote(r, 'stage-qa ')); return 'changed';
    case 'blocked': case 'exhausted': await toNeedsHuman(store, flowId, `stage-qa：${r.reason}`); return 'changed';
    case 'pass': {
      const head = headSha(d.root, flow.integration_branch);
      if (!sameWork(d.root, gatePassedHead(store.readEvents(), flowId, stage), head) || !sameWork(d.root, qaHead(store, flowId, stage), head)) return 'gate';
      return await finalize(d, flowId, head) ? 'done' : 'changed';
    }
  }
}

/** 最新一轮 stage-qa 开始时的集成分支 HEAD */
function qaHead(store: StateStore, flowId: string, stage: string): string | null {
  const latest = qaTasksOf(store.listTasks(flowId), stage).at(-1);
  return latest ? readReviewEvidence<ReviewInputFile>(store, flowId, latest.id, QA_INPUT)?.head ?? null : null;
}

/**
 * 确定性检查结束后（阶段在 awaiting_gate）：失败 → 按 task 建修复（.fx-n），回 active；轮数用尽或无法归属 → needs_human；
 * 通过 → 记下通过时的 HEAD；需要 stage-qa 的建一轮（或只确认的一轮），否则签收。返回阶段是否已 done（调用方进入下一阶段）。
 */
export async function afterChecks(d: AcceptanceDeps, flowId: string, g: ImplementationChecks): Promise<{ done: boolean; note?: string }> {
  const { store } = d;
  const flow = store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_gate') return { done: false };
  const reason = g.reasons.join('\n');
  if (g.failed) {
    const r = await gateFailed(d, flowId, g.failed);
    if (r.reason) { await toNeedsHuman(store, flowId, `${r.reason}\n${reason}`); return { done: false, note: r.reason }; }
    await backToActive(store, flowId, `${reason}\n已生成修复任务：${r.tasks.join('、')}`);
    return { done: false };
  }
  if (!g.passed) { await toNeedsHuman(store, flowId, reason || '门禁未通过'); return { done: false, note: reason }; }
  await store.recordEvent({ flow: flowId, actor: 'gate', type: 'note', reason: `阶段 ${g.stage} 门禁与覆盖率通过`, data: { kind: GATE_PASSED, stage: g.stage, head: g.head } });
  if (!qaEnabled(d.config)) return { done: await finalize(d, flowId, g.head) };
  const r = await resolveQa(d.root, store, d.config, flowId, g.stage);
  // 轮数用尽后代码又变了（用户打回后变更请求的 task 合入）：再开一轮只确认的，不按改动之前的结论交给用户
  //（stock run-03：S2 修完后门禁两次都按旧的 stage-qa 结论判用尽，修复没人复验）
  const stale = r.kind === 'exhausted' && !sameWork(d.root, qaHead(store, flowId, g.stage), g.head);
  if (r.kind === 'blocked' || (r.kind === 'exhausted' && !stale)) { await toNeedsHuman(store, flowId, `stage-qa：${r.reason}`); return { done: false }; }
  if (r.kind === 'running') return { done: false };
  if (r.kind === 'fix') { await backToActive(store, flowId, roundNote(r, 'stage-qa ')); return { done: false }; }
  if (r.kind === 'pass' && sameWork(d.root, qaHead(store, flowId, g.stage), g.head)) return { done: await finalize(d, flowId, g.head) };
  const qa = await createQaTask(d.root, store, d.config, flowId, g.stage, g.head);
  await store.transitionTask(flowId, qa.id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  return { done: false };
}
