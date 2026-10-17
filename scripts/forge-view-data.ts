// pi-forge 视图的数据提取（纯读取，不修改 .forge/）：forge-view.ts 与单元测试共用。
// 所有内嵌的自由文本（handoff、备注、证据摘录、事件原因）一律经 redactDeep 打码后才进入页面。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore, handoffRel, evidenceRel } from '../src/core/state/state-store.ts';
import { STAGE_TRANSITIONS, TRANSITIONS } from '../src/core/state/state-machine.ts';
import { flowMetrics } from '../src/core/stage/signoff.ts';
import { redactDeep, redactSecrets } from '../src/core/security/redact.ts';
import { REVIEW_REPORT } from '../src/core/stage/review-flow.ts';
import { QA_REPORT } from '../src/core/stage/stage-qa.ts';
import { ANSWER_FILE } from '../src/core/engine/consult.ts';
import type { FlowFile, TaskFile } from '../src/core/state/schemas.ts';

/** 角色（worker 只做 fix 与小改动） */
export const ROLES = ['orchestrator', 'architect', 'backend', 'frontend', 'worker', 'reviewer', 'stage-qa'] as const;

const HANDOFF_TAIL = 3000;
const EVIDENCE_TAIL = 1500;
const EVIDENCE_FILES = [REVIEW_REPORT, QA_REPORT, ANSWER_FILE];

const tail = (text: string, n: number) => (text.length > n ? text.slice(-n) : text);

/** 阶段列表：S0 架构、S1…Sn 批次（带目标与出口）、其余阶段；每项带状态与闸门轮次 */
function stageRows(flow: FlowFile, tasks: readonly TaskFile[]) {
  const plan = new Map((flow.s_stages ?? []).map((s) => [s.id, s]));
  const idx = flow.stages.indexOf(flow.stage);
  return flow.stages.map((id, i) => {
    const status = i < idx ? 'done' : i === idx ? flow.stage_status : 'pending';
    const mine = tasks.filter((t) => t.stage === id);
    const byStatus: Record<string, number> = {};
    for (const t of mine) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const p = plan.get(id);
    return {
      id, status, goal: p?.goal ?? null, exit: p?.exit ?? [], approved: flow.approvals[id] ?? null,
      tasks: mine.length, by_status: byStatus,
      gate_rounds: (flow.gate_rounds ?? []).filter((g) => g.stage === id),
    };
  });
}

export function buildViewData(store: StateStore, root: string, now = new Date()) {
  const state = store.readState();
  const flows = store.listFlows().map((id) => {
    const flow = store.readFlow(id);
    const tasks = store.listTasks(id);
    const handoffs: Record<string, string> = {};
    const evidence: Record<string, Record<string, string>> = {};
    for (const t of tasks) {
      const f = store.abs(handoffRel(id, t.id));
      if (existsSync(f)) handoffs[t.id] = tail(redactSecrets(readFileSync(f, 'utf8')).text, HANDOFF_TAIL);
      for (const name of EVIDENCE_FILES) {
        const e = store.abs(`${evidenceRel(id, t.id)}/${name}`);
        if (existsSync(e)) (evidence[t.id] ??= {})[name] = tail(readFileSync(e, 'utf8'), EVIDENCE_TAIL);
      }
    }
    let metrics: unknown = null;
    try { metrics = flowMetrics(store, id, now, root); } catch {
      try { metrics = flowMetrics(store, id, now); } catch { metrics = null; }
    }
    return { flow, kind: flow.mode, stageRows: stageRows(flow, tasks), tasks, handoffs, evidence, metrics };
  });
  const events = store.readEvents().map(({ entities: _e, prev_hash: _p, hash: _h, ...e }) => e);
  const data = {
    generatedAt: now.toISOString(),
    project: root,
    activeFlow: state.active_flow,
    roles: [...ROLES],
    flows,
    runs: store.listRuns(),
    events,
    transitions: TRANSITIONS.map((r) => ({ from: [...r.from], to: r.to, trigger: r.trigger, failure: !!r.failure, ...(r.counter ? { counter: r.counter } : {}) })),
    stageTransitions: STAGE_TRANSITIONS.map((r) => ({ from: [...r.from], to: r.to, trigger: r.trigger, humanOnly: !!r.humanOnly })),
    modelPauses: store.readModelPauses().pauses,
    mergeQueue: store.readMergeQueue(),
    knowledge: store.readKnowledge().entries.length,
  };
  return redactDeep(data).value as typeof data;
}

/** 把数据内嵌进 forge-view.html 的模板；`<` 转义，避免数据里的 </script> 截断页面 */
export function renderViewHtml(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = readFileSync(path.join(import.meta.dirname, 'forge-view.html'), 'utf8');
  return html.replace('/*__DATA__*/null', () => json);
}
