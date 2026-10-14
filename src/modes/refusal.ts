// 轻流程（fix、change）与 build/feature 流程的关系：开始前的拒绝规则（纯读状态）。/forge-fix、/forge-change、forge_change 共用。
import type { StateStore } from '../core/state/state-store.ts';

/**
 * build/feature 流程正在运行 → error；等待人工审批 → confirm（--yes 跳过）；没有进行中的流程 → null。
 * what：用户看到的动作名（修复、小改动）。
 */
export function fixRefusal(store: Pick<StateStore, 'readState' | 'readFlow'>, yes: boolean, what = '修复'): { kind: 'error' | 'confirm'; text: string } | null {
  const active = store.readState().active_flow;
  if (!active) return null;
  const f = store.readFlow(active);
  if (f.stage_status !== 'awaiting_human') {
    return { kind: 'error', text: `进行中的流程 ${f.id} 正在阶段 ${f.stage} 运行（${f.stage_status}），不能同时${what}。等它进入等待审批时再${what}，或把${what === '修复' ? '问题' : '改动'}作为该流程的一部分处理。` };
  }
  if (yes) return null;
  return { kind: 'confirm', text: `流程 ${f.id} 正在等待审批（阶段 ${f.stage}）。${what}会直接合入主分支，与该流程并行。` };
}
