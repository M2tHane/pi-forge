// 来源：pi-flow src/core/additions.ts @ 31f3f15
// 中途追加需求（第五轮 /forge-add）：
// - 需求、规划阶段（主 agent 进行）：闸门等待批准时按打回处理；还在进行时作为意见交给主 agent；
// - 实施阶段：指定了模块、或只有一个未完成的模块时，送到那个模块（运行中就插话，并写进它的笔记与 handoff）；
//   其他情况记为修订请求，由主 agent 判断归哪个模块或新增模块并起草计划修订，你批准后生效。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import { taskNotesRel } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import { isSettled } from './state-machine.ts';
import { rejectStage } from './stages.ts';
import { requestReplan } from './revision.ts';
import { reopenRequirements } from './requirements.ts';
import { reopenPlanning } from './planning.ts';
import { DESIGN_STAGES, PLANNING_STAGE } from '../modes/plan.ts';
import { NOTE_ITEM_MAX, NOTE_SECTION_MAX_ITEMS } from './schemas.ts';

export interface AdditionDeps {
  root: string;
  store: StateStore;
  config: FlowConfig;
  /** 送到任务正在运行的子进程；没有运行中的子进程时返回 false */
  steer(flowId: string, taskId: string, message: string): boolean;
}

const clip = (s: string) => (s.length > NOTE_ITEM_MAX - 10 ? `${s.slice(0, NOTE_ITEM_MAX - 11)}…` : s);

/** 把追加需求交给一个任务：写 handoff 与笔记（目标、待完成），运行中就插话 */
async function amendTask(d: AdditionDeps, flowId: string, t: TaskFile, text: string): Promise<string> {
  await d.store.appendHandoff(flowId, t.id, `用户追加的需求：\n${text}`, 'human');
  await d.store.writeNotes(taskNotesRel(flowId, t.id), (n) => {
    if (n.goal.length < NOTE_SECTION_MAX_ITEMS) n.goal.push(clip(`追加：${text}`));
    if (n.todo.length < NOTE_SECTION_MAX_ITEMS) n.todo.push(clip(`（追加）${text}`));
  }, { actor: 'human', flow: flowId, task: t.id, reason: '追加需求' });
  const live = d.steer(flowId, t.id, `[用户追加需求] ${text}\n（已写进你的笔记：目标与待完成。和原来的需求一起完成；与已做的部分冲突时以追加的为准。）`);
  return live ? `已送到正在运行的 ${t.id}「${t.title}」，并写进它的笔记与 handoff。` : `${t.id}「${t.title}」还没开始或在等待重新派发：已写进它的笔记与 handoff，开工时会看到。`;
}

export async function addRequirement(d: AdditionDeps, flowId: string, text: string, taskHint?: string): Promise<string> {
  if (!text.trim()) throw new Error('用法：/forge-add "<追加的需求>" [--task <任务>]');
  const flow = d.store.readFlow(flowId);
  const tasks = d.store.listTasks(flowId);
  if (taskHint) {
    const t = tasks.find((x) => x.id === taskHint);
    if (!t) throw new Error(`没有任务 ${taskHint}`);
    if (isSettled(t)) throw new Error(`${taskHint} 已经完成，不能再追加；不指定 --task 时交给主 agent 安排。`);
    return amendTask(d, flowId, t, text);
  }
  if (flow.mode === 'fix') {
    const t = tasks.find((x) => x.kind === 'impl' && !isSettled(x));
    if (!t) throw new Error('修复已经完成，追加的内容请用 /forge-fix 或 /forge-build --feature 发起。');
    return amendTask(d, flowId, t, text);
  }
  if (DESIGN_STAGES.has(flow.stage)) {
    if (flow.stage_status === 'awaiting_human') {
      const r = await rejectStage({ root: d.root, store: d.store, config: d.config }, flowId, `追加需求：${text}`);
      return `阶段 ${flow.stage} 正在等你批准，追加的需求按打回处理：${r}`;
    }
    if (flow.stage_status !== 'active') return `阶段 ${flow.stage} 正在检查，等结果出来后批准前可以用 /forge-reject "<意见>" 补充。`;
    const prev = flow.stage === PLANNING_STAGE ? flow.planning?.feedback : flow.requirements?.feedback;
    const feedback = `${prev ? `${prev}\n` : ''}用户追加的需求：${text}`;
    if (flow.stage === PLANNING_STAGE) await reopenPlanning(d.store, flowId, feedback, 'human');
    else await reopenRequirements(d.store, flowId, feedback, 'human');
    return `已交给主 agent：${flow.stage === PLANNING_STAGE ? '规划时一并考虑' : '写进需求说明'}。`;
  }
  // 实施阶段：只有一个未完成的模块时直接送到它，否则交给主 agent
  const modules = tasks.filter((t) => t.stage === flow.stage && t.needs_acceptance && !isSettled(t));
  if (modules.length === 1) return amendTask(d, flowId, modules[0]!, text);
  await requestReplan({ root: d.root, store: d.store, config: d.config }, flowId, `用户追加的需求：${text}`, 'human');
  return `有 ${modules.length} 个未完成的模块，追加的需求交给主 agent 判断归哪个模块或新增模块，起草计划修订后用 /forge-approve 批准。也可以用 /forge-add "<需求>" --task <任务> 直接指定模块。`;
}
