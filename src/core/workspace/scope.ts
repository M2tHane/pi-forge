// 来源：pi-flow src/core/scope.ts @ 31f3f15
// 运行中申请追加可写范围（第六轮 D3）：原来改范围要取消任务再新建。
// 不受保护、不敏感、在角色范围内、不与其他未完成任务的 writes/shared 重叠 → 程序直接批准；重叠或超出角色范围 → 主会话决定（forge_resolve_scope）。
// pi-forge（第 14 节）：验收测试、规格、契约是硬限制；与已开工的 task 重叠直接拒绝，只与 pending、ready 重叠的才交给主会话。
import path from 'node:path';
import type { TaskFile } from '../state/schemas.ts';
import { INTERFACES_PATH, PROTECTED_PATHS, SENSITIVE_PATHS, globWithin, globsOverlap } from '../state/paths.ts';

export const SCOPE_KINDS = new Set<TaskFile['kind']>(['impl', 'fix']);
export const SCOPE_PATHS_MAX = 10;

/** 第 14 节：主会话也不能批准的路径 */
export const SCOPE_HARD_LIMITS = ['tests/acceptance/**', 'docs/spec/**'];
/** 已开工、还没 done 的状态：与它们的范围重叠时直接拒绝（第 14 节） */
export const STARTED_STATUSES: readonly TaskFile['status'][] = ['in_progress', 'awaiting_inputs', 'checking', 'in_review', 'disputed', 'queued_merge', 'merging'];

export interface ScopeCheck {
  invalid: string[];
  /** 与已开工 task 重叠：直接拒绝 */
  started: { path: string; task: string }[];
  /** 只与 pending、ready（及阻塞中）的 task 重叠：主会话决定，派发时的互斥检查会让它们排队 */
  conflicts: { path: string; task: string }[];
  outsideRole: string[];
}

/** roleWrites：角色按 scopes 推导的可写范围；超出的不自动批准（交给主会话） */
export function checkScope(task: TaskFile, tasks: readonly TaskFile[], paths: readonly string[], roleWrites: readonly string[]): ScopeCheck {
  const invalid: string[] = [];
  const started: ScopeCheck['started'] = [];
  const conflicts: ScopeCheck['conflicts'] = [];
  const outsideRole: string[] = [];
  for (const p of paths) {
    if (path.isAbsolute(p) || p.split('/').includes('..') || p.startsWith('./')) { invalid.push(`${p}：要写相对仓库根的路径或 glob（不带 ./ 与 ..）`); continue; }
    if (PROTECTED_PATHS.some((g) => globsOverlap(p, g))) { invalid.push(`${p}：受保护路径（${PROTECTED_PATHS.join('、')}）`); continue; }
    if (globsOverlap(p, 'tests/acceptance/**')) { invalid.push(`${p}：验收测试只由 test-author 编写；认为测试写错时用 forge_dispute`); continue; }
    if (globsOverlap(p, 'docs/spec/**')) { invalid.push(`${p}：规格只能经规格修订改动`); continue; }
    if (SENSITIVE_PATHS.some((g) => globsOverlap(p, g))) { invalid.push(`${p}：敏感文件`); continue; }
    if (globsOverlap(p, INTERFACES_PATH)) { invalid.push(`${p}：契约只能追加本模块的内容，不用申请；别的模块的契约文件不能改`); continue; }
    if (p === '**' || p === '*' || /^\*\*\/\*?$/.test(p)) { invalid.push(`${p}：范围太大，写具体的目录或文件`); continue; }
    if (!roleWrites.some((w) => globWithin(p, w))) outsideRole.push(p);
    for (const o of tasks) {
      if (o.id === task.id || o.status === 'done' || o.status === 'cancelled') continue;
      if (![...o.writes, ...(o.shared ?? [])].some((w) => globsOverlap(p, w))) continue;
      (STARTED_STATUSES.includes(o.status) ? started : conflicts).push({ path: p, task: o.id });
    }
  }
  return { invalid, started, conflicts, outsideRole };
}
