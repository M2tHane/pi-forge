// 小改动（change）模式的迷你计划校验（纯函数，不读写文件）：1 到 N 个 impl task，直接进 worker → reviewer → 合并流水线，不走 P0/P1。
// 复用 plan.ts 的 writes 禁区判断与 dag.ts 的环检测。
import type { TaskInput } from '../state/state-store.ts';
import { findCycle } from '../state/dag.ts';
import { ownAcceptanceGlob } from '../state/paths.ts';
import { forbiddenWriteOf } from './plan.ts';

export const CHANGE_STAGE = 'X1';

export interface ChangePlanInput {
  title: string;
  description?: string;
  tasks: {
    id?: string;
    title: string;
    writes: string[];
    depends_on?: { task: string; type: 'hard' }[];
    ac: string[];
    layers?: string[];
    module?: string;
  }[];
}

export interface ChangePlanOptions {
  maxTasks: number;
  /** 派生 task 的 scopes（worker 的 scopes） */
  scopes?: readonly string[];
  /** 派生 task 的 verify：workflow.yaml 里配置了的 typecheck / lint / test */
  verify?: readonly string[];
}

const blank = (s: unknown) => typeof s !== 'string' || !s.trim();

/** 校验迷你计划并派生 task（impl、worker、阶段 X1）；有错误时 tasks 为空 */
export function checkChangePlan(input: ChangePlanInput, opts: ChangePlanOptions): { errors: string[]; tasks: TaskInput[] } {
  const errors: string[] = [];
  if (blank(input.title)) errors.push('title 不能为空：用一句话写明这次要加什么');
  const given = Array.isArray(input.tasks) ? input.tasks : [];
  if (given.length < 1) errors.push('至少需要 1 个 task');
  if (given.length > opts.maxTasks) errors.push(`task 最多 ${opts.maxTasks} 个（limits.change_max_tasks），现在有 ${given.length} 个；改动更大时用 /forge-build 走完整流程`);

  // 编号：缺省按顺序 T-001…；给了必须是 T-数字且不重复
  const ids = given.map((t, i) => (blank(t.id) ? `T-${String(i + 1).padStart(3, '0')}` : t.id!.trim()));
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (!/^T-\d{3,}$/.test(id)) errors.push(`第 ${i + 1} 个 task 的编号 ${id} 必须写成 T-数字（例如 T-001）`);
    if (seen.has(id)) errors.push(`task 编号 ${id} 重复`);
    seen.add(id);
  });

  given.forEach((t, i) => {
    const id = ids[i]!;
    if (blank(t.title)) errors.push(`${id} 的 title 不能为空`);
    const acs = Array.isArray(t.ac) ? t.ac : [];
    if (!acs.length || acs.some(blank)) errors.push(`${id} 的 ac 不能为空：写明做到什么算完成（每条都要有内容）`);
    const writes = Array.isArray(t.writes) ? t.writes : [];
    if (!writes.length || writes.some(blank)) errors.push(`${id} 的 writes 不能为空：列出这个 task 要改的文件或目录`);
    for (const w of writes) {
      if (blank(w)) continue;
      const bad = forbiddenWriteOf(w);
      if (bad) errors.push(`${id} 的 writes ${w} 与 ${bad} 重叠：验收测试目录由程序派生（tests/acceptance/${id}/），规格、契约与规则不能由 task 直接改写（契约由结束前的“更新架构图与契约”任务处理）`);
    }
    for (const d of t.depends_on ?? []) {
      if (!ids.includes(d.task)) errors.push(`${id} 的 depends_on 引用了不存在的 task ${d.task}`);
      else if (d.task === id) errors.push(`${id} 不能依赖自己`);
      if (d.type !== 'hard') errors.push(`${id} 对 ${d.task} 的依赖类型必须是 hard`);
    }
  });

  const cycle = findCycle(given.map((t, i) => ({ id: ids[i]!, depends_on: (t.depends_on ?? []).map((d) => ({ task: d.task, type: d.type })) })));
  if (cycle) errors.push(`依赖存在环：${cycle.join(' -> ')}`);
  if (errors.length) return { errors, tasks: [] };

  const tasks = given.map((t, i): TaskInput => {
    const id = ids[i]!;
    return {
      id, stage: CHANGE_STAGE, kind: 'impl', title: t.title.trim().slice(0, 200), role: 'worker', scopes: [...(opts.scopes ?? [])],
      depends_on: (t.depends_on ?? []).map((d) => ({ task: d.task, type: d.type })), inputs: [],
      writes: [...new Set([...t.writes.map((w) => w.trim()), ownAcceptanceGlob(id)])], verify: [...(opts.verify ?? [])],
      ac: t.ac.map((a) => a.trim()),
      ...(t.layers?.length ? { layers: [...t.layers] } : {}),
      ...(t.module ? { module: t.module } : {}),
    };
  });
  return { errors, tasks };
}
