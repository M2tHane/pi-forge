// 架构师咨询：子 agent 或主会话用 forge_ask_architect 提问 → 程序建 consult 任务（architect，串行、不审查）
// → architect 接着它最近一次的会话回答，用 forge_answer 提交（有改动时经合并队列合入集成分支）
// → 子 agent 的任务：回答写进 handoff、集成分支同步进它的 worktree，接着原会话继续；主会话：下一次 forge_wait 返回回答。
import { existsSync, readFileSync } from 'node:fs';
import type { FlowConfig } from '../state/config.ts';
import type { TaskFile } from '../state/schemas.ts';
import { evidenceRel, type StateStore } from '../state/state-store.ts';
import { IN_FLIGHT } from '../state/state-machine.ts';
import { nextPlanTaskId } from '../state/paths.ts';
import { readRel } from '../plan/plan-flow.ts';
import { syncTaskInputs } from '../../tools/module-tools.ts';

export type AskKind = 'answer' | 'change';
export const ANSWER_FILE = 'answer.md';
export const DECISIONS_PATH = 'docs/arch/decisions.md';
/** 任务说明里带的 decisions.md 最多这么多字（取最近的部分） */
const DECISIONS_TAIL = 12_000;

const KIND_TEXT: Record<AskKind, string> = { answer: 'answer（只要回答）', change: 'change（要求修改公共内容或契约）' };

export function consultBrief(question: string, kind: AskKind, asker: Pick<TaskFile, 'id' | 'title' | 'role'> | null): string {
  return [
    '# 架构师咨询',
    `提问方：${asker ? `${asker.id}「${asker.title}」（${asker.role}）` : '主会话（转达用户的问题）'}`,
    `类型：${KIND_TEXT[kind]}`,
    '', '## 问题', question.trim(), '',
    '## 做法',
    '- 先读相关的代码与文档再回答，结论放在最前面。',
    `- ${kind === 'change' ? '需要修改公共代码、契约或文档时直接在本 worktree 里改，跑相关测试；改动随回答提交，经合并队列合入集成分支，程序再同步给提问方。' : '只需回答；发现确实要改公共内容才顺带修改（同样随回答提交）。'}`,
    `- 在 ${DECISIONS_PATH} 末尾追加一条记录：提问方、问题、结论、改了哪些文件。`,
    '- 最后用 forge_answer 提交给提问方的回答（写清楚结论、改了哪些文件、提问方接下来怎么做）。',
  ].join('\n');
}

/** 新建 consult 任务（写好任务说明）；子 agent 提问时调用方随后把它的任务转为"等架构师"（先建咨询，程序步骤不会看到等待却找不到咨询的任务） */
export async function createConsult(store: StateStore, config: FlowConfig, flowId: string, question: string, kind: AskKind, asker: TaskFile | null, actor: string): Promise<TaskFile> {
  const flow = store.readFlow(flowId);
  const id = nextPlanTaskId(store.listTasks(flowId).map((t) => t.id));
  const [task] = await store.addTasks(flowId, [{
    id, stage: flow.stage, kind: 'consult', role: 'architect', title: `咨询：${question.replace(/\s+/g, ' ').slice(0, 80)}`,
    scopes: [...config.role('architect').scopes], depends_on: [], inputs: [], writes: ['**', 'rules/**'], verify: [],
    ...(asker ? { for_task: asker.id } : {}),
  }], actor);
  await store.appendHandoff(flowId, id, consultBrief(question, kind, asker), actor);
  return task!;
}

const byId = (a: Pick<TaskFile, 'id'>, b: Pick<TaskFile, 'id'>) => Number(a.id.slice(2)) - Number(b.id.slice(2));

/**
 * 同一时间只有一个架构师在写：有 architect 的任务在途（含咨询、S0 架构、它的修复）时，就绪的咨询都先不派；
 * 否则只放行编号最小的一个。返回要暂缓派发的咨询任务编号（纯函数）。
 */
export function heldConsults(tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'role' | 'status'>[]): Set<string> {
  const ready = tasks.filter((t) => t.kind === 'consult' && t.status === 'ready').sort(byId);
  const busy = tasks.some((t) => t.role === 'architect' && IN_FLIGHT.includes(t.status));
  return new Set((busy ? ready : ready.slice(1)).map((t) => t.id));
}

/** 咨询任务接着的会话：本流程里 architect 最近一次正常结束的运行所属的任务（S0 架构、它的修复或上一个咨询） */
export function lastArchitectTask(store: StateStore, flowId: string, exclude: string): string | null {
  const kinds = new Set(['impl', 'fix', 'consult']);
  const runs = store.listRuns().filter((r) => r.flow === flowId && r.role === 'architect' && r.ended_at && r.task !== exclude && (r.outcome === 'submitted' || r.outcome === 'timeout'))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  for (const r of runs.reverse()) {
    const id = r.task;
    if (!id) continue;
    try { if (kinds.has(store.readTask(flowId, id).kind)) return id; } catch { /* 任务已不存在 */ }
  }
  return null;
}

/** 开新会话时放进咨询任务说明的 decisions.md（集成分支上的，取最近部分）；没有时返回空串 */
export function decisionsSection(root: string, store: StateStore, flowId: string): string {
  const text = readRel({ root, ref: store.readFlow(flowId).integration_branch }, DECISIONS_PATH)?.trim();
  if (!text) return '';
  return `## 之前的架构决定（${DECISIONS_PATH}${text.length > DECISIONS_TAIL ? '，只保留最近部分' : ''}）\n这次是新会话，先看这些记录了解之前回答过什么、改过什么。\n\n${text.slice(-DECISIONS_TAIL)}`;
}

export function readAnswer(store: StateStore, flowId: string, consultId: string): string | null {
  const abs = store.abs(`${evidenceRel(flowId, consultId)}/${ANSWER_FILE}`);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/** 提问任务最近一次提问对应的咨询任务 */
export const latestConsultOf = (tasks: readonly TaskFile[], askerId: string): TaskFile | undefined =>
  tasks.filter((t) => t.kind === 'consult' && t.for_task === askerId).sort(byId).at(-1);

/**
 * 程序步骤：咨询结束（done 或被取消）后恢复在等它的任务——回答写进 handoff，集成分支同步进 worktree，
 * 任务回到 in_progress（没有租约），由引擎接着原会话重新派发。返回恢复的任务。
 */
export async function resolveConsults(store: StateStore, flowId: string): Promise<string[]> {
  const out: string[] = [];
  const tasks = store.listTasks(flowId);
  for (const asker of tasks.filter((t) => t.status === 'blocked' && t.blocked_by === 'architect')) {
    const c = latestConsultOf(tasks, asker.id);
    if (!c || (c.status !== 'done' && c.status !== 'cancelled')) continue;
    const answer = c.status === 'done' ? readAnswer(store, flowId, c.id)?.trim() : null;
    const notes = [answer ? `架构师的回答（${c.id}）：\n${answer}` : `架构师没有回答你的问题（咨询任务 ${c.id} ${c.status === 'cancelled' ? '已取消' : '没有留下回答'}）：自己判断能否继续，做不下去用 forge_block 说明。`];
    if (asker.worktree && asker.base_sha) {
      const synced = await syncTaskInputs(store, flowId, asker);
      notes.push(synced.conflicts.length
        ? `程序把集成分支同步进你的工作区时有冲突，冲突标记留在：${synced.conflicts.join('、')}。先解决冲突，再调用 forge_sync 完成同步。`
        : '程序已把集成分支（含架构师的修改）同步进你的工作区。');
    }
    await store.appendHandoff(flowId, asker.id, notes.join('\n\n'), 'engine');
    await store.transitionTask(flowId, asker.id, { to: 'in_progress', trigger: 'answered', actor: 'engine' });
    out.push(asker.id);
  }
  return out;
}

/** 给主会话的回答：主会话提问的咨询已完成、还没在 forge_wait 里交给它的 */
export function undeliveredAnswers(store: StateStore, flowId: string): { task: string; answer: string }[] {
  const delivered = new Set(store.readEvents().filter((e) => e.flow === flowId && typeof e.data?.['consult_delivered'] === 'string').map((e) => String(e.data!['consult_delivered'])));
  return store.listTasks(flowId).filter((t) => t.kind === 'consult' && !t.for_task && t.status === 'done' && !delivered.has(t.id))
    .sort(byId).map((t) => ({ task: t.id, answer: readAnswer(store, flowId, t.id)?.trim() ?? '（没有回答）' }));
}

export async function markDelivered(store: StateStore, flowId: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) await store.recordEvent({ flow: flowId, task: id, actor: 'orchestrator', type: 'note', reason: `架构师的回答已交给主会话（${id}）`, data: { consult_delivered: id } });
}

/** 主会话提问、架构师还没回答完的咨询 */
export const openMainConsults = (tasks: readonly TaskFile[]): TaskFile[] =>
  tasks.filter((t) => t.kind === 'consult' && !t.for_task && t.status !== 'done' && t.status !== 'cancelled');
