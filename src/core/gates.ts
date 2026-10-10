// 来源：pi-flow src/core/gates.ts @ 31f3f15
// 阶段闸门（第 8 节 gate）：all_tasks_done、S1/F1 必须有任务提案、在集成分支 HEAD 上执行 auto 命令并保存 evidence。
// 通过后：需要人工 → awaiting_human；否则 → done。最后一个阶段一律需要人工（之后合入主分支）。
import { specGateLint } from './spec-flow.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import { isSettled } from './state-machine.ts';
import type { StateStore } from './state-store.ts';
import { git } from './git.ts';
import { worktreesRoot, removeWorktree } from './worktree.ts';
import { evidenceText, failureSummary, runShell } from './verify-runner.ts';

import type { StageDeps } from './stages.ts';
import type { TaskFile } from './schemas.ts';
import type { TaskInput } from './state-store.ts';
import { nextTaskId } from './stages.ts';
import { matchesAny } from './paths.ts';

const nextIds = (tasks: readonly TaskFile[], n: number) => {
  const first = Math.max(0, ...tasks.map((t) => Number(t.id.match(/^T-(\d+)/)?.[1] ?? 0))) + 1;
  return Array.from({ length: n }, (_, i) => `T-${String(first + i).padStart(3, '0')}`);
};

/** failed：失败的闸门命令与输出；引擎据此生成有限轮次的修复任务。 */
export interface GateOutcome { stage: string; passed: boolean; needsHuman: boolean; reasons: string[]; failed?: { command: string; output: string } }

export function stageDef(config: FlowConfig, mode: 'build' | 'feature', stage: string) {
  const def = config.raw.modes[mode]?.stages.find((s) => s.id === stage);
  if (def) return def;
  const gate = config.raw.implementation_gate;
  return { id: stage, phase: 'implementation' as const, gate: {
    auto: (gate?.auto ?? []).filter((name) => !!config.commands[name]?.trim()),
    human: gate?.human ?? true,
  } };
}

export async function runStageGate(root: string, store: StateStore, config: FlowConfig, flowId: string, timeoutMs?: number): Promise<GateOutcome> {
  const flow = store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_gate') throw new Error(`阶段 ${flow.stage} 不在 awaiting_gate 状态`);
  if (flow.mode === 'fix') throw new Error('fix 流程不使用阶段闸门');
  if (flow.stage === 'P0') {
    const lint = specGateLint(root, flow);
    const reasons = lint.errors.map((i) => i.message);
    const passed = reasons.length === 0;
    await store.transitionStage(flowId, { to: passed ? 'awaiting_human' : 'active', trigger: passed ? 'gate_passed' : 'gate_failed', actor: 'gate', needs_human: true,
      ...(reasons.length ? { reason: reasons.join('\n') } : {}),
      spec: { ...flow.spec, submitted: passed, errors: reasons, warnings: lint.warnings.map((i) => i.message) } });
    return { stage: 'P0', passed, needsHuman: true, reasons };
  }
  const def = stageDef(config, flow.mode, flow.stage);
  const isLast = flow.stage === flow.stages.at(-1);
  const needsHuman = !!def.gate.human || isLast;
  const reasons: string[] = [];
  let failed: GateOutcome['failed'];

  const open = store.listTasks(flowId).filter((t) => t.stage === flow.stage && !isSettled(t));
  if (open.length) reasons.push(`本阶段还有未完成的任务：${open.map((t) => `${t.id}（${t.status}）`).join('、')}`);


  if (!reasons.length && def.gate.auto?.length) {
    const wt = path.join(worktreesRoot(root), `${flowId}-gate-${flow.stage}`);
    mkdirSync(path.dirname(wt), { recursive: true });
    removeWorktree(root, wt);
    git(root, ['worktree', 'add', '-q', '--detach', wt, flow.integration_branch]);
    try {
      for (const name of def.gate.auto) {
        const shell = config.commands[name]!;
        const r = { command: name, ...(await runShell(shell.replace('{files}', '').trim(), wt, timeoutMs)) };
        await store.saveStageEvidence(flowId, flow.stage, `gate-${name}.log`, evidenceText(r, shell), 'gate');
        if (r.exit_code !== 0) {
          reasons.push(`闸门命令 ${name} 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1200)}`);
          failed = { command: name, output: r.output };
          break;
        }
      }
    } finally {
      removeWorktree(root, wt);
    }
  }

  const passed = reasons.length === 0;
  if (passed) {
    await store.transitionStage(flowId, { to: needsHuman ? 'awaiting_human' : 'done', trigger: 'gate_passed', actor: 'gate', needs_human: needsHuman });
  } else if ((flow.gate_rounds ?? []).filter((r) => r.stage === flow.stage).length >= MAX_GATE_ROUNDS) {
    await store.transitionStage(flowId, { to: 'needs_human', trigger: 'gate_exhausted', actor: 'gate', reason: reasons.join('；') });
  } else {
    await store.transitionStage(flowId, { to: 'active', trigger: 'gate_failed', actor: 'gate', reason: reasons.join('；') });
  }
  return { stage: flow.stage, passed, needsHuman, reasons, ...(failed ? { failed } : {}) };
}

/** 本阶段最近一次闸门失败之后，是否还没有任何任务状态变化（避免对同样的结果反复跑闸门） */
export function gateFailedWithoutChange(store: StateStore, flowId: string, stage: string): boolean {
  const events = store.readEvents().filter((e) => e.flow === flowId);
  const lastFail = [...events].reverse().find((e) => e.type === 'gate_result' && e.to === 'active' && e.data?.['stage'] === stage);
  if (!lastFail) return false;
  const stageTasks = new Set(store.listTasks(flowId).filter((t) => t.stage === stage).map((t) => t.id));
  return !events.some((e) => e.seq > lastFail.seq && e.type === 'transition' && e.task && stageTasks.has(e.task));
}

// M6 由 stage-qa 取代：暂时保留 HEAD 的有限门禁修复。
export const MAX_GATE_ROUNDS = 2;
/** 从失败输出中找出仓库里的文件（测试文件、报错位置） */
export function failingFiles(output: string, tracked: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/[\w@.\-/]+\.[A-Za-z0-9]+/g)) {
    let p = m[0].replace(/^\.\//, '');
    if (!tracked.has(p)) {
      const parts = p.split('/');
      p = parts.map((_, i) => parts.slice(i).join('/')).find((x) => tracked.has(x)) ?? '';
    }
    if (p) out.add(p);
  }
  return [...out].slice(0, 20);
}

function safeGit(cwd: string, args: string[]): string {
  try { return git(cwd, args).trim(); } catch { return ''; }
}

/**
 * 闸门的全量测试失败：日志涉及的文件交给写过它的模块修复（每个模块一个任务，fork 原会话）。
 * 返回生成的任务 id；已修两轮或定位不到模块时返回空数组并给出原因（由调用方提示用户）。
 */
export async function gateFailed(d: StageDeps, flowId: string, failed: { command: string; output: string }): Promise<{ tasks: string[]; reason?: string }> {
  const { store } = d;
  const flow = store.readFlow(flowId);
  const rounds = (flow.gate_rounds ?? []).filter((r) => r.stage === flow.stage);
  if (rounds.length >= MAX_GATE_ROUNDS) return { tasks: [], reason: `全量 ${failed.command} 自动修复 ${MAX_GATE_ROUNDS} 轮后仍失败` };
  const tracked = new Set(safeGit(d.root, ['ls-tree', '-r', '--name-only', flow.integration_branch]).split('\n').filter(Boolean));
  const files = failingFiles(failed.output, tracked);
  const tasks = store.listTasks(flowId);
  const mods = tasks.filter((t) => t.stage === flow.stage && ['impl', 'fix'].includes(t.kind) && t.status === 'done');
  const groups = new Map<string, Set<string>>();
  for (const f of files) {
    const owner = mods.find((t) => matchesAny(f, t.writes)) ?? mods.find((t) => matchesAny(f, t.shared ?? []));
    if (owner) groups.set(owner.id, (groups.get(owner.id) ?? new Set()).add(f));
  }
  if (!groups.size) return { tasks: [], reason: `全量 ${failed.command} 失败，但无法从日志定位负责的模块` };
  const round = rounds.length + 1;
  const ids = nextIds(tasks, groups.size);
  const tail = failed.output.trim().split('\n').slice(-60).join('\n').slice(-4000);
  const inputs: TaskInput[] = [];
  const handoffs: Record<string, string> = {};
  [...groups].forEach(([modId, fs], n) => {
    const mod = mods.find((t) => t.id === modId)!;
    const id = ids[n]!;
    inputs.push({
      id, stage: flow.stage, kind: 'fix', role: mod.role, scopes: [...mod.scopes], depends_on: [], inputs: [...fs],
      writes: [...mod.writes], ...(mod.shared?.length ? { shared: [...mod.shared] } : {}), verify: [...mod.verify],
      title: `修复全量 ${failed.command} 失败（第 ${round} 轮）：${[...fs].slice(0, 3).join('、')}`.slice(0, 200),
      ac: [`实施阶段闸门的全量 ${failed.command} 失败，日志涉及 ${[...fs].join('、')}：找到原因并修复，修好后全量 ${failed.command} 通过`,
        '原因不在你的可写范围内时，用 forge_block 写明是哪个模块、什么输入、期望与实际'],
      fork_from_task: mod.id, for_task: mod.id,
    });
    handoffs[id] = `实施阶段的全量测试失败（程序生成，第 ${round}/${MAX_GATE_ROUNDS} 轮）。\n命令：${failed.command}\n输出（最后部分）：\n\`\`\`\n${tail}\n\`\`\``;
  });
  await store.addGateRound(flowId, { stage: flow.stage, command: failed.command, tasks: ids, at: new Date().toISOString() }, inputs, handoffs);
  return { tasks: ids };
}
