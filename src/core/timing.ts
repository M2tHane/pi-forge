// 来源：pi-flow src/core/timing.ts @ 31f3f15
// 耗时分布（第六轮 A1）：时间花在哪里——各阶段（进行中、闸门检查、等你审批）、子进程按角色与结果、合并排队与合并验证、
// 任务阻塞，以及用时最长的任务。全部由事件与 runs 现算；/forge-status --timing 查看（--json 输出 JSON）。
import type { StateStore } from './state-store.ts';
import type { FlowEvent, FlowFile } from './schemas.ts';
import { TASK_STATUSES } from './schemas.ts';

export interface TimingReport {
  flow: string;
  wall_min: number;
  stages: { stage: string; active_min: number; gate_min: number; awaiting_human_min: number }[];
  roles: { role: string; runs: number; minutes: number; outcomes: Record<string, number> }[];
  merge: { queued_min: number; merging_min: number };
  blocked_min: number;
  tasks: { task: string; title: string; run_min: number; runs: number }[];
}

const min = (ms: number) => Math.round(ms / 6_000) / 10;
const STATUS = new Set<string>(TASK_STATUSES);

function stageTimes(flow: FlowFile, events: readonly FlowEvent[], now: number): TimingReport['stages'] {
  const acc = new Map<string, { active: number; gate: number; human: number }>();
  let stage = flow.stages[0]!;
  let status = 'active';
  let since = Date.parse(flow.created_at);
  const add = (until: number) => {
    const a = acc.get(stage) ?? { active: 0, gate: 0, human: 0 };
    const d = Math.max(0, until - since);
    if (status === 'awaiting_human') a.human += d; else if (status === 'awaiting_gate') a.gate += d; else if (status === 'active') a.active += d;
    acc.set(stage, a);
  };
  for (const e of events) {
    if (e.flow !== flow.id || e.data?.['entity'] !== 'stage' || !e.to) continue;
    const at = Date.parse(e.ts);
    add(at);
    since = at;
    if (typeof e.data['stage'] === 'string') status = e.to;
    else { stage = e.to; status = 'active'; }
  }
  if (!['done', 'aborted'].includes(status) && stage !== 'finished') add(now);
  return [...acc].map(([s, a]) => ({ stage: s, active_min: min(a.active), gate_min: min(a.gate), awaiting_human_min: min(a.human) }));
}

/** 每个任务在各状态停留的时间（毫秒），按任务转移事件计算 */
function statusTimes(flowId: string, events: readonly FlowEvent[], now: number): Map<string, Record<string, number>> {
  const cur = new Map<string, { status: string; since: number }>();
  const out = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (e.flow !== flowId || !e.task || !e.to || !STATUS.has(e.to) || e.data?.['entity'] === 'stage') continue;
    const at = Date.parse(e.ts);
    const c = cur.get(e.task);
    if (c) { const r = out.get(e.task) ?? {}; r[c.status] = (r[c.status] ?? 0) + Math.max(0, at - c.since); out.set(e.task, r); }
    cur.set(e.task, { status: e.to, since: at });
  }
  for (const [task, c] of cur) {
    if (['done', 'cancelled'].includes(c.status)) continue;
    const r = out.get(task) ?? {};
    r[c.status] = (r[c.status] ?? 0) + Math.max(0, now - c.since);
    out.set(task, r);
  }
  return out;
}

export function timingReport(store: StateStore, flowId: string, now = new Date()): TimingReport {
  const flow = store.readFlow(flowId);
  const events = store.readEvents();
  const t = now.getTime();
  const runs = store.listRuns().filter((r) => r.flow === flowId);
  const dur = (r: (typeof runs)[number]) => Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : t) - Date.parse(r.started_at));
  const roles = new Map<string, TimingReport['roles'][number] & { ms: number }>();
  for (const r of runs) {
    const x = roles.get(r.role) ?? { role: r.role, runs: 0, minutes: 0, outcomes: {}, ms: 0 };
    x.runs++;
    x.ms += dur(r);
    const o = r.outcome ?? (r.ended_at ? 'unknown' : 'running');
    x.outcomes[o] = (x.outcomes[o] ?? 0) + 1;
    roles.set(r.role, x);
  }
  const st = statusTimes(flowId, events, t);
  const sum = (s: string) => [...st.values()].reduce((n, r) => n + (r[s] ?? 0), 0);
  const titles = new Map(store.listTasks(flowId).map((x) => [x.id, x.title]));
  const perTask = new Map<string, { ms: number; runs: number }>();
  for (const r of runs) { if (!r.task) continue; const x = perTask.get(r.task) ?? { ms: 0, runs: 0 }; x.ms += dur(r); x.runs++; perTask.set(r.task, x); }
  return {
    flow: flowId,
    wall_min: min(t - Date.parse(flow.created_at)),
    stages: stageTimes(flow, events, t),
    roles: [...roles.values()].sort((a, b) => b.ms - a.ms).map(({ ms, ...x }) => ({ ...x, minutes: min(ms) })),
    merge: { queued_min: min(sum('queued_merge')), merging_min: min(sum('merging')) },
    blocked_min: min(sum('blocked')),
    tasks: [...perTask].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5).map(([task, x]) => ({ task, title: titles.get(task) ?? '', run_min: min(x.ms), runs: x.runs })),
  };
}

export function formatTiming(r: TimingReport): string {
  const OUT: Record<string, string> = { submitted: '提交', failed: '失败', timeout: '超时', killed: '被结束', blocked: '阻塞', unavailable: '模型不可用', running: '运行中' };
  return [
    `# ${r.flow} 耗时分布（从开始到现在 ${r.wall_min} 分钟）`,
    '## 阶段（进行中 / 闸门检查 / 等你审批，分钟）',
    ...r.stages.map((s) => `- ${s.stage}：${s.active_min} / ${s.gate_min} / ${s.awaiting_human_min}`),
    '## 子进程（按角色，运行时间累计；并行时会超过墙钟）',
    ...(r.roles.length ? r.roles.map((x) => `- ${x.role}：${x.runs} 次，${x.minutes} 分钟（${Object.entries(x.outcomes).map(([k, v]) => `${OUT[k] ?? k} ${v}`).join('，')}）`) : ['（无）']),
    '## 合并与阻塞（各任务累计，分钟）',
    `- 排队等合并 ${r.merge.queued_min}，合并与验证 ${r.merge.merging_min}，阻塞等你处理 ${r.blocked_min}`,
    '## 运行时间最长的任务',
    ...(r.tasks.length ? r.tasks.map((x) => `- ${x.task}「${x.title}」：${x.runs} 次，${x.run_min} 分钟`) : ['（无）']),
  ].join('\n');
}
