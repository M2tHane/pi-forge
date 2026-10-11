// 来源：pi-flow src/core/context-injector.ts @ 31f3f15（M1 改编）
// 每轮注入程序状态与主会话可执行的下一步；主工作区改动检测保留。
import { approvalTargets, specStatus } from '../spec/spec-flow.ts';
import { P1_STAGE, planApprovalSummary } from '../plan/plan-flow.ts';
import { ADOPT_STAGE, adoptScope } from '../ops/adopt.ts';
import type { StateStore } from '../state/state-store.ts';
import type { FlowConfig } from '../state/config.ts';
import { budgetState } from './cost-control.ts';
import { git } from '../state/git.ts';
import type { ModelPause, TaskFile } from '../state/schemas.ts';
import { REVIEW_GUIDE, awaitingReview } from './run-budget.ts';

export interface NextStep { summary: string; next: string; tool: 'forge_spec' | 'forge_wait' | 'forge_resolve_timeout' | 'forge_resolve_scope' | 'none'; task?: string }
export type PausedOf = (flowId: string, t: TaskFile) => ModelPause | null;
export function nextStep(store: StateStore, _maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): NextStep {
  const flowId = store.readState().active_flow;
  if (!flowId) return { summary: '没有进行中的流程。', next: '请用户执行 /forge-build 开始。', tool: 'none' };
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const summary = `流程 ${flow.id}「${flow.title}」阶段 ${flow.stage}（${flow.stage_status}）；任务 ${tasks.length} 个，完成 ${tasks.filter((t) => t.status === 'done').length} 个。`;
  const amendments = store.listAmends(flowId);
  const pending = amendments.find((a) => a.status === 'proposed');
  if (pending) return { summary, next: `${specStatus(store, flowId)}\n等待用户批准或打回；对象：${approvalTargets(store, flowId).map((a) => a.object).join('、')}。用户使用 /forge-approve <对象> 或 /forge-reject <对象> "<意见>"。`, tool: 'none' };
  if (flow.stage === 'P0') {
    if (flow.stage_status === 'awaiting_gate') return { summary, next: '规格已提交，程序正在重读集成分支并执行 spec-lint，等待闸门结果。', tool: 'none' };
    if (flow.stage_status === 'awaiting_human') return { summary, next: `${flow.mode === 'feature' ? '增量规格已提交，spec-lint（基线 + 全部 feature）通过。' : '规格已提交，spec-lint 通过。'}向用户概述规格，等待用户 /forge-approve stage:P0 或 /forge-reject stage:P0 "<意见>"。${flow.spec?.permission_changes?.length ? `\n必须向用户单独列出权限变更：\n${flow.spec.permission_changes.join('\n')}` : ''}`, tool: 'none' };
    const read = flow.intake?.files.length ? '用 forge_read 阅读集成分支 docs/spec/inputs/ 的需求文档与可选原型（只就有疑问的地方向用户提问）' : '用户没有提供需求文档：按技能 grilling 详细地向用户了解需求';
    if (flow.mode === 'feature') return { summary, next: `${read}，并阅读已有的基线规格（docs/spec/*.md、docs/spec/features/）和现有契约（docs/contracts/），和用户讨论本次功能；确认后用 forge_spec 的 feature_name + feature 提交增量规格（不要重写基线四份文件；基线不存在时才同时提交四份）。feature 含三节：## 需求（REQ 编号接着已有的最大编号；改动已有需求写 ### REQ-012（修订）…，删除写 ### REQ-012（删除））、## 页面（新增页面，或对已有页面整页重写）、## 权限（只写新增或修改的矩阵行，修改的行会在批准页单独列出）。${flow.spec?.feedback ? `\n规格被打回或检查失败，意见：${flow.spec.feedback}` : ''}`, tool: 'forge_spec' };
    return { summary, next: `${read}；和用户确认后用 forge_spec 提交四份规格。${flow.spec?.feedback ? `\n规格被打回或检查失败，意见：${flow.spec.feedback}` : ''}`, tool: 'forge_spec' };
  }
  if (flow.stage === ADOPT_STAGE) {
    if (flow.stage_status === 'awaiting_human') return { summary, next: `纳管的契约已通过程序检查。用 forge_read 阅读 docs/contracts/ 与 docs/arch/overview.md（尤其"待确认"一节），向用户概述 architect 从现有代码整理出的边界契约，然后等待用户 /forge-approve stage:ADOPT 或 /forge-reject stage:ADOPT "<意见>"。批准后集成分支合入主分支，之后可以 /forge-build --feature。`, tool: 'none' };
    if (flow.stage_status === 'awaiting_gate') return { summary, next: '程序正在检查集成分支上的契约，等待闸门结果。', tool: 'none' };
    const stuck = tasks.filter((t) => t.stage === ADOPT_STAGE && t.status === 'blocked');
    if (stuck.length) return { summary, next: `向用户报告阻塞：${stuck.map((t) => `${t.id}（${t.blocked_reason ?? ''}）`).join('；')}；请其 /forge unblock <任务>，或 /forge-reject stage:ADOPT "<意见>" 让 architect 重做。`, tool: 'none' };
    return { summary, next: `architect 正在从现有代码整理契约（范围：${adoptScope(flow.title)}），调用 forge_wait 等待。${flow.plan_rework ? `\n返工原因：${flow.plan_rework.reason}` : ''}`, tool: 'forge_wait' };
  }
  if (flow.stage === P1_STAGE) {
    if (flow.stage_status === 'awaiting_human') return { summary, next: `契约与计划已通过程序检查。用 forge_read 阅读 docs/plan/plan.yaml、docs/arch/overview.md 与 docs/contracts/，向用户概述：阶段与每个阶段交付什么、task 数与并行度、报告里的提醒；assumptions 与 extras 逐条列给用户确认。然后等待用户 /forge-approve stage:P1 或 /forge-reject stage:P1 "<意见>"。\n${planApprovalSummary(store, flowId)}`, tool: 'none' };
    if (flow.stage_status === 'awaiting_gate') return { summary, next: '程序正在检查集成分支上的契约与计划，等待闸门结果。', tool: 'none' };
    const stuck = tasks.filter((t) => t.stage === P1_STAGE && t.status === 'blocked');
    if (flow.stage_status === 'active' && stuck.length) return { summary, next: `向用户报告阻塞：${stuck.map((t) => `${t.id}（${t.blocked_reason ?? ''}）`).join('；')}；请其 /forge unblock <任务>，或 /forge-reject stage:P1 "<意见>" 让 architect 重做。`, tool: 'none' };
    if (flow.stage_status === 'active') return { summary, next: `architect 正在起草契约与计划，调用 forge_wait 等待。${flow.plan_rework ? `\n返工原因：${flow.plan_rework.reason}` : ''}`, tool: 'forge_wait' };
  }
  if (flow.stage_status === 'awaiting_human') return { summary, next: `阶段 ${flow.stage} 等待用户签收，请其 /forge-approve 或 /forge-reject "<意见>"。`, tool: 'none' };
  if (flow.stage_status === 'needs_human') return { summary, next: `阶段 ${flow.stage} 门禁用尽，请用户处理后 /forge gate 重跑，或 /forge-reject "<意见>"。`, tool: 'none' };
  const scope = tasks.find((t) => t.scope_request);
  if (scope) return { summary, next: `${scope.id} 申请 ${scope.scope_request!.paths.join('、')}：${scope.scope_request!.reason}。看过范围后用 forge_resolve_scope 决定。`, tool: 'forge_resolve_scope', task: scope.id };
  const review = tasks.find(awaitingReview);
  if (review) return { summary, next: `${review.id} 运行超时，调用 forge_resolve_timeout 复核。${REVIEW_GUIDE}`, tool: 'forge_resolve_timeout', task: review.id };
  if (config && budgetState(store, config, flow)?.exceeded) return { summary, next: '本流程的预算已用完，请用户用 /forge budget 提高预算。', tool: 'none' };
  const waiting = tasks.filter((t) => paused?.(flowId, t));
  if (waiting.length && !activeRunCount) return { summary, next: `${waiting.map((t) => `${paused?.(flowId, t)?.model} 暂停中：${t.id}`).join('；')}；请用户 /forge models resume 或 /forge-config 换模型。`, tool: 'none' };
  if (tasks.some((t) => t.lease || ['awaiting_inputs', 'checking', 'in_review', 'disputed', 'queued_merge', 'merging'].includes(t.status)) || activeRunCount) return { summary, next: '任务由程序推进，调用 forge_wait 等待结果。', tool: 'forge_wait' };
  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) return { summary, next: `向用户报告阻塞：${blocked.map((t) => `${t.id}（${t.blocked_reason ?? ''}）`).join('；')}；请其 /forge unblock <任务>。`, tool: 'none' };
  if (tasks.some((t) => ['pending', 'ready'].includes(t.status))) return { summary, next: '任务由程序自动派发；关闭自动派发时请用户执行 /forge next。', tool: 'forge_wait' };
  return { summary, next: '等待程序阶段检查或用户指示。', tool: 'none' };
}
export function turnContext(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): string {
  const s = nextStep(store, maxParallel, activeRunCount, config, paused);
  const id = store.readState().active_flow;
  const flow = id ? store.readFlow(id) : null;
  const inputs = flow?.stage === 'P0' ? flow.intake?.files.map((f) => `- ${f.path}（${f.size} 字节，${f.type}）`).join('\n') : '';
  const rejected = id ? store.listAmends(id).filter((a) => a.status === 'rejected').at(-1) : undefined;
  return `[pi-forge 状态] ${s.summary}\n[唯一允许的下一步] ${s.next}${inputs ? `\n[输入清单：用 forge_read 阅读]\n${inputs}` : ''}${rejected ? `\n[最近修订打回意见] amend:${rejected.id}：${rejected.feedback}` : ''}`;
}
export function dirtyFiles(root: string): Set<string> {
  const out = git(root, ['status', '--porcelain', '-uall', '--', '.', ':(exclude).forge']).split('\n').filter(Boolean);
  return new Set(out.map((l) => l.slice(3)));
}
export function newDrift(before: Set<string>, after: Set<string>): string[] { return [...after].filter((f) => !before.has(f)).sort(); }
