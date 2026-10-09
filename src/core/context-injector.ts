// 来源：pi-flow src/core/context-injector.ts @ 31f3f15
// 每轮向 orchestrator 注入"当前状态与唯一允许的下一步"（第 18 节第 7 条、第 20 节第 3 条），并检测主工作区越权改动（第 20 节第 6 条）。
import { awaitingMerge, finishReport } from './finish-report.ts';
import type { StateStore } from './state-store.ts';
import type { FlowConfig } from './config.ts';
import { budgetState } from './cost-control.ts';
import { computeReady } from './dag.ts';
import { isSettled } from './state-machine.ts';
import { heldByRevision } from './revision.ts';
import { selectDispatchable } from './scheduler.ts';
import { git } from './git.ts';
import type { FlowFile, ModelPause, TaskFile } from './schemas.ts';
import { REQUIREMENTS_STAGE } from './requirements.ts';
import { intakeBrief } from './intake.ts';
import { DESIGN_DOC, PLANNING_STAGE } from '../modes/plan.ts';
import { FINAL_REVIEW_DOC, LEVEL_LABEL } from './final-review.ts';
import { REVIEW_GUIDE, awaitingReview } from './run-budget.ts';

export interface NextStep { summary: string; next: string; tool: 'forge_dispatch' | 'forge_wait' | 'forge_requirements' | 'forge_propose_modules' | 'forge_revise_plan' | 'forge_resolve_timeout' | 'forge_resolve_scope' | 'none'; task?: string }

/** paused：任务下一次派发要用的模型正被暂停时返回暂停记录（来自 Engine.pausedFor） */
export type PausedOf = (flowId: string, t: TaskFile) => ModelPause | null;

export function nextStep(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): NextStep {
  const flowId = store.readState().active_flow;
  if (!flowId) return { summary: '没有进行中的流程。', next: '如需开始，请用户执行 /forge-build（新项目）、/forge-build --feature "<描述>" 或 /forge-fix "<描述>"。不要自己修改代码。', tool: 'none' };
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const stageTasks = tasks.filter((t) => t.stage === flow.stage);
  const count = (pred: (t: TaskFile) => boolean) => stageTasks.filter(pred).length;
  const summary = `流程 ${flow.id}「${flow.title}」阶段 ${flow.stage}（${flow.stage_status}）；本阶段任务 ${stageTasks.length} 个：完成 ${count((t) => t.status === 'done')}，进行中 ${count((t) => ['in_progress', 'queued_merge', 'merging'].includes(t.status))}，可派发 ${count((t) => t.status === 'ready' || t.status === 'pending')}，阻塞 ${count((t) => t.status === 'blocked')}。`;

  if (store.readRevision(flowId)?.status === 'proposed') return { summary, next: '计划修订等待用户批准。请向用户概述修订内容（forge_status 中可见），请其执行 /forge-approve 或 /forge-reject "<意见>"；你只能等待。', tool: 'none' };
  if (awaitingMerge(flow)) return { summary, next: `全部模块已完成，等用户批准合入主分支。照下面的收尾汇报向用户说明（做了什么、要用户打开查看的条目、需要确认的地方、用时），请其执行 /forge-approve；你只能等待。\n\n${finishReport(store, flowId)}`, tool: 'none' };
  if (flow.stage_status === 'awaiting_human') return { summary, next: `阶段 ${flow.stage} 的闸门等待用户批准。请向用户说明结果，请其执行 /forge-approve；你只能等待。`, tool: 'none' };
  if (flow.stage_status === 'awaiting_gate') return { summary, next: '程序正在执行阶段闸门检查，调用 forge_wait 等待结果。', tool: 'forge_wait' };
  if (flow.stage_status !== 'active') return { summary, next: '流程已结束或中止。向用户汇报即可。', tool: 'none' };
  if (flow.stage === REQUIREMENTS_STAGE && flow.mode !== 'fix' && !flow.requirements?.submitted) return { summary, next: requirementsNext(flow), tool: 'forge_requirements' };
  if (flow.stage === PLANNING_STAGE && flow.mode !== 'fix' && !flow.planning?.submitted) return { summary, next: planningNext(flow), tool: 'forge_propose_modules' };
  if (flow.replan_request && !(store.readRevision(flowId)?.status === 'proposed')) {
    const r = flow.replan_request;
    return { summary, next: `用户要求修订计划：${r.reason}${r.feedback ? `\n${r.feedback}` : ''}\n先读相关代码与 docs/modules.md（规划文档在集成分支 ${flow.integration_branch} 上，用 git show ${flow.integration_branch}:docs/modules.md 读）、forge_status 的任务一览，按技能 revise-plan 判断：归到哪个未开始的模块（调整它的依赖或取消重建）还是新增模块；然后调用 forge_revise_plan 提交（用户 /forge-approve 后生效）。其他任务照常运行，期间有 forge_wait 的事也照常处理。`, tool: 'forge_revise_plan' };
  }
  const review = store.readFinalReview(flowId);
  if (review?.status === 'awaiting_user' && review.stage === flow.stage) {
    const left = review.findings.filter((f) => !review.fixed.includes(f.id));
    return { summary, next: `最终代码审查已完成（${FINAL_REVIEW_DOC}），还有 ${left.length} 条没修：${left.map((f) => `${f.id}【${LEVEL_LABEL[f.level]}】${f.problem.slice(0, 60)}`).join('；')}。向用户概述这些条目，请用户挑选：/forge review fix <R-编号>... 交给负责的模块修复，或 /forge review done 都不修；你只能等待。`, tool: 'none' };
  }

  // 范围申请与其他任务重叠，等主会话决定（第六轮 D3）
  const scopes = tasks.filter((t) => t.scope_request);
  if (scopes.length) {
    return { summary, next: `子进程申请追加可写范围，与其他未完成任务重叠：${scopes.map((t) => `${t.id} 申请 ${t.scope_request!.paths.join('、')}（${t.scope_request!.conflicts.join('；')}；原因：${t.scope_request!.reason.slice(0, 200)}）`).join('\n')}\n看过相关模块的范围与 docs/modules.md 后对每个任务调用 forge_resolve_scope(task_id, approve|reject, note)：改动小、对方还没开始或改的是不同部分的可以批准（合并时程序处理冲突）；属于对方模块职责的拒绝，并写明该怎么做（例如通过接口调用、写进 handoff 等对方做）。之后继续 forge_wait。`, tool: 'forge_resolve_scope', task: scopes[0]!.id };
  }
  // 运行超时等主会话复核（其他任务照常运行）
  const reviews = tasks.filter(awaitingReview);
  if (reviews.length) {
    return { summary, next: `任务 ${reviews.map((t) => t.id).join('、')} 运行超过时间预算被结束，等你复核。forge_status 里有材料（改动、handoff、最后的回复）；对每个任务调用 forge_resolve_timeout(task_id, decision, note)。${REVIEW_GUIDE} 复核完继续 forge_wait。`, tool: 'forge_resolve_timeout', task: reviews[0]!.id };
  }
  const budget = config ? budgetState(store, config, flow) : null;
  const overBudget = budget?.exceeded ? '本流程的预算已用完，程序暂停派发新任务。向用户说明，请其用 /forge budget 提高预算后继续。' : null;
  // 预测 promote 后的 ready（只读计算，不落盘）
  const promoted = new Set(computeReady(tasks, flow.stage));
  const view = tasks.map((t) => (promoted.has(t.id) ? { ...t, status: 'ready' as const } : t));
  const held = heldByRevision(store, flowId);
  const waiting = new Map<string, ModelPause>();
  for (const t of view) {
    const p = paused?.(flowId, t);
    if (p) waiting.set(t.id, p);
  }
  const pick = selectDispatchable(view.filter((t) => !held.has(t.id) && !waiting.has(t.id)), flow.stage, maxParallel)[0];
  const busy = view.some((t) => t.lease || ['queued_merge', 'merging'].includes(t.status)) || activeRunCount > 0;
  // 自动派发（limits.auto_dispatch，默认开）时 ready 任务由程序派发；只有程序空闲却还有可派发的任务（自动派发出错）时才让 orchestrator 手动派发以看到原因
  const auto = config?.limits.auto_dispatch !== false;
  if (pick && !overBudget && !(auto && busy)) return { summary, next: `调用 forge_dispatch(${pick})。不要自己实现任务。`, tool: 'forge_dispatch', task: pick };
  if (busy) return { summary, next: auto
    ? '任务由程序自动派发、合并，合并后由独立的验收者确认。调用 forge_wait 等待：它只在任务完成或阻塞、需要用户处理、阶段变化时返回；返回后用一两句话向用户汇报进展，再继续 forge_wait。'
    : '有任务在运行或合并中，调用 forge_wait 等待结果。', tool: 'forge_wait' };
  if (overBudget) return { summary, next: overBudget, tool: 'none' };
  if (waiting.size) {
    const models = [...new Set([...waiting.values()].map((p) => p.model))];
    return { summary, next: `模型 ${models.join('、')} 暂停中（额度用完或服务不可用），任务 ${[...waiting.keys()].join('、')} 在等它恢复，程序会在恢复后自动继续。向用户说明，请其等待自动恢复、执行 /forge models resume <模型> 立即恢复，或用 /forge-config 给受影响的角色换模型；你只能等待，不要调用 forge_dispatch。`, tool: 'none' };
  }
  const blocked = stageTasks.filter((t) => t.status === 'blocked');
  if (blocked.length) return { summary, next: `没有可推进的任务。向用户报告阻塞：${blocked.map((t) => `${t.id}（${(t.blocked_reason ?? '').slice(0, 60)}）`).join('；')}，请其回答问题（/forge answer <任务>）；如果需要改计划（例如任务拆得不对、验收标准不合理），和用户确认后用 forge_revise_plan 提交修订。`, tool: 'none' };
  const human = store.listAcceptances(flowId).filter((a) => a.status === 'needs_human');
  if (human.length) return { summary, next: `模块 ${human.map((a) => a.task).join('、')} 的验收两轮修复后仍未通过（${(human[0]!.reason ?? '').slice(0, 120)}），依赖它们的模块在等待。向用户说明，请其决定：/forge accept <任务> 人工放行，或告诉你怎么改（你用 forge_revise_plan 提交修订）；否则只能等待。`, tool: 'none' };
  if (stageTasks.length && stageTasks.every(isSettled)) return { summary, next: '本阶段任务全部完成，等待程序进行验收与阶段检查；调用 forge_wait。', tool: 'forge_wait' };
  return { summary, next: '当前阶段没有任务。向用户说明并等待指示。', tool: 'none' };
}

/** 需求（D0）：带了 PRD 时做就绪检查（技能 intake-check），没有时和用户逐轮讨论（技能 grilling）；都用 write-requirements 写成需求说明 */
function requirementsNext(flow: FlowFile): string {
  const r = flow.requirements;
  const tail = `写成需求说明（技能 write-requirements；每条验收条目带编号 AC-01、AC-02…），调用 forge_requirements(content) 提交${r?.path ? `（写到 ${r.path}）` : ''}；检查通过后直接进入规划，不用等用户审批。不要自己修改代码，也不要调用 forge_dispatch。`;
  const fb = r?.feedback ? `上次提交没有通过或被打回（第 ${r.rounds} 次），意见：${r.feedback}\n带着这些意见修改后重新提交。\n` : '';
  const i = flow.intake;
  if (i) {
    const design = i.pages.length ? `原型 ${i.pages.length} 页（清单见 prototype/INDEX.md）${i.design_doc ? `与设计规范 ${DESIGN_DOC}` : `；没有设计规范，从原型提取后用 forge_plan_doc 写 ${DESIGN_DOC}`}` : '没有原型';
    return `${fb}现在是接收：用户带来了 PRD ${i.prd}${i.arch ? `、技术架构 ${i.arch}` : ''}、${design}（都只在集成分支 ${flow.integration_branch} 上，主工作区里没有，read 找不到；PRD 与架构的原文在用户开始时的消息里，需要再看用 git show ${flow.integration_branch}:<路径>）。按技能 intake-check 做就绪检查${flow.mode === 'feature' ? '（先了解相关的现有代码）' : ''}：只就缺口与矛盾提问（有 ask_user 时一轮问完），已写清的不重新讨论；没有缺口就不问。然后把 PRD ${tail}`;
  }
  const what = flow.mode === 'build' ? '这个新项目' : '这次要加的功能';
  return `${fb}现在是需求讨论（用户没有给 PRD）：和用户逐轮讨论${what}（用户的描述：${flow.title}）。每轮把能问的问题一次问完（有 ask_user 时用它），编号并给出你推荐的答案，然后等用户回答；需要的事实自己查（read、grep、find、ls${flow.mode === 'feature' ? '，先了解相关的现有代码' : ''}），决定交给用户。要问到：谁用、核心场景、MVP 范围与验收标准、术语、界面风格。用户确认共识后，${tail}`;
}

/** 规划（D2）：主 agent 写规划文档并提交模块清单（技能 plan-modules、domain-modeling、write-rules） */
function planningNext(flow: FlowFile): string {
  const p = flow.planning;
  const fb = p?.feedback ? `上次的规划没有通过或被打回（第 ${p.rounds} 次），意见：${p.feedback}\n带着这些意见修改规划文档与模块清单，重新提交。\n` : '';
  const inputs = [flow.requirements?.path, flow.intake?.arch, flow.intake?.pages.length ? 'prototype/INDEX.md' : '', flow.intake?.design_doc || flow.intake?.pages.length ? DESIGN_DOC : ''].filter(Boolean).join('、');
  const docs = flow.mode === 'build'
    ? 'docs/modules.md（技术栈、目录结构、模块清单与依赖）、docs/glossary.md（术语表）、docs/interfaces/<模块>.md（只写模块之间的调用）、docs/rules-draft/project.md（项目专属规则，必写）与 docs/rules-draft/commands.yaml（install、typecheck、lint、test 等命令）、AGENTS.md'
    : 'docs/modules.md（追加本功能涉及的模块、各改什么）、必要时补 docs/glossary.md、docs/interfaces/、docs/rules-draft/';
  return `${fb}现在是规划：你自己规划，不派子任务。先读 ${inputs || '需求说明'}（这些文档在集成分支 ${flow.integration_branch} 上，主工作区里没有，用 git show ${flow.integration_branch}:<路径> 读）${flow.mode === 'feature' ? ' 与相关的现有代码（serena、codegraph、grep）' : ''}；用户给了技术架构就照它做，不重新设计，和现有代码冲突的地方问用户。用 forge_plan_doc(path, content) 写 ${docs}；然后用 forge_propose_modules 提交模块清单（每个模块是能单独验收的纵向切片，写明可写范围、负责的 AC 编号与验收标准、依赖、大小；需求小就只出一个模块）。提交后程序检查，再交给用户审批。不要调用 forge_dispatch。`;
}

export function turnContext(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): string {
  const s = nextStep(store, maxParallel, activeRunCount, config, paused);
  const flowId = store.readState().active_flow;
  const flow = flowId ? store.readFlow(flowId) : null;
  // print 模式没有 startConversation，恢复也没有开始时的消息；接收每轮由程序带上原件。
  const intake = flow?.stage === REQUIREMENTS_STAGE && flow.stage_status === 'active' && !flow.requirements?.submitted
    ? intakeBrief(store.root, flow) : '';
  return `[pi-forge 状态] ${s.summary}\n[唯一允许的下一步] ${s.next}${intake ? `\n\n${intake}` : ''}`;
}

/** 主工作区中 .forge/ 之外的未提交改动（含未跟踪文件） */
export function dirtyFiles(root: string): Set<string> {
  const out = git(root, ['status', '--porcelain', '-uall', '--', '.', ':(exclude).forge']).split('\n').filter(Boolean);
  return new Set(out.map((l) => l.slice(3)));
}

/** 本轮期间新出现的改动（轮开始时已有的不算，用户在两轮之间自己的改动不计为越权） */
export function newDrift(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((f) => !before.has(f)).sort();
}
