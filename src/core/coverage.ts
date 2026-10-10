// 阶段验收的覆盖率（规格第 11.1 节、第 7.3 节第 6 步）：阶段 exit 需求的每条计入的 AC（MVP、非 manual，与计划覆盖同一口径）
// 是否在验收测试里有带 [REQ-xxx.ACn] 标签的测试。纯函数负责矩阵与渲染，IO 部分在集成分支的某个提交上读取（git ls-tree / git show，不需要工作区）。
import type { FlowConfig } from './config.ts';
import type { TaskFile } from './schemas.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import { git } from './git.ts';
import { commitFilesToBranch } from './intake.ts';
import { effectiveSpec, type Requirement, type SpecFeature, type SpecFiles } from './spec.ts';
import { SPEC_PATHS } from './spec-flow.ts';
import { scanAcCoverage } from './acctest.ts';
import { createAcctestRound, latestAcctest, nextFixId } from './acceptance-flow.ts';
import { lastWorkerTask } from './stage-fix.ts';
import { ownAcceptanceGlob } from './paths.ts';
import { isSettled } from './state-machine.ts';
import { headSha } from './worktree.ts';

export interface CoverageRow { req: string; ac: string; text?: string; owner?: string; files: string[] }
export interface CoverageInput {
  reqs: readonly Pick<Requirement, 'id' | 'priority' | 'acs'>[];
  /** 阶段的 exit 需求 */
  exit: readonly string[];
  tasks: readonly (Pick<TaskFile, 'id' | 'kind' | 'status'> & { ac?: readonly string[] })[];
  /** scanAcCoverage 的结果：AC 编号 → 带标签的测试文件 */
  tests: ReadonlyMap<string, readonly string[]>;
}
export interface CoverageResult { rows: CoverageRow[]; gaps: CoverageRow[]; markdown: string }

/** 覆盖矩阵（纯函数）：exit 需求中 MVP 且非 manual 的每条 AC 一行，按 exit 与规格中的顺序排列 */
export function coverageMatrix(input: CoverageInput): CoverageRow[] {
  const rows: CoverageRow[] = [];
  const impls = input.tasks.filter((t) => t.kind === 'impl' && t.status !== 'cancelled').sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  for (const id of input.exit) {
    const r = input.reqs.find((x) => x.id === id);
    if (!r || r.priority !== 'MVP') continue;
    for (const ac of r.acs) {
      if (ac.manual) continue;
      const key = `${r.id}.${ac.id}`;
      const owner = impls.find((t) => (t.ac ?? []).includes(key))?.id;
      rows.push({ req: r.id, ac: key, text: ac.text, ...(owner ? { owner } : {}), files: [...(input.tests.get(key) ?? [])] });
    }
  }
  return rows;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/** docs/qa/<stage>.md 的内容（纯函数） */
export function renderCoverageMarkdown(stage: string, goal: string, rows: readonly CoverageRow[]): string {
  const gaps = rows.filter((r) => !r.files.length);
  const lines = [`# 阶段 ${stage} 验收覆盖`, '', `目标：${goal}`, '', '## 需求 → AC → 测试文件', '', '| 需求 | AC | 内容 | 负责 task | 测试文件 |', '| --- | --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${r.req} | ${r.ac} | ${cell(r.text ?? '')} | ${r.owner ?? '—'} | ${r.files.length ? r.files.map((f) => `\`${f}\``).join('<br>') : '**缺口**'} |`);
  if (!rows.length) lines.push('| — | — | 本阶段没有需要自动验收的 AC | — | — |');
  lines.push('', gaps.length ? `缺口：${gaps.length} / ${rows.length} 条 AC 没有带编号的验收测试：${gaps.map((g) => g.ac).join('、')}` : `缺口：无（${rows.length} 条 AC 均有验收测试）`, '');
  return lines.join('\n');
}

/** 在 ref（提交或分支）上读规格与验收测试，计算本阶段的覆盖率；计划里没有该阶段时抛错 */
export function stageCoverage(root: string, store: StateStore, _config: FlowConfig, flowId: string, stage: string, ref: string): CoverageResult {
  const flow = store.readFlow(flowId);
  const def = (flow.s_stages ?? []).find((s) => s.id === stage);
  if (!def) throw new Error(`计划里没有阶段 ${stage}`);
  const show = (rel: string) => git(root, ['show', `${ref}:${rel}`]);
  const files = Object.fromEntries(SPEC_PATHS.map((n) => [n, show(`docs/spec/${n}.md`)])) as unknown as SpecFiles;
  const features: SpecFeature[] = git(root, ['ls-tree', '-r', '--name-only', '-z', ref, '--', 'docs/spec/features/']).split('\0')
    .filter((f) => /^docs\/spec\/features\/[^/]+\.md$/.test(f)).sort().map((f) => ({ name: f.slice('docs/spec/features/'.length), content: show(f) }));
  const spec = effectiveSpec(files, features);
  const testFiles = git(root, ['ls-tree', '-r', '--name-only', '-z', ref, '--', 'tests/acceptance/']).split('\0').filter(Boolean)
    .map((p) => ({ path: p, content: show(p) }));
  const rows = coverageMatrix({ reqs: spec.reqs, exit: def.exit, tasks: store.listTasks(flowId), tests: scanAcCoverage(testFiles) });
  return { rows, gaps: rows.filter((r) => !r.files.length), markdown: renderCoverageMarkdown(stage, def.goal, rows) };
}

/** 把覆盖报告提交到集成分支的 docs/qa/<stage>.md（内容没变则不提交）；返回集成分支此后的 HEAD */
export async function writeCoverageReport(root: string, store: StateStore, flowId: string, stage: string, markdown: string): Promise<string> {
  const branch = store.readFlow(flowId).integration_branch;
  commitFilesToBranch(root, branch, [{ rel: `docs/qa/${stage}.md`, content: markdown }], `docs(qa): 阶段 ${stage} 验收覆盖`);
  return headSha(root, branch);
}

/**
 * 为有缺口的 impl 各建一轮补充测试（.at-n，kind coverage）。该 impl 最近的验收测试 task 还没结束的跳过（skipped）；
 * 找不到负责 task 的缺口原样返回 unowned，由主会话告诉用户。
 */
export async function createCoverageRounds(store: StateStore, flowId: string, gaps: readonly CoverageRow[], actor = 'engine', selfTest = false): Promise<{ tasks: string[]; unowned: CoverageRow[]; skipped: string[] }> {
  const byOwner = new Map<string, CoverageRow[]>();
  const unowned: CoverageRow[] = [];
  for (const g of gaps) {
    if (!g.owner) { unowned.push(g); continue; }
    byOwner.set(g.owner, [...(byOwner.get(g.owner) ?? []), g]);
  }
  const tasks: string[] = [];
  const skipped: string[] = [];
  for (const [owner, rows] of byOwner) {
    // test_author 为 false（偏离 81）：没有 test-author，补测交给 impl 的 worker（.fx-n，只能写自己的验收目录）
    if (selfTest) {
      const all = store.listTasks(flowId);
      const open = all.find((t) => t.kind === 'fix' && t.for_task === owner && !isSettled(t));
      if (open) { skipped.push(owner); continue; }
      const impl = all.find((t) => t.id === owner)!;
      const id = nextFixId(all, owner);
      const input: TaskInput = {
        id, stage: store.readFlow(flowId).stage, kind: 'fix', role: impl.role, scopes: [...impl.scopes], depends_on: [], inputs: [],
        writes: [ownAcceptanceGlob(owner)], verify: [...impl.verify], for_task: owner, fork_from_task: lastWorkerTask(owner, all),
        title: '补齐 AC 编号的验收测试', ac: rows.map((r) => r.ac),
        ...(impl.module ? { module: impl.module } : {}),
        ...(impl.layers?.length ? { layers: [...impl.layers] } : {}),
      };
      await store.addTasks(flowId, [input], actor);
      await store.appendHandoff(flowId, id, ['## 补齐验收测试（程序生成）', '', `下面这些 AC 在 tests/acceptance/${owner}/ 里还没有带编号的测试。请补充，测试名里带 \`[REQ-xxx.ACn]\` 编号，只能写在 ${ownAcceptanceGlob(owner)}：`, '',
        ...rows.map((r) => `- ${r.ac}${r.text ? `：${r.text}` : ''}`)].join('\n'), actor);
      tasks.push(id);
      continue;
    }
    const latest = latestAcctest(store.listTasks(flowId), owner);
    if (latest && !isSettled(latest)) { skipped.push(owner); continue; }
    const brief = ['## 补充 AC 的测试（程序生成）', '', '下面这些 AC 在验收测试里还没有带编号的测试。请补充，测试名里带 `[REQ-xxx.ACn]` 编号，只写在本 task 的测试目录里：', '',
      ...rows.map((r) => `- ${r.ac}${r.text ? `：${r.text}` : ''}`)].join('\n');
    tasks.push((await createAcctestRound(store, flowId, owner, { kind: 'coverage' }, brief, actor)).id);
  }
  return { tasks, unowned, skipped };
}
