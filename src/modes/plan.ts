// 来源：pi-flow src/modes/plan.ts @ 31f3f15
// 各模式的阶段计划（第六轮）：需求或接收 D0 → 规划 D2 → 实施 E。
// D0、D2 都由主会话进行，没有任务：D0 接收用户的 PRD 并做就绪检查（没有 PRD 时和用户逐轮讨论，src/core/requirements.ts），
// D2 由主 agent 写规划文档并提交模块清单（src/core/planning.ts）；E 的模块任务来自经批准的模块清单。
export type FlowMode = 'build' | 'feature';

/** 主会话进行的阶段（没有任务，用户打回时主 agent 带着意见修改） */
export const DESIGN_STAGES = new Set(['D0', 'D2']);
/** 规划阶段：主 agent 提交模块清单，批准后落为实施任务 */
export const PLANNING_STAGE = 'D2';
export const PROPOSAL_STAGES = new Set([PLANNING_STAGE]);
/** 设计规范（用户随原型提供，或主 agent 从原型提取）；界面模块照它做 */
export const DESIGN_DOC = 'DESIGN.md';
/** 实施阶段：模块任务所在的阶段 */
export const EXECUTION_STAGE = 'E';

/** 各阶段给子进程注入的技能（子进程以 --no-skills 运行，由 prompt-assembler 注入）；按角色区分 */
export const STAGE_SKILLS: Record<string, Record<string, string[]>> = {
  E: { implementer: ['tdd', 'write-handoff'], reviewer: ['code-review'] },
};

export function skillsFor(stage: string, role: string): string[] {
  return STAGE_SKILLS[stage]?.[role] ?? [];
}

export function slug(text: string): string {
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return ascii || `feature-${Date.now().toString(36)}`;
}

/** 需求说明的路径：新项目一份，已有项目每个功能一份 */
export function requirementsFile(mode: FlowMode, description: string): string {
  return mode === 'build' ? 'docs/requirements.md' : `docs/requirements/${slug(description)}.md`;
}

/** 规划阶段主 agent 可以写的文档（经 forge_plan_doc，由程序提交到集成分支） */
export const PLAN_DOC_PATHS = ['docs/modules.md', 'docs/glossary.md', 'docs/interfaces/**', 'docs/adr/**', 'docs/rules-draft/**', 'AGENTS.md', DESIGN_DOC];
