// /forge init --adopt（规格第 13.3 节）：已有项目没有 docs/contracts/ 时，由 architect 从现有代码反向整理边界契约，用户批准后成为基线。
// 设计：一个 mode=feature、只有 ADOPT 一个阶段的流程。architect 的 doc task 由程序派发（同 P1），只能写 docs/contracts/** 与 docs/arch/**；
// 预检与闸门做契约结构检查（parseContracts），通过后 awaiting_human；/forge-approve 作为最后一个阶段，程序把集成分支 --no-ff 合入主分支。
import type { FlowConfig } from './config.ts';
import type { FlowFile, TaskFile } from './schemas.ts';
import type { StateStore } from './state-store.ts';
import { git, gitOk } from './git.ts';
import { ensureIntegrationBranch } from './worktree.ts';
import { CONTRACTS_DIR, contractFilesAt, contractFilesInDir, parseContracts } from './contract-check.ts';
import { hasContracts, lockedContractProblems } from './feature-spec.ts';

export const ADOPT_STAGE = 'ADOPT';
export const ADOPT_WRITES = ['docs/contracts/**', 'docs/arch/**'] as const;
const TITLE_PREFIX = 'adopt: ';
const DEFAULT_SCOPE = '项目中与后续功能相关的模块';

export const isAdoptFlow = (f: Pick<FlowFile, 'stages'>): boolean => f.stages.includes(ADOPT_STAGE);

/** 流程标题 adopt: <说明> 里的说明；没写时给默认描述 */
export function adoptScope(title: string): string {
  const s = title.startsWith(TITLE_PREFIX) ? title.slice(TITLE_PREFIX.length).trim() : title.trim();
  return s && s !== DEFAULT_SCOPE ? s : DEFAULT_SCOPE;
}

/** architect 的任务说明（纯函数）：只描述现有行为，不改代码 */
export function adoptBrief(scope: string, opts: { existingContracts: boolean; rework?: string | undefined }): string {
  return [
    '# 已有项目纳管（--adopt）：反向整理边界契约',
    `涉及的模块或说明：${scope}`,
    '这是一个纯文档任务：**只描述现有代码的实际行为，不设计新功能，不修改任何代码、测试或配置。** 你只能写 docs/contracts/** 与 docs/arch/**，其他路径的改动会被程序拒绝。',
    '做法：先用 codegraph、serena 与 read 读懂涉及的模块（路由、数据库迁移与模型、对外导出的函数、错误码），再按技能 design-contract 的格式整理：',
    '1. docs/arch/overview.md：技术栈与版本、目录结构、分层与依赖方向、测试与启动方式（以现状为准）。',
    '2. 契约（docs/contracts/）：data-model.yaml、openapi.yaml（根文件）与 paths/<模块>.yaml、errors/<模块>.yaml，跨模块调用写 modules/<m>.md。只写涉及模块的**边界**；每条契约都必须对应代码里真实存在的接口、表或函数，不要补写你认为应该有的东西。',
    '3. 代码与文档不一致、行为可疑或无法确定的地方，不要猜：写进 docs/arch/overview.md 的"待确认"一节，批准时用户会看到。',
    '契约会成为之后 feature 流程的基线，批准后只能追加，所以宁可少写、写准。',
    ...(opts.existingContracts ? ['', '主分支上已经有一部分契约：它们已锁定，只能追加（新增路径、字段、错误码、模块），不能修改或删除已有条目。'] : []),
    '',
    '写完后用 forge_note 写 handoff，再 forge_submit；不需要 forge_propose_plan，也不要写 docs/plan/。程序会检查契约结构，未通过时按返回的原因修改。',
    ...(opts.rework ? ['', '## 需要返工', opts.rework, '只改上面提到的地方，其余保持不变。'] : []),
  ].join('\n');
}

/** 契约结构问题（纯函数）：parseContracts 的错误；没有任何契约文件也是错误 */
export function adoptContractProblems(files: Readonly<Record<string, string>>): string[] {
  const r = parseContracts(files);
  const problems = r.errors.map((e) => `契约 ${e.file}：${e.message}`);
  if (!Object.keys(files).length && !problems.length) problems.push(`没有任何契约文件（${CONTRACTS_DIR}/）`);
  return problems;
}

/** ADOPT 的 doc task 预检：契约结构 + 已有契约只能追加。通过返回 null */
export function adoptPrecheck(root: string, flow: FlowFile, task: TaskFile): string | null {
  if (task.kind !== 'doc' || task.stage !== ADOPT_STAGE || !task.worktree) return null;
  const files = contractFilesInDir(task.worktree);
  const problems = [...adoptContractProblems(files), ...lockedContractProblems(root, flow.base_sha, files)];
  return problems.length ? `纳管预检未通过：\n${problems.map((p) => `- ${p}`).join('\n')}` : null;
}

/** ADOPT 闸门：集成分支上的契约通过结构检查 */
export function adoptGateProblems(root: string, flow: FlowFile): string[] {
  const files = contractFilesAt(root, flow.integration_branch);
  return [...adoptContractProblems(files), ...lockedContractProblems(root, flow.base_sha, files)];
}

/** 批准页：契约文件清单与符号数量，批准后合入主分支成为基线 */
export function adoptApprovalSummary(root: string, flow: FlowFile): string {
  const files = contractFilesAt(root, flow.integration_branch);
  const c = parseContracts(files);
  const arch = gitOk(root, ['cat-file', '-e', `refs/heads/${flow.integration_branch}:docs/arch/overview.md`]);
  return [
    `纳管范围：${adoptScope(flow.title)}`,
    `契约文件 ${Object.keys(files).length} 个：${Object.keys(files).sort().join('、') || '无'}`,
    `接口 ${c.catalog.apis.size} 个、表 ${c.catalog.tables.size} 个、错误码 ${c.catalog.errors.size} 个、函数 ${c.catalog.fns.size} 个`,
    arch ? '架构说明：docs/arch/overview.md（"待确认"一节是 architect 没有把握的地方）' : '架构说明：没有 docs/arch/overview.md',
    ...c.warnings.map((w) => `提醒：契约 ${w.file}：${w.message}`),
    '批准后：集成分支以 --no-ff 合入主分支，这些契约成为 feature 流程的基线（之后只能追加）。',
  ].join('\n');
}

export interface AdoptDeps { root: string; store: StateStore; config: FlowConfig }

/** 创建纳管流程：mode=feature、唯一阶段 ADOPT、标题 adopt: <说明>。主分支已有契约时需要 force（补充纳管更多模块） */
export async function startAdoptFlow(d: AdoptDeps, scope: string, force = false): Promise<FlowFile> {
  const main = d.config.raw.main_branch;
  if (!gitOk(d.root, ['show-ref', '--verify', '--quiet', `refs/heads/${main}`])) throw new Error(`主分支 ${main} 不存在，请检查 workflow.yaml 的 main_branch`);
  if (hasContracts(d.root, main) && !force) {
    throw new Error(`主分支 ${main} 上已经有 ${CONTRACTS_DIR}/，不需要纳管，可以直接 /forge-build --feature。\n要为更多模块补充契约（已有契约只能追加）：/forge init --adopt --force "<涉及的模块>"`);
  }
  const base = git(d.root, ['rev-parse', main]).trim();
  const flow = await d.store.createFlow({ mode: 'feature', title: `${TITLE_PREFIX}${scope.trim() || DEFAULT_SCOPE}`, stages: [ADOPT_STAGE], base_sha: base, actor: 'human' });
  ensureIntegrationBranch(d.root, flow.integration_branch, base);
  return flow;
}
