// 小改动（change）模式（用户决定的设计）：build 完成之后加小功能。
// 主会话与用户商量后写一个 1 到 3 个 task 的迷你计划，不走 P0/P1 批准，直接进 worker → reviewer → 合并 → 结束前程序强制一个"更新架构图与契约"的 doc task
// → stage-qa 全量确认。流程是单一阶段 X1 的轻流程（C-nnn），推进见 fix.ts 的 fixStep。
// 本文件：入口共用的 startChange（/forge-change 与 forge_change 工具）、交接说明与任务简介（纯函数）、"更新架构图与契约"任务的创建。
import type { FlowConfig } from '../core/state/config.ts';
import type { FlowFile, TaskFile } from '../core/state/schemas.ts';
import type { StateStore, TaskInput } from '../core/state/state-store.ts';
import { git } from '../core/state/git.ts';
import { isDocsUpdateTask } from '../core/state/state-machine.ts';
import { CHANGE_STAGE, checkChangePlan, type ChangePlanInput } from '../core/plan/change-plan.ts';
import { nextPlanTaskId } from '../core/state/paths.ts';
import { headSha } from '../core/workspace/worktree.ts';
import { stageBaseFor, stageDiffStat } from '../core/stage/stage-qa.ts';
import { fixRefusal } from './refusal.ts';

export const DOCS_UPDATE_TITLE = '更新架构图与契约';
/** 更新文档任务的可写范围（scope plan 允许这些路径） */
export const DOCS_UPDATE_WRITES = ['docs/arch/**', 'docs/contracts/**'];

export class ChangeStartError extends Error {}

// —— 纯函数 ——

const bullets = (items: readonly string[]) => items.map((a) => `- ${a}`).join('\n');

/** 每个 impl task 的交接说明：变更说明、本 task 的验收标准、要求 */
export function buildChangeHandoff(description: string, task: Pick<TaskInput, 'id' | 'title' | 'ac' | 'writes'>): string {
  const writes = (task.writes ?? []).filter((w) => !/^tests\/acceptance\//.test(w));
  return [
    '## 变更说明', description.trim() || task.title, '',
    `## 本 task：${task.id} ${task.title}`,
    '### 验收标准', bullets(task.ac ?? []) || '（无）', '',
    ...(writes.length ? ['### 计划改动的范围（用于调度；确实需要时可以越出，但不要大面积改动）', bullets(writes), ''] : []),
    '## 要求',
    '1. 先读 docs/arch/overview.md、rules/ 和 docs/contracts/，弄清现有架构、规则与接口，再动手。',
    `2. 按上面的验收标准实现，并为每条验收标准写测试（放在 tests/acceptance/${task.id}/）；全量测试保持通过。`,
    '3. 共享代码（公共模块、契约）只追加，不改已有行为。',
    '4. 改动超出计划范围太多，或需要修改已有契约时，用 forge_block 说明原因，不要自行扩大改动。',
  ].join('\n');
}

/** 流程简介（存为 flow brief，之后的确认任务与日志引用）：说明 + 任务清单 */
export function renderChangeBrief(input: ChangePlanInput, tasks: readonly Pick<TaskInput, 'id' | 'title' | 'ac' | 'depends_on'>[]): string {
  return [
    `# ${input.title.trim()}`, '',
    ...(input.description?.trim() ? [input.description.trim(), ''] : []),
    '## 任务清单',
    ...tasks.flatMap((t) => [
      `### ${t.id} ${t.title}`,
      ...(t.depends_on.length ? [`依赖：${t.depends_on.map((d) => `${d.task}（${d.type === 'hard' ? '硬' : '软'}）`).join('、')}`] : []),
      '验收标准：', bullets(t.ac ?? []), '',
    ]),
  ].join('\n');
}

/** "更新架构图与契约"任务的交接说明 */
export function buildDocsUpdateHandoff(description: string, range: { from: string; to: string }, stat: string): string {
  const r = `${range.from.slice(0, 8)}..${range.to.slice(0, 8)}`;
  return [
    `## ${DOCS_UPDATE_TITLE}`,
    '这次变更的所有 task 已合入主分支。', '',
    '## 变更说明', description.trim() || '（无）', '',
    `## 合入主分支的改动（${r}）`, stat.trim() ? '```\n' + stat.slice(0, 4000) + '\n```' : '（没有改动）', '',
    '## 要求',
    '1. 读上面的改动和相关代码，弄清这次变更对架构和接口的影响。',
    '2. 把 docs/arch/overview.md 与 docs/contracts/ 改到与代码一致：新增的模块、数据流、接口写进去，变化的改掉，删除的去掉。这里的契约可以修改，不只是追加。',
    '3. 确认确实不需要改时，不改任何文件直接 forge_submit（summary 写明原因），没有改动的提交视为完成。',
  ].join('\n');
}

// —— 流程 ——

/** 创建"更新架构图与契约"doc 任务（architect，scope plan）；改动统计取 flow.base_sha..主分支 HEAD */
export async function createDocsUpdateTask(c: { root: string; store: StateStore }, flowId: string): Promise<TaskFile> {
  const flow = c.store.readFlow(flowId);
  const tasks = c.store.listTasks(flowId);
  const from = stageBaseFor(c.root, tasks, CHANGE_STAGE, flow.base_sha);
  const to = headSha(c.root, flow.integration_branch);
  const id = nextPlanTaskId(tasks.map((t) => t.id));
  const input: TaskInput = {
    id, stage: CHANGE_STAGE, kind: 'doc', title: DOCS_UPDATE_TITLE, role: 'architect', scopes: ['plan'],
    depends_on: [], inputs: [], writes: [...DOCS_UPDATE_WRITES], verify: [],
  };
  const [t] = await c.store.addTasks(flowId, [input], 'engine');
  const brief = c.store.readFlowBrief(flowId).trim();
  await c.store.appendHandoff(flowId, id, buildDocsUpdateHandoff(brief || flow.title, { from, to }, stageDiffStat(c.root, from, to)), 'engine');
  return t!;
}

/** 流程里的"更新架构图与契约"任务（没有被取消的） */
export const docsUpdateTaskOf = (tasks: readonly TaskFile[]): TaskFile | undefined => tasks.find((t) => isDocsUpdateTask(t) && t.status !== 'cancelled');

export interface StartChangeDeps {
  root: string;
  store: StateStore;
  config: FlowConfig;
  /** 创建完成后推进流程（引擎的 pump）；测试可省略 */
  pump?(flowId: string): Promise<unknown>;
  /** 开流程前的依赖检查（命令入口提供；有错误时抛出，提醒写入 lines） */
  dependencyGate?(lines: string[]): void;
  /** 流程创建后、pump 之前执行（命令入口用来切换到调度模式） */
  afterCreate?(flow: FlowFile): Promise<unknown> | void;
}
export interface StartChangeOptions {
  /** 有 build 流程等待审批时是否直接继续 */
  yes: boolean;
  /** 需要确认时询问用户；没有则返回 needs_confirm */
  confirm?(text: string): Promise<boolean> | boolean;
}
export type StartChangeResult =
  | { kind: 'started'; flow: FlowFile; tasks: TaskFile[]; lines: string[] }
  | { kind: 'needs_confirm'; text: string }
  | { kind: 'cancelled' };

/** /forge-change 与 forge_change 共用：拒绝规则 → 依赖检查 → 校验迷你计划 → 建 C-nnn 流程与全部 impl task（带交接说明）→ pump */
export async function startChange(d: StartChangeDeps, input: ChangePlanInput, opts: StartChangeOptions): Promise<StartChangeResult> {
  const { store, config, root } = d;
  const open = store.openLightFlow();
  if (open) throw new ChangeStartError(`已有进行中的${open.mode === 'change' ? '小改动' : '修复'} ${open.id}「${open.title}」，同一时间只允许一个。请等它完成，或先 /forge abort。`);
  const refuse = fixRefusal(store, opts.yes, '小改动');
  if (refuse?.kind === 'error') throw new ChangeStartError(refuse.text);
  if (refuse?.kind === 'confirm') {
    if (!opts.confirm) return { kind: 'needs_confirm', text: refuse.text };
    if (!(await opts.confirm(refuse.text))) return { kind: 'cancelled' };
  }
  const lines: string[] = [];
  d.dependencyGate?.(lines);
  const verify = ['test'].filter((c) => config.commands[c]);
  const { errors, tasks: planned } = checkChangePlan(input, { maxTasks: config.limits.change_max_tasks ?? 3, scopes: config.role('worker').scopes, verify });
  if (errors.length) throw new ChangeStartError(`迷你计划未通过检查：\n${errors.map((e) => `- ${e}`).join('\n')}`);
  const main = config.raw.main_branch;
  const flow = await store.createLightFlow('change', input.title.trim().slice(0, 120), main, git(root, ['rev-parse', main]).trim());
  await store.saveFlowBrief(flow.id, renderChangeBrief(input, planned));
  const description = input.description?.trim() || input.title.trim();
  const tasks = await store.addTasks(flow.id, planned, 'engine');
  for (const t of planned) await store.appendHandoff(flow.id, t.id, buildChangeHandoff(description, t), 'engine');
  await d.afterCreate?.(flow);
  await d.pump?.(flow.id);
  lines.push(`已创建小改动 ${flow.id}「${flow.title}」，共 ${tasks.length} 个 task：${tasks.map((t) => t.id).join('、')}；实现者开始实施，审查、合并后由程序建“${DOCS_UPDATE_TITLE}”任务，最后 stage-qa 全量确认。`);
  return { kind: 'started', flow, tasks, lines };
}
