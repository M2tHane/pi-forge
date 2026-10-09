// 来源：pi-flow src/core/finish-report.ts @ 31f3f15
// 收尾汇报（第六轮 7.2）：最后一个阶段闸门通过、等用户批准合入时，由程序整理做了什么、各模块结果、要用户打开查看的条目、
// 超出需求或按默认处理的地方、用时与用量；主会话照此告诉用户，/forge report 也能随时查看。
import type { StateStore } from './state-store.ts';
import type { FlowFile } from './schemas.ts';
import { manualChecksOf } from './acceptance.ts';
import { activeMinutes } from './forge-watch.ts';
import { timingReport } from './timing.ts';

/** 流程停在最后一个阶段等用户批准（批准后合入主分支） */
export const awaitingMerge = (flow: Pick<FlowFile, 'mode' | 'stage' | 'stages' | 'stage_status'>) => flow.mode !== 'fix' && flow.stage === flow.stages.at(-1) && flow.stage_status === 'awaiting_human';

export function finishReport(store: StateStore, flowId: string, now = new Date()): string {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const modules = tasks.filter((t) => t.kind === 'impl' && t.status !== 'cancelled');
  const derived = tasks.filter((t) => ['review-fix', 'merge-fix'].includes(t.kind));
  const cancelled = tasks.filter((t) => t.status === 'cancelled');
  const runs = store.listRuns().filter((r) => r.flow === flowId);
  const tokens = runs.reduce((n, r) => n + (r.tokens.input ?? 0) + (r.tokens.output ?? 0), 0);
  const cost = runs.reduce((n, r) => n + (r.cost ?? 0), 0);
  const proposal = store.readProposal(flowId);
  const lines = [`# ${flow.id}「${flow.title}」收尾汇报`, ''];

  lines.push(`## 模块（${modules.length} 个）`);
  for (const t of modules) {
    const a = store.readAcceptance(flowId, t.id);
    const acc = !t.needs_acceptance ? '不需要验收' : !t.accepted ? '未验收' : a && a.status !== 'accepted' ? '验收未通过，你已放行' : `验收通过${a?.round ? `（修复 ${a.round} 轮）` : ''}`;
    const n = runs.filter((r) => r.task === t.id).length;
    const extra = [t.attempts ? `失败 ${t.attempts} 次` : '', t.timeouts ? `超时 ${t.timeouts} 次` : '', t.scope_grants?.length ? `追加范围 ${t.scope_grants.flatMap((g) => g.paths).join('、')}` : ''].filter(Boolean);
    lines.push(`- ${t.id}「${t.title}」：${t.status === 'done' ? '已合入集成分支' : t.status}，${acc}；运行 ${n} 次${extra.length ? `，${extra.join('，')}` : ''}${a?.summary ? `\n  ${a.summary.split('\n')[0]!.slice(0, 200)}` : ''}`);
  }
  if (derived.length) lines.push(`- 另有修复任务 ${derived.length} 个（验收修复、合并冲突）`);
  if (cancelled.length) lines.push(`- 取消的任务：${cancelled.map((t) => `${t.id}「${t.title}」`).join('、')}`);

  const manual = manualChecksOf(store, flowId);
  lines.push('', '## 需要你打开应用查看');
  lines.push(...(manual.length ? manual.flatMap((m) => [`- ${m.task}「${m.title}」`, ...m.items.map((x) => `  - [ ] ${x}`)]) : ['（无）']));

  const extras = proposal?.extras ?? [];
  const assumed = proposal?.assumptions ?? [];
  if (extras.length || assumed.length) {
    lines.push('', '## 需要你确认的地方');
    for (const x of extras) lines.push(`- 超出需求：${x}`);
    for (const x of assumed) lines.push(`- 需求没说清，按默认处理：${x}`);
  }

  lines.push('', '## 用时与用量');
  lines.push(`- 用时 ${Math.round(activeMinutes(flow, store.readEvents(), now))} 分钟（不含需求阶段与等你审批的时间）；从开始到现在 ${Math.round((now.getTime() - Date.parse(flow.created_at)) / 60_000)} 分钟`);
  lines.push(`- 子进程运行 ${runs.length} 次，token ${tokens.toLocaleString('en-US')}（输入 + 输出）${cost ? `，金额 ${cost.toFixed(4)}` : ''}`);
  const timing = timingReport(store, flowId, now);
  lines.push(`- 各阶段进行中（分钟）：${timing.stages.map((s) => `${s.stage} ${s.active_min}`).join('，')}；子进程：${timing.roles.map((x) => `${x.role} ${x.minutes}`).join('，') || '无'}；合并与验证 ${timing.merge.merging_min}（详见 /forge-status --timing）`);
  lines.push('', `批准后合入主分支：/forge-approve；有问题用 /forge-add "<问题>" 交给主 agent 安排修复。`);
  return lines.join('\n');
}
