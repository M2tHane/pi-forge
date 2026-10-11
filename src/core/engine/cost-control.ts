// 来源：pi-flow src/core/cost-control.ts @ 31f3f15
// 成本控制：失败后升级模型；流程预算。全部由程序按 workflow.yaml 判定。
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import type { FlowFile, RoleSettingsFile, TaskFile } from '../state/schemas.ts';
import { activeMinutes } from '../ops/forge-watch.ts';

const isPlaceholder = (m: string) => /^<.*>$/.test(m.trim());

/** 档位名或 provider/model → provider/model；档位未填写（占位符）时返回 null */
export function resolveModelRef(config: FlowConfig, ref: string | undefined): string | null {
  if (!ref) return null;
  if (ref.includes('/')) return isPlaceholder(ref) ? null : ref;
  const m = config.raw.models[ref];
  return m && !isPlaceholder(m) ? m : null;
}

const TIER_ORDER = ['cheap', 'medium', 'strong'];

export function escalationPolicy(config: FlowConfig): { enabled: boolean; afterFailures: number; criticalFanout: number } {
  const e = config.raw.escalation ?? {};
  return { enabled: e.enabled ?? true, afterFailures: e.after_failures ?? 2, criticalFanout: e.critical_fanout ?? 3 };
}

/** 直接硬依赖这个任务的任务数（不含已取消的） */
export function hardFanout(t: TaskFile, tasks: readonly TaskFile[]): number {
  return tasks.filter((x) => x.status !== 'cancelled' && x.depends_on.some((d) => d.type === 'hard' && d.task === t.id)).length;
}

/**
 * 角色的升级模型：/forge-config 的 escalate_model > workflow.yaml 的 roles.<role>.escalate_model > 角色档位的上一档。
 * 取不到（或与原模型相同）时返回 null，不升级。
 */
export function escalationModel(config: FlowConfig, settings: RoleSettingsFile, role: string, current: string): string | null {
  const s = settings.roles[role]?.escalate_model;
  const tier = config.role(role).modelTier;
  const next = TIER_ORDER.indexOf(tier) >= 0 ? TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] : undefined;
  const m = s ?? resolveModelRef(config, config.raw.roles[role]?.escalate_model) ?? resolveModelRef(config, next);
  return m && m !== current ? m : null;
}

// —— I：预算 ——

export interface BudgetState {
  tokens: { limit: number; used: number } | null;
  cost: { limit: number; used: number; missing: number } | null;
  minutes: { limit: number; used: number } | null;
  ratio: number;
  warn: boolean;
  exceeded: boolean;
  warnRatio: number;
}

/** 流程预算：/forge budget 设置的值覆盖 workflow.yaml；用量来自 .forge/runs（tokens 计输入 + 输出，不含缓存）；分钟数来自阶段事件（不含等用户的时间） */
export function budgetState(store: StateStore, config: FlowConfig, flow: FlowFile, now = new Date()): BudgetState | null {
  const b = { ...config.raw.budget, ...flow.budget };
  if (!b.tokens && !b.cost && !b.minutes) return null;
  const runs = store.listRuns().filter((r) => r.flow === flow.id);
  const usedTokens = runs.reduce((n, r) => n + (r.tokens.input ?? 0) + (r.tokens.output ?? 0), 0);
  const usedCost = runs.reduce((n, r) => n + (r.cost ?? 0), 0);
  const missing = runs.filter((r) => r.ended_at && (r.cost === undefined || r.cost === null)).length;
  const tokens = b.tokens ? { limit: b.tokens, used: usedTokens } : null;
  const cost = b.cost ? { limit: b.cost, used: usedCost, missing } : null;
  const minutes = b.minutes ? { limit: b.minutes, used: activeMinutes(flow, store.readEvents(), now) } : null;
  const ratio = Math.max(tokens ? tokens.used / tokens.limit : 0, cost ? cost.used / cost.limit : 0, minutes ? minutes.used / minutes.limit : 0);
  const warnRatio = config.raw.budget?.warn_ratio ?? 0.8;
  return { tokens, cost, minutes, ratio, warn: ratio >= warnRatio, exceeded: ratio >= 1, warnRatio };
}

export function formatBudget(b: BudgetState): string {
  const parts = [
    ...(b.tokens ? [`token ${b.tokens.used.toLocaleString('en-US')} / ${b.tokens.limit.toLocaleString('en-US')}`] : []),
    ...(b.cost ? [`金额 ${b.cost.used.toFixed(4)} / ${b.cost.limit}${b.cost.missing ? `（${b.cost.missing} 次运行没有报告金额，未计入）` : ''}`] : []),
    ...(b.minutes ? [`时间 ${Math.round(b.minutes.used)} / ${b.minutes.limit} 分钟（不含等你的时间）`] : []),
  ];
  return `预算：${parts.join('；')}，已用 ${Math.round(b.ratio * 100)}%${b.exceeded ? '，已超出：暂停派发新任务' : b.warn ? '，接近上限' : ''}`;
}
