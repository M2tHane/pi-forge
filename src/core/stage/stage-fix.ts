// 阶段验收发现的问题交给负责的 task 修复（规格第 11.1 节）：门禁失败、stage-qa 的 must、精简模式阶段审查的 must 共用。
// 归属按 task 而不是按角色（pi-flow 的 gateFailed 按角色分组）：文件归"最后一个 writes 覆盖了它并且已经 done 的 impl task"。
import type { TaskFile } from '../state/schemas.ts';
import type { StateStore, TaskInput } from '../state/state-store.ts';
import { matchesAny, ownAcceptanceGlob } from '../state/paths.ts';
import { nextFixId } from '../acceptance/acceptance-flow.ts';

export type StageFixSource = 'gate' | 'qa' | 'review';
/**
 * 一个问题：涉及的文件与给 worker 的说明。
 * owner：直接指定负责的 impl task（跳过 ownerOf 查找，例如验收测试目录 tests/acceptance/<T-xxx>/ 的失败，worker 不能写测试）；
 * writes：指定时，该组的可写范围用它代替 files（owner 的 writes）。
 */
export interface StageIssue { files: readonly string[]; text: string; owner?: string; writes?: readonly string[] }

const SOURCE_LABEL: Record<StageFixSource, string> = { gate: '阶段门禁', qa: 'stage-qa', review: '阶段审查' };

/** task 没有时间戳：按编号排序（T-003 < T-010；T-003.fx-2 < T-003.fx-10） */
const idKey = (id: string) => [Number(/^T-(\d+)/.exec(id)?.[1] ?? 0), Number(/\.fx-(\d+)$/.exec(id)?.[1] ?? 0)] as const;
const createdOrder = (a: Pick<TaskFile, 'id'>, b: Pick<TaskFile, 'id'>) => { const [x, y] = [idKey(a.id), idKey(b.id)]; return x[0] - y[0] || x[1] - y[1]; };

/**
 * fix 额外带上的、原 impl task 自己的测试写权限（纯函数）：writes 里 tests/ 下非验收的 glob（单元、e2e、契约测试等），
 * 审查要求补回归测试时 worker 才写得进去。tests/acceptance/** 永远不带；只有 test_author 为 false（偏离 81）、
 * impl 自己写验收测试时，才保留它自己的验收目录。
 */
export function testWritesOf(impl: Pick<TaskFile, 'id' | 'writes'>): string[] {
  const own = ownAcceptanceGlob(impl.id);
  return impl.writes.filter((g) => g === own || (g.startsWith('tests/') && !g.startsWith('tests/acceptance')));
}

/** 文件的负责 task：writes 覆盖它、已经 done 的 impl task 中编号最大的一个；找不到时为 undefined（纯函数） */
export function ownerOf<T extends Pick<TaskFile, 'id' | 'kind' | 'status' | 'writes'>>(file: string, tasks: readonly T[]): T | undefined {
  return tasks.filter((t) => t.kind === 'impl' && t.status === 'done' && matchesAny(file, t.writes)).sort(createdOrder).at(-1);
}

/** 修复要接着的会话：该 impl 最近一个已 done 的 .fx-n，没有时是 impl 本身（纯函数） */
export function lastWorkerTask<T extends Pick<TaskFile, 'id' | 'kind' | 'status' | 'for_task'>>(impl: string, tasks: readonly T[]): string {
  return tasks.filter((t) => t.kind === 'fix' && t.for_task === impl && t.status === 'done').sort(createdOrder).at(-1)?.id ?? impl;
}

/**
 * 按负责的 task 分组（纯函数）：一个问题涉及几个 task 的文件时拆到各自的组里，每组只带自己的文件。
 * unowned：找不到负责 task 的文件（调用方提示用户）。
 */
export function groupIssuesByOwner<T extends Pick<TaskFile, 'id' | 'kind' | 'status' | 'writes'>>(issues: readonly StageIssue[], tasks: readonly T[]): { groups: Map<string, { files: Set<string>; texts: string[] }>; unowned: string[] } {
  const groups = new Map<string, { files: Set<string>; texts: string[] }>();
  const unowned = new Set<string>();
  for (const issue of issues) {
    const byOwner = new Map<string, string[]>();
    if (issue.owner) {
      if (tasks.some((t) => t.id === issue.owner && t.kind === 'impl')) byOwner.set(issue.owner, [...(issue.writes ?? issue.files)]);
      else for (const f of issue.files) unowned.add(f);
    } else for (const f of issue.files) {
      const owner = ownerOf(f, tasks);
      if (!owner) { unowned.add(f); continue; }
      byOwner.set(owner.id, [...(byOwner.get(owner.id) ?? []), f]);
    }
    for (const [id, files] of byOwner) {
      const g = groups.get(id) ?? { files: new Set<string>(), texts: [] };
      files.forEach((f) => g.files.add(f));
      g.texts.push(issue.text);
      groups.set(id, g);
    }
  }
  return { groups, unowned: [...unowned] };
}

/**
 * 为阶段验收发现的问题创建 fix task（T-003.fx-n）：kind fix、角色同原 task（worker）、writes 是问题涉及的文件加原 task 的非验收测试目录、
 * fork 原 task 最后一次 worker 会话。worktree 在派发时从集成分支新建。没有新的 .at，不做逐任务审查，合并时跑全量（第 11.1 节）。
 */
export async function createStageFixTasks(store: StateStore, flowId: string, source: StageFixSource, issues: readonly StageIssue[], round: string, actor = 'engine', sourceRound?: { task: string; round: number }): Promise<{ tasks: string[]; unowned: string[] }> {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const { groups, unowned } = groupIssuesByOwner(issues, tasks);
  const inputs: TaskInput[] = [];
  const briefs: Record<string, string> = {};
  const taken: Pick<TaskFile, 'id'>[] = [...tasks];
  for (const [implId, g] of groups) {
    const impl = tasks.find((t) => t.id === implId)!;
    const id = nextFixId(taken, implId);
    taken.push({ id });
    const files = [...g.files].sort();
    const writes = [...new Set([...files, ...testWritesOf(impl)])];
    inputs.push({
      id, stage: flow.stage, kind: 'fix', role: impl.role, scopes: [...impl.scopes], depends_on: [], inputs: [],
      writes, verify: [...impl.verify], for_task: implId, fork_from_task: lastWorkerTask(implId, tasks),
      title: `修复${SOURCE_LABEL[source]}的问题（${round}）：${files.slice(0, 3).join('、')}`.slice(0, 200),
      ac: [`修复${SOURCE_LABEL[source]}指出的问题，修好后原 task 的验收测试与单元测试通过`, '原因不在这些文件里时，用 forge_block 写明是哪个模块、什么输入、期望与实际'],
      ...(impl.module ? { module: impl.module } : {}),
      ...(impl.layers?.length ? { layers: [...impl.layers] } : {}),
      ...(sourceRound ? { source_round: { ...sourceRound } } : {}),
    });
    briefs[id] = [`## ${SOURCE_LABEL[source]}发现的问题（程序生成，${round}）`, `可写范围只有问题涉及的文件${writes.length > files.length ? '与原 task 的测试目录' : ''}：${writes.join('、')}`, '', ...g.texts.map((x) => x.trim())].join('\n').slice(0, 12000);
  }
  if (!inputs.length) return { tasks: [], unowned };
  await store.addTasks(flowId, inputs, actor);
  for (const [id, brief] of Object.entries(briefs)) await store.appendHandoff(flowId, id, brief, actor);
  return { tasks: inputs.map((t) => t.id), unowned };
}

/**
 * 精简模式的跨阶段接续（规格第 7.6 节）：lean 流程里，没有 fork_from_task 的 impl task 接着上一阶段 impl 的最后一次 worker 会话。
 * 上一阶段没有 done 的 impl（例如上一阶段是 P1）、不是 lean、或不是 impl 时返回 null（纯函数）。
 * 会话大小、模型、continue_session 开关由 dispatcher 的 forkSource 再判断，不满足时从头开始。
 */
export function leanForkFrom<T extends Pick<TaskFile, 'id' | 'kind' | 'status' | 'stage' | 'for_task'>>(
  planMode: 'standard' | 'lean' | undefined, task: Pick<TaskFile, 'kind' | 'stage' | 'fork_from_task'>, stages: readonly string[], tasks: readonly T[],
): string | null {
  if (planMode !== 'lean' || task.kind !== 'impl' || task.fork_from_task) return null;
  const idx = stages.indexOf(task.stage);
  if (idx <= 0) return null;
  const prev = tasks.filter((t) => t.kind === 'impl' && t.stage === stages[idx - 1] && t.status === 'done').sort(createdOrder).at(-1);
  return prev ? lastWorkerTask(prev.id, tasks) : null;
}
