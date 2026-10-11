// feature 模式的规格部分（规格第 13.3 节）：前置条件、增量规格文件（docs/spec/features/）的提交、权限变更清单、
// 以及把计划校验的规格范围收窄到"本次新增或修改的 AC"。除 submitFeatureSpec 外都是纯函数或只读 git。
import type { StateStore } from '../state/state-store.ts';
import type { FlowFile } from '../state/schemas.ts';
import { git, gitOk } from '../state/git.ts';
import { commitFilesToBranch } from './intake.ts';
import { SPEC_PATHS, SpecFlowError } from './spec-flow.ts';
import { diffAcs, effectiveSpec, lintSpec, type EffectiveSpec, type LintResult, type SpecFeature, type SpecFiles, type SpecPermission } from './spec.ts';
import { planStageTransition } from '../state/state-machine.ts';
import { CONTRACTS_DIR, contractFilesAt, type ContractFiles } from '../plan/contract-check.ts';
import { contractDiff } from '../plan/contract-diff.ts';

export const FEATURES_DIR = 'docs/spec/features';
export const FEATURE_NAME = /^[\p{L}\p{N}_-]{1,80}$/u;

/** 主分支上有契约文件才算有契约基线 */
export function hasContracts(root: string, ref: string): boolean {
  if (!gitOk(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) return false;
  return git(root, ['ls-tree', '-r', '--name-only', ref, '--', `${CONTRACTS_DIR}/`]).split('\n').some((f) => f.trim());
}

/** feature 模式的前置条件：主分支上必须已有 docs/contracts/。满足返回 null，否则返回给用户的中文提示 */
export function featurePrecondition(root: string, mainBranch: string): string | null {
  if (hasContracts(root, mainBranch)) return null;
  return `主分支 ${mainBranch} 上没有 ${CONTRACTS_DIR}/，feature 模式需要已有契约作为基线。\n已有项目请先运行 /forge init --adopt ["<涉及的模块或说明>"]：architect 会从现有代码反向整理边界契约，你批准后即成为基线；全新项目请用 /forge-build。`;
}

/** 读某个引用（分支、提交）上的基线规格与 features；缺基线文件时返回 null */
export function readSpecAt(root: string, ref: string): { files: SpecFiles; features: SpecFeature[] } | null {
  if (!gitOk(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) return null;
  const entries: [string, string][] = [];
  for (const name of SPEC_PATHS) {
    const rel = `docs/spec/${name}.md`;
    if (!gitOk(root, ['cat-file', '-e', `${ref}:${rel}`])) return null;
    entries.push([name, git(root, ['show', `${ref}:${rel}`])]);
  }
  const features = git(root, ['ls-tree', '-rz', '--name-only', ref, '--', `${FEATURES_DIR}/`]).split('\0')
    .filter((f) => new RegExp(`^${FEATURES_DIR}/[^/]+\\.md$`).test(f)).sort()
    .map((f) => ({ name: f.slice(FEATURES_DIR.length + 1), content: git(root, ['show', `${ref}:${f}`]) }));
  return { files: Object.fromEntries(entries) as unknown as SpecFiles, features };
}

/**
 * 新 feature 文件名：日期-000-名字.md。日期不早于已有 feature 的最新日期，叠加顺序（按文件名）才不会倒置；
 * 000 让同一天里本流程之后的规格修订（日期-001-…）排在它后面。
 */
export function featureFileName(name: string, existing: readonly string[], today: string): string {
  const latest = existing.map((f) => f.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1);
  return `${latest && latest > today ? latest : today}-000-${name}.md`;
}

export interface PermissionChange { resource: string; cells: { role: string; from: string | null; to: string }[] }
export interface PermissionChanges { added: SpecPermission[]; modified: PermissionChange[] }

/** 权限变化（纯函数）：before 为 null 时全部算新增；已有行的单元格变了或多了角色列，算"修改"，逐格列出前后值 */
export function permissionChanges(before: EffectiveSpec | null, after: EffectiveSpec): PermissionChanges {
  const old = new Map((before?.permissions ?? []).map((p) => [p.resource, p]));
  const added: SpecPermission[] = [];
  const modified: PermissionChange[] = [];
  for (const row of after.permissions) {
    const prev = old.get(row.resource);
    if (!prev) { added.push(row); continue; }
    const cells = Object.entries(row.grants)
      .filter(([role, value]) => prev.grants[role] !== value)
      .map(([role, to]) => ({ role, from: prev.grants[role] ?? null, to }));
    if (cells.length) modified.push({ resource: row.resource, cells });
  }
  return { added, modified };
}

/** 批准页的权限变更清单；没有变化返回空数组。修改的行单独列出，用户必须逐条确认 */
export function formatPermissionChanges(c: PermissionChanges): string[] {
  const out: string[] = [];
  if (c.modified.length) {
    out.push(`修改的权限行（已有行被改动，请逐条确认）：${c.modified.map((m) => `\n- ${m.resource}：${m.cells.map((x) => `${x.role} ${x.from ?? '（无此列）'} → ${x.to}`).join('；')}`).join('')}`);
  }
  if (c.added.length) {
    out.push(`新增的权限行：${c.added.map((r) => `\n- ${r.resource}：${Object.entries(r.grants).map(([role, v]) => `${role} ${v}`).join('；')}`).join('')}`);
  }
  return out;
}

/** feature 流程 P0 的权限变更清单：流程起点（base_sha）的生效规格对比集成分支的生效规格 */
export function featurePermissionSummary(root: string, flow: Pick<FlowFile, 'base_sha' | 'integration_branch'>): string[] {
  const after = readSpecAt(root, `refs/heads/${flow.integration_branch}`);
  if (!after) return [];
  const before = flow.base_sha ? readSpecAt(root, flow.base_sha) : null;
  return formatPermissionChanges(permissionChanges(before ? effectiveSpec(before.files, before.features) : null, effectiveSpec(after.files, after.features)));
}

/**
 * 计划校验用的规格范围（纯函数）：feature 流程只需要给"本次新增或修改的 AC"分配 task，已有需求的 AC 早已实现。
 * 只保留有新增或修改 AC 的需求，且只保留那些 AC。before 为 null（没有基线）时不收窄。
 */
export function scopeSpecToFeature(after: EffectiveSpec, before: EffectiveSpec | null): EffectiveSpec {
  if (!before) return after;
  const d = diffAcs(before, after);
  const touched = new Set([...d.added, ...d.changed]);
  const reqs = after.reqs
    .map((r) => ({ ...r, acs: r.acs.filter((ac) => touched.has(`${r.id}.${ac.id}`)) }))
    .filter((r) => r.acs.length > 0);
  return { ...after, reqs };
}

export interface FeatureSubmitInput { name: string; content: string; baseline?: SpecFiles }

/**
 * feature 流程 P0：把增量规格写进集成分支 docs/spec/features/，lint 针对基线 + 全部 features。
 * 基线不在集成分支上时（已有项目没有走过 build）必须同时提交四份基线；基线已在时不能再提交。
 * 重提（被打回后）沿用本流程已有的 feature 文件名。
 */
export async function submitFeatureSpec(root: string, store: StateStore, flowId: string, input: FeatureSubmitInput): Promise<{ sha: string | null; lint: LintResult; path: string }> {
  return store.transaction((tx) => {
    const flow = tx.readFlow(flowId);
    if (store.readState().active_flow !== flowId || flow.mode !== 'feature' || flow.stage !== 'P0' || flow.stage_status !== 'active') {
      throw new SpecFlowError('只能在活动 feature 流程的 P0 规格阶段为 active 时提交；已提交时请等待用户 /forge-approve 或 /forge-reject。');
    }
    const name = input.name.trim();
    if (!FEATURE_NAME.test(name)) throw new SpecFlowError('feature 名字只能包含文字、数字、下划线和短横线，最多 80 字。');
    if (!input.content.trim()) throw new SpecFlowError('feature 内容不能为空。');
    const onBranch = readSpecAt(root, `refs/heads/${flow.integration_branch}`);
    if (onBranch && input.baseline) throw new SpecFlowError('基线规格（docs/spec/*.md）已经存在，P0 只提交 feature；不要再传基线四份文件。');
    if (!onBranch && !input.baseline) throw new SpecFlowError(`项目里还没有基线规格（docs/spec/ 的 requirements、screens、permissions、glossary）。请同时用 requirements、screens、permissions、glossary 提交四份描述现有功能的基线，再附上 feature。`);
    const files = onBranch?.files ?? input.baseline!;
    const baseNames = new Set((flow.base_sha ? readSpecAt(root, flow.base_sha)?.features ?? [] : []).map((f) => f.name));
    const all = onBranch?.features ?? [];
    const mine = all.filter((f) => !baseNames.has(f.name));
    if (mine.length > 1) throw new SpecFlowError(`集成分支上有 ${mine.length} 个本流程新增的 feature 文件（${mine.map((f) => f.name).join('、')}），P0 只允许一个；请先整理集成分支。`);
    const others = all.filter((f) => !mine.includes(f));
    const filename = mine[0]?.name ?? featureFileName(name, others.map((f) => f.name), new Date().toISOString().slice(0, 10));
    const lint = lintSpec(files, [...others, { name: filename, content: input.content }]);
    if (lint.errors.length) throw new SpecFlowError(`spec-lint 未通过，未写入任何文件：\n${lint.errors.map((e) => `- ${e.message}`).join('\n')}`);
    const errors = planStageTransition(flow.stage_status, 'awaiting_gate', 'submit_gate', { actor: 'orchestrator' });
    if (errors.length) throw new SpecFlowError(errors.join('；'));
    const rel = `${FEATURES_DIR}/${filename}`;
    const sha = commitFilesToBranch(root, flow.integration_branch, [
      ...(onBranch ? [] : SPEC_PATHS.map((n) => ({ rel: `docs/spec/${n}.md`, content: files[n] }))),
      { rel, content: input.content },
    ], `pi-forge: ${flowId} 提交增量规格 ${filename}`);
    tx.putFlow({ ...flow, stage_status: 'awaiting_gate', spec: { submitted: true, errors: [], warnings: lint.warnings.map((i) => i.message), ...(sha ? { sha } : {}) } });
    tx.event({ flow: flowId, actor: 'orchestrator', type: 'note', reason: `增量规格 ${filename} 已提交，spec-lint 通过`, data: { sha, warnings: lint.warnings, path: rel } });
    tx.event({ flow: flowId, actor: 'orchestrator', type: 'transition', from: 'active', to: 'awaiting_gate', trigger: 'submit_gate', data: { entity: 'stage', stage: 'P0' } });
    return { sha, lint, path: rel };
  });
}

/**
 * feature 流程 P1 与 adopt（已有契约时）的追加检查：流程起点（base_sha）时主分支上已有的契约视为锁定，
 * 本流程只能追加。基线上没有契约时返回空数组。返回中文问题清单（最多 20 条）。
 */
export function lockedContractProblems(root: string, baseSha: string | null, head: ContractFiles): string[] {
  if (!baseSha) return [];
  const base = contractFilesAt(root, baseSha);
  if (!Object.keys(base).length) return [];
  const vs = contractDiff(base, head, undefined);
  const lines = vs.slice(0, 20).map((v) => `已有契约只能追加：${v.file}${v.path ? ` ${v.path}` : ''}：${v.message}`);
  return vs.length > 20 ? [...lines, `……还有 ${vs.length - 20} 条`] : lines;
}
