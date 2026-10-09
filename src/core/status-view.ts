// 来源：pi-flow src/core/status-view.ts @ 31f3f15
// 给人看的状态视图：只呈现高层阶段（接收或需求 → 规划 → 实施 → 完成）、进度、正在做的事和需要用户处理的事。
// 底层阶段（S0…S5、F0、F1）、任务 DAG 与状态机细节留给程序与 /forge-status --detail。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import { isFinished } from './state-store.ts';
import { budgetState, formatBudget } from './cost-control.ts';
import { activePauses, describePause } from './model-pause.ts';
import { MAX_GATE_ROUNDS, describeAcceptance, manualChecksOf } from './acceptance.ts';
import { type FlowFile, type Phase, type TaskFile } from './schemas.ts';
import { DESIGN_STAGES, PROPOSAL_STAGES } from '../modes/plan.ts';
import { stallOf, stuckTasks } from './forge-watch.ts';
import { awaitingMerge } from './finish-report.ts';

export type PhaseOrDone = Phase | 'done';

export const PHASE_LABEL: Record<PhaseOrDone, string> = {
  requirements: '需求', planning: '规划', execution: '实施', done: '完成',
};

/** 带了 PRD 进来的流程，需求阶段叫"接收" */
/** 高层阶段名：带 PRD 的需求阶段叫"接收"；最后一个阶段闸门通过、等用户批准合入时叫"完成（待合入）"（第六轮 7.2） */
export const phaseLabel = (flow: Pick<FlowFile, 'intake' | 'mode' | 'stage' | 'stages' | 'stage_status'>, p: PhaseOrDone) =>
  (awaitingMerge(flow) ? '完成（待合入）' : p === 'requirements' && flow.intake ? '接收' : PHASE_LABEL[p]);

/** 未在 workflow.yaml 中写 phase 时的默认对应 */
const DEFAULT_PHASE: Record<string, Phase> = {
  D0: 'requirements', D2: 'planning', E: 'execution',
  S0: 'requirements', F0: 'requirements', S1: 'planning', F1: 'planning', S2: 'execution', S3: 'execution', S4: 'execution', S5: 'execution',
};

const GOALS: Record<'build' | 'feature' | 'fix', Record<PhaseOrDone, string>> = {
  build: {
    requirements: '主 agent 读你给的 PRD、架构与原型，只就缺口提问，写成带编号验收条目的需求说明（没有 PRD 时和你逐轮讨论）',
    planning: '主 agent 划分模块、排好顺序、写模块之间的接口与项目规则，你确认',
    execution: '一个模块交给一个模型实现（前后端与测试），合并时跑全量测试，再由独立的验收者对照验收标准确认',
    done: '已合入主分支',
  },
  feature: {
    requirements: '主 agent 读你给的 PRD 与原型，只就缺口提问，写成需求说明（没有 PRD 时和你逐轮讨论）',
    planning: '主 agent 确定涉及哪些模块、各改什么、验收标准，你确认',
    execution: '按模块实现，合并时跑全量测试，再由独立的验收者确认',
    done: '已合入主分支',
  },
  fix: {
    requirements: '记录问题',
    planning: '（不适用）',
    execution: '实现者定位并修复，合并后由验收者复现确认已修好',
    done: '已合入主分支',
  },
};

const INFLIGHT = new Set(['in_progress', 'queued_merge', 'merging']);

export function phaseOfStage(config: FlowConfig, mode: 'build' | 'feature', stage: string): Phase {
  const def = config.raw.modes[mode]?.stages.find((s) => s.id === stage);
  return def?.phase ?? DEFAULT_PHASE[stage] ?? 'execution';
}

/** fix 流程的高层阶段：记录问题 → 实施（定位、修复、验收）→ 完成 */
function fixPhase(flow: FlowFile, tasks: TaskFile[]): PhaseOrDone {
  if (isFinished(flow) && flow.stage_status === 'done') return 'done';
  return tasks.length ? 'execution' : 'requirements';
}

export function currentPhase(config: FlowConfig, flow: FlowFile, tasks: TaskFile[]): PhaseOrDone {
  if (flow.mode === 'fix') return fixPhase(flow, tasks);
  if (isFinished(flow) && flow.stage_status === 'done') return 'done';
  return phaseOfStage(config, flow.mode, flow.stage);
}

/** 本流程会经过的高层阶段（按配置的阶段顺序去重） */
export function phasesOf(config: FlowConfig, flow: FlowFile): Phase[] {
  if (flow.mode === 'fix') return ['requirements', 'execution'];
  const out: Phase[] = [];
  for (const s of flow.stages) {
    const p = phaseOfStage(config, flow.mode, s);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const FAILURE_KIND: Record<string, string> = {
  merge_verify_fail: '合并时全量测试失败', run_failed: '运行中断', lease_expired: '租约过期',
};

/** 任务最近一次失败的类型（来自事件日志） */
export function lastFailureKind(store: StateStore, flowId: string, taskId: string): string | null {
  const ev = [...store.readEvents()].reverse().find((e) => e.flow === flowId && e.task === taskId && e.type === 'transition' && e.trigger && e.trigger in FAILURE_KIND);
  return ev ? FAILURE_KIND[ev.trigger!]! : null;
}

export function taskActivity(t: TaskFile, failureKind: string | null): string {
  const working = t.accept_of ? (t.accept_kind === 'confirm' ? '复查中' : '验收中') : t.final_review ? '代码审查中' : t.replan ? '起草计划修订' : t.kind === 'review-fix' ? '修复中' : t.kind === 'merge-fix' ? '解决合并冲突' : t.kind === 'doc' ? '撰写中' : '实现中';
  const base = t.status === 'in_progress' ? (t.lease ? working : '等待重新派发')
        : t.status === 'queued_merge' || t.status === 'merging' ? '合入中'
          : t.status === 'ready' ? '待派发'
            : t.status === 'pending' ? '等待前置任务'
              : t.status === 'blocked' ? '阻塞' : t.status === 'cancelled' ? '已取消' : '已完成';
  const retry = t.attempts > 0 && t.status !== 'done' && t.status !== 'blocked'
    ? `（第 ${t.attempts + 1} 次${failureKind ? `，上次：${failureKind}` : ''}）` : '';
  return base + retry;
}

export interface Action { key: string; text: string; command: string }

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

/** 需要用户处理的事项（按流程汇总） */
export function actionsNeeded(store: StateStore, config: FlowConfig, now = new Date()): Action[] {
  const out: Action[] = [];
  for (const flow of visibleFlows(store)) {
    const tasks = store.listTasks(flow.id);
    if (flow.stage_status === 'awaiting_human') {
      if (flow.mode === 'fix') {
        const why = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.type === 'gate_result')?.reason ?? '';
        out.push({ key: `${flow.id}:escalation`, text: `修复 ${flow.id} 超出修复规模：${short(why.replace(/^建议改用 \/forge-build --feature：/, ''))}`, command: '仍按修复处理 /forge-approve；改用功能流程 /forge abort 后 /forge-build --feature "<描述>"' });
      } else {
        const phase = phaseLabel(flow, currentPhase(config, flow, tasks));
        const last = flow.stage === flow.stages.at(-1);
        const extras = PROPOSAL_STAGES.has(flow.stage) ? store.readProposal(flow.id)?.extras?.length ?? 0 : 0;
        const assumed = PROPOSAL_STAGES.has(flow.stage) ? store.readProposal(flow.id)?.assumptions?.length ?? 0 : 0;
        const manual = last ? manualChecksOf(store, flow.id).reduce((n, m) => n + m.items.length, 0) : 0;
        out.push({ key: `${flow.id}:gate:${flow.stage}`, text: `${last ? '全部模块已完成，等你批准合入主分支（收尾汇报：/forge report）' : `${phase}阶段的产出等待你审批`}${manual ? `；批准前请先打开应用完成 ${manual} 项界面检查（见下方）` : ''}${extras ? `；其中 ${extras} 项设计超出了需求，需要你确认（/forge-status --detail 查看）` : ''}${assumed ? `；${assumed} 处需求没说清，规划时按默认方案处理了，需要你确认（/forge-status --detail 查看）` : ''}`, command: last ? '/forge-approve' : '/forge-approve 或 /forge-reject "<意见>"' });
      }
    }
    if (flow.mode !== 'fix' && flow.stage_status === 'active') {
      const gate = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.type === 'gate_result');
      const rounds = (flow.gate_rounds ?? []).filter((r) => r.stage === flow.stage).length;
      // 模块验收两轮修复后仍不通过（第五轮）
      for (const a of store.listAcceptances(flow.id).filter((x) => x.status === 'needs_human')) {
        const t = tasks.find((x) => x.id === a.task);
        out.push({ key: `${flow.id}:accept:${a.task}:${a.version}`, text: `模块 ${a.task}「${short(t?.title ?? '', 40)}」验收${short(a.reason ?? '未通过', 200)}，依赖它的模块在等待`,
          command: `/forge accept ${a.task} 人工放行；或 /forge-add "<怎么改>" --task <修复任务>、/forge replan "<怎么改>" 交给主 agent 修订计划` });
      }
      if (flow.stage === 'D0' && !flow.requirements?.submitted) {
        out.push({ key: `${flow.id}:discuss:${flow.requirements?.rounds ?? 0}`, text: flow.intake ? '接收中：主 agent 在检查你给的 PRD 与原型，回答它就缺口提的问题；之后它直接规划' : '需求讨论中：回答主 agent 的问题，确认共识后它会写成需求说明并开始规划', command: '直接在对话里回答' });
      } else if (gate?.to === 'active' && gate.data?.['stage'] === flow.stage && (DESIGN_STAGES.has(flow.stage) || rounds >= MAX_GATE_ROUNDS || !tasks.some((t) => t.stage === flow.stage && !['done', 'cancelled'].includes(t.status)))) {
        out.push({ key: `${flow.id}:gatefail:${gate.seq}`, text: `阶段检查未通过${rounds >= MAX_GATE_ROUNDS ? `（已自动修复 ${rounds} 轮）` : ''}：${short(gate.reason ?? '')}`, command: '用 /forge replan "<怎么修>" 交给主 agent 修订计划，或处理后执行 /forge gate 重跑' });
      }
    }
    // 要你自己打开应用查看的检查项（agent 不启动桌面应用与浏览器）：模块验收通过后列出
    for (const m of manualChecksOf(store, flow.id)) {
      out.push({ key: `${flow.id}:manual:${m.task}:${m.items.length}`, text: `模块 ${m.task}「${short(m.title, 40)}」代码已验收，需要你打开应用查看：${m.items.map((x, i) => `${i + 1}. ${short(x, 120)}`).join('；')}`,
        command: `有问题用 /forge-add "${m.task} 的问题：<看到了什么>"（交给主 agent 安排修复）；没问题不用操作` });
    }
    const review = flow.mode !== 'fix' ? store.readFinalReview(flow.id) : null;
    if (review?.status === 'awaiting_user') {
      const left = review.findings.filter((f) => !review.fixed.includes(f.id));
      out.push({ key: `${flow.id}:review:${review.version}`, text: `最终代码审查还有 ${left.length} 条没修（${left.map((f) => f.id).join('、')}），等你挑选（/forge review 查看）`, command: '/forge review fix <R-编号>... 交给模块修复；/forge review done 都不修' });
    }
    const stuck = stuckTasks(flow, tasks);
    if (stuck?.length) {
      out.push({ key: `${flow.id}:stuck:${stuck.map((t) => `${t.id}@${t.version}`).join(',')}`, text: `流程卡住：本阶段剩下的任务都被 ${stuck.map((t) => t.id).join('、')} 挡住，程序不会再自动推进`,
        command: `逐个处理下面的阻塞（/forge answer <任务>），或 /forge replan "<怎么调整>" 交给主 agent 修订计划` });
    }
    const stall = stallOf(store, config, flow, now);
    if (stall) {
      out.push({ key: `${flow.id}:stall:${stall.seq}`, text: `流程停滞：${stall.minutes} 分钟没有任何进展，也没有运行中的任务`,
        command: '/forge-status --detail 查看各任务状态；/forge-resume 让程序重新检查并派发' });
    }
    const budget = budgetState(store, config, flow, now);
    if (budget?.warn) {
      out.push({ key: `${flow.id}:budget:${budget.exceeded ? 'over' : 'warn'}`, text: formatBudget(budget),
        command: budget.exceeded ? '/forge budget tokens|cost|minutes <数值> 提高预算后继续' : '/forge-status --cost 查看用量；需要时 /forge budget 提高预算' });
    }
    const rev = store.readRevision(flow.id);
    if (rev?.status === 'proposed') {
      out.push({ key: `${flow.id}:revision:${rev.version}`, text: `计划修订等待你批准：${short(rev.summary, 200)}`, command: '/forge-approve 批准，或 /forge-reject "<意见>" 打回重做（详情：/forge-status --detail）' });
    }
    if (flow.sync?.status === 'conflict') {
      out.push({ key: `${flow.id}:sync:${flow.sync.main_sha}`, text: `把 ${config.raw.main_branch} 同步进集成分支时冲突，已暂停派发新任务：${short(flow.sync.reason ?? '')}`,
        command: `在 ${flow.integration_branch} 上合并 ${config.raw.main_branch} 并解决冲突后执行 /forge sync` });
    }
    for (const t of tasks.filter((x) => x.status === 'blocked')) {
      out.push({ key: `${flow.id}:blocked:${t.id}:${t.version}`, text: `${t.id}「${short(t.title, 40)}」阻塞：${short(t.blocked_reason ?? '')}`, command: `/forge answer ${t.id}` });
    }
  }
  for (const p of activePauses(store, now)) {
    out.push({ key: `model-pause:${p.model}@${p.since}`, text: short(describePause(p, now), 400),
      command: `等待自动恢复，或 /forge models resume ${p.model} 立即恢复；也可以用 /forge-config 给 ${p.roles.join('、')} 换模型（换后立即继续）` });
  }
  const cand = store.readKnowledge().entries.filter((e) => e.status === 'candidate');
  if (cand.length) {
    out.push({ key: `knowledge:candidates:${cand.at(-1)!.id}`, text: `${cand.length} 条知识候选待确认（来自合并后验证失败）：${cand.slice(-3).map((e) => e.id).join('、')}${cand.length > 3 ? ' 等' : ''}`,
      command: '/forge knowledge 查看；确认 /forge knowledge accept <K-编号>，不要 /forge knowledge retire <K-编号>' });
  }
  return out;
}

/** 用户关心的流程：活动的 build/feature 流程，以及未结束的修复 */
export function visibleFlows(store: StateStore): FlowFile[] {
  const out: FlowFile[] = [];
  const active = store.readState().active_flow;
  if (active) out.push(store.readFlow(active));
  const fix = store.openFixFlow();
  if (fix) out.push(fix);
  return out;
}

function phaseBar(config: FlowConfig, flow: FlowFile, cur: PhaseOrDone): string {
  const all: PhaseOrDone[] = [...phasesOf(config, flow), 'done'];
  const idx = all.indexOf(cur);
  // 跳过的阶段（例如无界面时的原型）对应的高层阶段标为"跳过"
  const mode = flow.mode;
  const phaseOf = (s: string) => (mode === 'fix' ? null : phaseOfStage(config, mode, s));
  const skipped = new Set((flow.skip_stages ?? []).map(phaseOf));
  const kept = new Set(flow.stages.filter((s) => !flow.skip_stages?.includes(s)).map(phaseOf));
  // 等合入时只把当前阶段标为"完成（待合入）"
  const name = (p: PhaseOrDone) => phaseLabel(p === cur ? flow : { ...flow, stage_status: 'active' }, p);
  const label = (p: PhaseOrDone) => (p !== 'done' && skipped.has(p) && !kept.has(p) ? `${name(p)}（跳过）` : null);
  return all.map((p, i) => label(p) ?? (i < idx ? `${name(p)} ✓` : i === idx ? `[${name(p)}]` : name(p))).join(' → ');
}

export function renderFlow(store: StateStore, config: FlowConfig, flow: FlowFile): string {
  const tasks = store.listTasks(flow.id);
  const cur = currentPhase(config, flow, tasks);
  const lines = [`${flow.id}「${short(flow.title, 60)}」${flow.mode === 'fix' ? '（修复）' : flow.mode === 'feature' ? '（功能）' : ''}`, phaseBar(config, flow, cur), ''];
  lines.push(`${phaseLabel({ ...flow, stage_status: 'active' }, cur)}阶段：${GOALS[flow.mode][cur]}`);
  const inPhase = flow.mode === 'fix' || cur === 'done' ? tasks
    : tasks.filter((t) => phaseOfStage(config, flow.mode as 'build' | 'feature', t.stage) === cur);
  const counted = inPhase.filter((t) => t.status !== 'cancelled');
  const discussing = flow.stage === 'D0' && flow.mode !== 'fix';
  lines.push(counted.length ? `进度：${counted.filter((t) => t.status === 'done').length} / ${counted.length} 个任务完成`
    : discussing ? (flow.requirements?.submitted ? '进度：需求说明已提交' : `进度：和主 agent 讨论中${flow.requirements?.rounds ? `（第 ${flow.requirements.rounds + 1} 版）` : ''}`) : '进度：本阶段的任务尚未生成');
  const active = tasks.filter((t) => INFLIGHT.has(t.status));
  lines.push('');
  lines.push(active.length
    ? `正在进行：\n${active.map((t) => `- ${t.id} ${short(t.title, 40)}（${t.lease?.role ?? t.role}）${taskActivity(t, t.attempts ? lastFailureKind(store, flow.id, t.id) : null)}`).join('\n')}`
    : `正在进行：${flow.stage_status === 'awaiting_human' ? '无（等待你审批）' : flow.stage_status === 'awaiting_gate' ? '阶段检查中' : '无'}`);
  // 模块与验收进度（第五轮）
  const mods = tasks.filter((t) => t.needs_acceptance && t.status !== 'cancelled');
  if (mods.length) {
    lines.push(`模块：\n${mods.map((t) => {
      const a = store.readAcceptance(flow.id, t.id);
      const state = a ? describeAcceptance(a) : t.status === 'done' ? '等待验收' : taskActivity(t, null);
      return `- ${t.id} ${short(t.title, 40)}：${state}`;
    }).join('\n')}`);
  }
  const blocked = tasks.filter((t) => t.status === 'blocked');
  lines.push(blocked.length ? `阻塞：${blocked.map((t) => t.id).join('、')}（见上方"需要你处理"）` : '阻塞：无');
  return lines.join('\n');
}

/** /forge-status 的默认视图 */
export function renderStatus(store: StateStore, config: FlowConfig): string {
  const flows = visibleFlows(store);
  if (!flows.length) return '当前没有进行中的流程。开始：/forge-build "<项目描述>"、/forge-build --feature "<功能描述>" 或 /forge-fix "<问题描述>"。';
  const actions = actionsNeeded(store, config);
  const head = actions.length
    ? `需要你处理：\n${actions.map((a) => `- ${a.text}\n  → ${a.command}`).join('\n')}`
    : '需要你处理：无';
  return [head, ...flows.map((f) => renderFlow(store, config, f)), '（完整任务列表：/forge-status --detail；成本：/forge-status --cost）'].join('\n\n');
}

// —— 主动通知：只在进入新阶段、出现需要用户处理的事、任务首次失败重试时提醒 ——

export interface StatusSnapshot {
  phases: Record<string, PhaseOrDone>;
  actions: Record<string, string>;
  attempts: Record<string, number>;
}

export function snapshotOf(store: StateStore, config: FlowConfig): StatusSnapshot {
  const snap: StatusSnapshot = { phases: {}, actions: {}, attempts: {} };
  const flows = visibleFlows(store);
  for (const f of flows) {
    const tasks = store.listTasks(f.id);
    snap.phases[f.id] = currentPhase(config, f, tasks);
    for (const t of tasks) snap.attempts[`${f.id}/${t.id}`] = t.attempts;
  }
  for (const a of actionsNeeded(store, config)) snap.actions[a.key] = `${a.text} → ${a.command}`;
  return snap;
}

export function notices(prev: StatusSnapshot, next: StatusSnapshot, failureKind?: (flow: string, task: string) => string | null): string[] {
  const out: string[] = [];
  for (const [flow, phase] of Object.entries(next.phases)) {
    const before = prev.phases[flow];
    if (before && before !== phase) out.push(phase === 'done' ? `pi-forge：${flow} 已完成。` : `pi-forge：${flow} 进入${PHASE_LABEL[phase]}阶段。`);
  }
  for (const flow of Object.keys(prev.phases)) {
    if (!(flow in next.phases)) out.push(`pi-forge：${flow} 已结束${flow.startsWith('X-') ? '，修复已合入主分支或已中止，详见 /forge-status --cost 中的修复日志' : ''}。`);
  }
  for (const [key, text] of Object.entries(next.actions)) {
    if (!(key in prev.actions)) out.push(`pi-forge 需要你处理：${text}`);
  }
  for (const key of Object.keys(prev.actions)) {
    if (key.startsWith('model-pause:') && !(key in next.actions)) out.push(`pi-forge：模型 ${key.slice('model-pause:'.length, key.lastIndexOf('@'))} 已恢复派发。`);
  }
  for (const [key, n] of Object.entries(next.attempts)) {
    if (n === 1 && (prev.attempts[key] ?? 0) === 0) {
      const [flow, task] = key.split('/') as [string, string];
      const kind = failureKind?.(flow, task);
      out.push(`pi-forge：${task} 第一次未通过${kind ? `（${kind}）` : ''}，程序已自动重试。`);
    }
  }
  return out;
}

/**
 * 状态栏一行（调度模式、终端界面）：流程、高层阶段、本阶段进度、正在进行的任务、需要用户处理的事项数。
 * 没有可见流程时返回 null（清除状态栏）。
 */
export function statusLine(store: StateStore, config: FlowConfig): string | null {
  const flows = visibleFlows(store);
  if (!flows.length) return null;
  const actions = actionsNeeded(store, config).length;
  const parts = flows.map((flow) => {
    const tasks = store.listTasks(flow.id);
    const cur = currentPhase(config, flow, tasks);
    const inPhase = (flow.mode === 'fix' || cur === 'done' ? tasks : tasks.filter((t) => phaseOfStage(config, flow.mode as 'build' | 'feature', t.stage) === cur))
      .filter((t) => t.status !== 'cancelled');
    const active = tasks.filter((t) => INFLIGHT.has(t.status));
    const running = active.slice(0, 3).map((t) => `${t.id} ${taskActivity(t, null)}`).join('，');
    const state = awaitingMerge(flow) ? '等你批准合入' : flow.stage_status === 'awaiting_human' ? '等待你审批' : flow.stage_status === 'awaiting_gate' ? '阶段检查中' : '';
    return [`${flow.id} ${phaseLabel(flow, cur)}`, inPhase.length ? `${inPhase.filter((t) => t.status === 'done').length}/${inPhase.length}` : '',
      running ? `进行中：${running}${active.length > 3 ? ` 等 ${active.length} 个` : ''}` : state].filter(Boolean).join(' · ');
  });
  return `pi-forge ${parts.join(' ｜ ')}${actions ? ` · 需要你处理 ${actions} 项` : ''}`;
}
