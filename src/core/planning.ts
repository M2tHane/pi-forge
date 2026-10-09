// 来源：pi-flow src/core/planning.ts @ 31f3f15
// 主 agent 规划（第六轮 D2）：主会话读过需求说明与用户的输入后直接规划，不再派 architect 子进程。
// 主 agent 不能写文件：规划文档经 forge_plan_doc、模块清单经 forge_propose_modules 提交，由程序写进集成分支与 .forge/。
// 提交模块清单后由引擎执行规划闸门（默认等用户审批）；用户打回或闸门未通过时主 agent 带着意见继续改。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Static } from 'typebox';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { FlowFile } from './schemas.ts';
import { gitOk } from './git.ts';
import { matchesAny, isProtected } from './paths.ts';
import { dagReport, formatDagReport, validateDag } from './dag.ts';
import { REQUIREMENTS_STAGE, commitFileToBranch } from './requirements.ts';
import { DESIGN_DOC, PLANNING_STAGE, PLAN_DOC_PATHS } from '../modes/plan.ts';
import { modulesToTasks, type ProposeModulesParams } from '../tools/module-tools.ts';

export class PlanningError extends Error {}

const PLAN_DOC_MAX = 120_000;

/** 主会话当前要用的技能（按阶段与状态）；不需要时为空 */
export function mainSkillNames(flow: FlowFile): string[] {
  if (flow.mode === 'fix' || flow.stage_status !== 'active') return [];
  if (flow.stage === REQUIREMENTS_STAGE && !flow.requirements?.submitted) return flow.intake ? ['intake-check', 'write-requirements'] : ['grilling', 'write-requirements'];
  if (flow.stage === PLANNING_STAGE && !flow.planning?.submitted) return ['plan-modules', 'domain-modeling', 'write-rules'];
  if (flow.replan_request) return ['revise-plan'];
  return [];
}

/** 规划与修订时告诉主 agent 实现者用什么模型（决定模块大小，见技能 plan-modules） */
export function implModelsNote(models: readonly { role: string; model: string; strong: boolean }[]): string {
  if (!models.length) return '';
  const strong = models.filter((m) => m.strong).length;
  return `## 实现者的模型（决定模块大小，见技能 plan-modules）\n${models.map((m) => `- ${m.role}：${m.model}${m.strong ? '（强模型）' : ''}`).join('\n')}\n${strong === models.length ? '实现者是强模型：模块可以大一些（一块完整的业务功能，含前后端与测试）。' : '实现者不是强模型：模块要小一些（一次会话能完成）。'}`;
}

/** 注入主会话的技能正文（放在每轮的系统提示附加部分） */
export function mainSessionSkills(store: StateStore, skillsDir: string): string {
  const id = store.readState().active_flow;
  if (!id) return '';
  return mainSkillNames(store.readFlow(id)).map((n) => {
    const file = path.join(skillsDir, n, 'SKILL.md');
    return existsSync(file) ? `## 技能 ${n}\n\n${readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim()}` : '';
  }).filter(Boolean).join('\n\n');
}

/** 主 agent 写规划文档：只能写规划范围；规划阶段进行中可写全部，接收阶段只能写从原型提取的 DESIGN.md */
export function writePlanDoc(root: string, store: StateStore, flowId: string, rel: string, content: string): { path: string; changed: boolean } {
  const flow = store.readFlow(flowId);
  const p = rel.replace(/^\.\//, '');
  if (p.startsWith('/') || p.split('/').includes('..') || isProtected(p)) throw new PlanningError(`${rel} 不合法（只能是仓库内的规划文档）`);
  if (!matchesAny(p, PLAN_DOC_PATHS)) throw new PlanningError(`${rel} 不在规划文档范围内，只能写：${PLAN_DOC_PATHS.join('、')}`);
  const inPlanning = flow.stage === PLANNING_STAGE && flow.stage_status === 'active';
  const designInIntake = flow.stage === REQUIREMENTS_STAGE && flow.stage_status === 'active' && p === DESIGN_DOC && !!flow.intake?.pages.length;
  if (!inPlanning && !designInIntake) throw new PlanningError(`现在是阶段 ${flow.stage}（${flow.stage_status}），规划文档只能在规划阶段进行中写${flow.intake?.pages.length ? `（接收阶段只能写从原型提取的 ${DESIGN_DOC}）` : ''}；中途改计划用 forge_revise_plan。`);
  if (!content.trim()) throw new PlanningError('内容不能为空。');
  if (content.length > PLAN_DOC_MAX) throw new PlanningError(`内容超过 ${PLAN_DOC_MAX} 字，请拆成多个文件。`);
  const sha = commitFileToBranch(root, flow.integration_branch, p, content.endsWith('\n') ? content : `${content}\n`, `pi-forge: ${flowId} 规划文档 ${p}`);
  return { path: p, changed: sha !== null };
}

/** 主 agent 提交模块清单：校验、保存提案、标记已提交（之后由引擎执行规划闸门） */
export async function proposeModules(root: string, store: StateStore, config: FlowConfig, flowId: string, p: Static<typeof ProposeModulesParams>, now = new Date()): Promise<string> {
  const flow = store.readFlow(flowId);
  if (flow.stage !== PLANNING_STAGE || flow.stage_status !== 'active') throw new PlanningError(`模块清单只能在规划阶段（${PLANNING_STAGE}）进行中提交，当前是 ${flow.stage}（${flow.stage_status}）；中途改计划用 forge_revise_plan。`);
  const has = (f: string) => gitOk(root, ['cat-file', '-e', `${flow.integration_branch}:${f}`]);
  const { tasks, errors } = modulesToTasks(config, has, p);
  const v = validateDag(tasks, config.dagCatalog());
  errors.push(...v.errors);
  if (!has('docs/modules.md')) errors.push('还没有写 docs/modules.md（先用 forge_plan_doc 写规划文档）');
  if (errors.length) throw new PlanningError(`模块清单校验失败，未保存：\n${errors.map((e) => `- ${e}`).join('\n')}\n逐条修正后重新调用 forge_propose_modules。`);
  const report = dagReport(tasks, v.warnings);
  await store.saveProposal(flowId, { stage: flow.stage, run: 'orchestrator', created_at: now.toISOString(), tasks, report,
    ...(p.assumptions?.length ? { assumptions: p.assumptions } : {}) }, 'orchestrator');
  await store.setPlanning(flowId, { submitted: true, rounds: flow.planning?.rounds ?? 0 }, 'orchestrator', `提交模块清单（${tasks.length} 个模块）`);
  const order = p.modules.map((m, i) => `${m.id}→${tasks[i]!.id} ${m.title}${m.depends_on?.length ? `（等 ${m.depends_on.map((d) => d.module).join('、')}）` : ''}`).join('\n');
  return `${order}\n${formatDagReport(report)}`;
}

/** 用户打回规划或闸门未通过：回到规划，带上意见 */
export async function reopenPlanning(store: StateStore, flowId: string, feedback: string, actor: string): Promise<void> {
  const r = store.readFlow(flowId).planning;
  await store.setPlanning(flowId, { submitted: false, rounds: (r?.rounds ?? 0) + 1, feedback }, actor, '规划需要修改');
}
