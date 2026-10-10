// 来源：pi-flow src/core/scope.ts @ 31f3f15
// 运行中申请追加可写范围（第六轮 D3）：原来改范围要取消任务再新建。
// 不受保护、不敏感、在角色范围内、不与其他未完成任务的 writes/shared 重叠 → 程序直接批准；重叠或超出角色范围 → 主会话决定（forge_resolve_scope）。
import path from 'node:path';
import type { TaskFile } from './schemas.ts';
import { INTERFACES_PATH, PROTECTED_PATHS, SENSITIVE_PATHS, globWithin, globsOverlap } from './paths.ts';

export const SCOPE_KINDS = new Set<TaskFile['kind']>(['impl', 'fix']);
export const SCOPE_PATHS_MAX = 10;

export interface ScopeCheck { invalid: string[]; conflicts: { path: string; task: string }[]; outsideRole: string[] }

/** roleWrites：角色按 scopes 推导的可写范围；超出的不自动批准（交给主会话） */
export function checkScope(task: TaskFile, tasks: readonly TaskFile[], paths: readonly string[], roleWrites: readonly string[]): ScopeCheck {
  const invalid: string[] = [];
  const conflicts: ScopeCheck['conflicts'] = [];
  const outsideRole: string[] = [];
  for (const p of paths) {
    if (path.isAbsolute(p) || p.split('/').includes('..') || p.startsWith('./')) { invalid.push(`${p}：要写相对仓库根的路径或 glob（不带 ./ 与 ..）`); continue; }
    if (PROTECTED_PATHS.some((g) => globsOverlap(p, g))) { invalid.push(`${p}：受保护路径（${PROTECTED_PATHS.join('、')}）`); continue; }
    if (SENSITIVE_PATHS.some((g) => globsOverlap(p, g))) { invalid.push(`${p}：敏感文件`); continue; }
    if (globsOverlap(p, INTERFACES_PATH)) { invalid.push(`${p}：接口文档按约定只能追加，不用申请`); continue; }
    if (p === '**' || p === '*' || /^\*\*\/\*?$/.test(p)) { invalid.push(`${p}：范围太大，写具体的目录或文件`); continue; }
    if (!roleWrites.some((w) => globWithin(p, w))) outsideRole.push(p);
    for (const o of tasks) {
      if (o.id === task.id || o.status === 'done' || o.status === 'cancelled') continue;
      if ([...o.writes, ...(o.shared ?? [])].some((w) => globsOverlap(p, w))) conflicts.push({ path: p, task: o.id });
    }
  }
  return { invalid, conflicts, outsideRole };
}
