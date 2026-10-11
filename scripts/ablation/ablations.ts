// 消融实验的定义：每一臂在 HEAD 的临时 worktree 里对源码做最小的文本替换（去掉一个机制），然后跑全量单元与 e2e 测试。
// 失败的用例说明"这个机制有测试保护、去掉后可观察到的行为是什么"；没有用例失败说明机制要么冗余、要么没有测试，需要专门的场景判断。
// 臂分三类：ablate（去掉现有机制）、proposal（评审提出的简化，验证去掉的东西是否真的多余）、probe（只加观测，不改行为）。
// 替换文本必须在文件中恰好出现一次，否则该臂报错（防止源码改动后悄悄失效）。

export interface Edit { file: string; find: string; replace: string }
export interface Arm { id: string; kind: 'baseline' | 'ablate' | 'proposal' | 'probe'; mechanism: string; hypothesis: string; edits: Edit[] }

// 观测：每次 runShell 记一行（测试文件、资源标签、HEAD 的 tree、命令、退出码），用于统计同一棵树上重复跑的命令
const PROBE: Edit[] = [
  { file: 'src/core/workspace/verify-runner.ts', find: "import { spawn } from 'node:child_process';",
    replace: "import { spawn, execFileSync } from 'node:child_process';\nimport { appendFileSync } from 'node:fs';" },
  { file: 'src/core/workspace/verify-runner.ts', find: '  const started = Date.now();\n  return new Promise((resolve) => {',
    replace: "  const started = Date.now();\n  let probeTree = '?';\n  try { probeTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() + (execFileSync('git', ['status', '--porcelain', '-uno'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() ? '+dirty' : ''); } catch { /* 不是 git 目录 */ }\n  return new Promise((resolve) => {" },
  { file: 'src/core/workspace/verify-runner.ts', find: '    child.on(\'close\', (code) => {\n      clearTimeout(timer);',
    replace: "    child.on('close', (code) => {\n      clearTimeout(timer);\n      if (process.env['FORGE_ABLATION_PROBE']) appendFileSync(process.env['FORGE_ABLATION_PROBE'], [process.argv[1] ?? '?', (extraEnv['FORGE_TMP'] ?? '').split('/').pop() ?? '', probeTree, command.replace(/\\s+/g, ' ').slice(0, 200), timedOut ? 124 : (code ?? 1)].join('\\t') + '\\n');" },
];

// 提案 P1：合并时集成分支自预检后没有移动（分叉点 = 集成分支 HEAD），合并后的树就是预检验过的树，typecheck、lint、test 不再重跑
const MERGE_SKIP_SAME_TREE: Edit[] = [
  { file: 'src/core/engine/merge-queue.ts', find: '    const verify = await this.postMergeVerify(flowId, t, wt);\n    if (!verify.ok) {\n      const routed',
    replace: "    const verify = await this.postMergeVerify(flowId, t, wt, fork === integHead && t.kind !== 'acctest');\n    if (!verify.ok) {\n      const routed" },
  { file: 'src/core/engine/merge-queue.ts', find: '  private async postMergeVerify(flowId: string, t: TaskFile, wt: string) {\n    if (this.hooks.beforeVerify) await this.hooks.beforeVerify();\n    const plan = this.mergeVerifyPlan(t);',
    replace: "  private async postMergeVerify(flowId: string, t: TaskFile, wt: string, sameTree = false) {\n    if (this.hooks.beforeVerify) await this.hooks.beforeVerify();\n    const plan = this.mergeVerifyPlan(t).filter((c) => !sameTree || !['typecheck', 'lint', 'test'].includes(c.name));" },
];

// 提案 P2：门禁开始时集成分支 HEAD 正是最近一次合并验证过的提交，门禁里与合并验证相同的命令不再重跑（只跑 e2e、contract_* 等新增的）
const GATE_SKIP_SAME_TREE: Edit[] = [
  { file: 'src/core/stage/gates.ts', find: '  if (def.gate.auto?.length) {\n    const wt = path.join(worktreesRoot(root), `${flowId}-gate-${flow.stage}`);',
    replace: "  const lastMerge = store.readEvents().filter((e) => e.flow === flowId && e.type === 'merge').at(-1);\n  const mergedTask = lastMerge?.task ? store.readTask(flowId, lastMerge.task) : null;\n  const verifiedHere = !!mergedTask && lastMerge!.evidence === startHead && (mergedTask.verify.length > 0 || mergedTask.kind === 'acctest');\n  const auto = (def.gate.auto ?? []).filter((n) => !verifiedHere || !['typecheck', 'lint', 'test', 'acceptance', 'merge_check'].includes(n));\n  if (auto.length) {\n    const wt = path.join(worktreesRoot(root), `${flowId}-gate-${flow.stage}`);" },
  { file: 'src/core/stage/gates.ts', find: '        for (const name of def.gate.auto!) {', replace: '        for (const name of auto) {' },
];

export const ARMS: Arm[] = [
  { id: 'baseline', kind: 'baseline', mechanism: '无改动', hypothesis: '基线：同样负载下的通过情况，用来扣除负载引起的偶发失败', edits: [] },
  { id: 'probe', kind: 'probe', mechanism: '观测：命令执行记录', hypothesis: '只加日志，不改行为；用于统计同一棵树上的重复验证', edits: PROBE },

  // —— 隔离与权限（原则 13：独立性靠隔离保证）——
  { id: 'acctest-shared-objects', kind: 'ablate', mechanism: 'test-author 独立仓库不共享对象库（第 9.2 节第 2 条）',
    hypothesis: '让隔离工作区通过 alternates 共享主仓库对象后，git show <实现提交> 能读到实现代码，隔离的 e2e 应失败',
    edits: [{ file: 'src/core/acceptance/acctest.ts', find: "    git(ws, ['init', '-q', '-b', 'main']);",
      replace: "    git(ws, ['init', '-q', '-b', 'main']);\n    writeFileSync(path.join(ws, '.git', 'objects', 'info', 'alternates'), path.join(root, '.git', 'objects') + '\\n');" }] },
  { id: 'acctest-guard-off', kind: 'ablate', mechanism: '隔离工作区的 guard（第 9.2 节第 5 条，第二道防线）',
    hypothesis: '去掉 isolatedWorkspace 后，绝对路径、..、.forge/ 不再被拦截；预期 acctest-workspace 的拦截用例失败',
    edits: [{ file: 'src/core/engine/subagent-runtime.ts', find: "...(t.kind === 'acctest' ? { isolatedWorkspace: true } : {}),", replace: '...({}),' }] },
  { id: 'forge-dir-read-off', kind: 'ablate', mechanism: 'guard 拦截读取 .forge/（第 2 节原则 13）',
    hypothesis: '只去掉 guard 中按路径拦截 .forge/ 的一条；若 read_paths 的 !.forge/** 仍能拦住，说明两层重复',
    edits: [{ file: 'src/core/security/guard.ts', find: "if (a.area === 'workspace' && /(^|\\/)\\.forge(\\/|$)/.test(a.rel)) return deny(", replace: "if (false && a.area === 'workspace' && /(^|\\/)\\.forge(\\/|$)/.test(a.rel)) return deny(" }] },
  { id: 'mutex-off', kind: 'ablate', mechanism: 'writes 重叠的 task 互斥（第 7.3 节第 4 条）',
    hypothesis: '互斥关掉后重叠 task 会并行，冲突推迟到合并；预期 DAG 与调度用例失败',
    edits: [{ file: 'src/core/state/dag.ts', find: '  return a.writes.some((x) => b.writes.some((y) => globsOverlap(x, y)));', replace: '  return false && a.writes.some((x) => b.writes.some((y) => globsOverlap(x, y)));' }] },
  { id: 'resources-shared', kind: 'ablate', mechanism: '端口与临时资源按运行分配（第 4.1 节）',
    hypothesis: '所有运行拿同一个端口段；预期"两个并行预检端口不冲突"失败',
    edits: [{ file: 'src/core/workspace/resources.ts', find: '      const base = pickPortBase(f.entries.map((e) => ({ base: e.port_base, size: e.port_count ?? PORT_BLOCK })), skip, hint, PORT_RANGE, block);',
      replace: '      const base = pickPortBase([], new Set(), PORT_RANGE.start, PORT_RANGE, block);' },
    { file: 'src/core/workspace/resources.ts', find: '      if (await probe(base)) {', replace: '      if (true || await probe(base)) {' }] },

  // —— 契约（第 12 节）——
  { id: 'contract-append-submit-off', kind: 'ablate', mechanism: '提交时的契约只能追加检查（forge_submit）',
    hypothesis: '预检里还有同一套检查；若没有用例失败，说明两处重复，可只保留一处',
    edits: [{ file: 'src/tools/subagent-tools.ts', find: '  const violations = canAppendInterfaces(t) ? contractViolationsAt(', replace: '  const violations = false && canAppendInterfaces(t) ? contractViolationsAt(' }] },
  { id: 'contract-append-precheck-off', kind: 'ablate', mechanism: '预检时的契约只能追加检查（contractAppendCheck）',
    hypothesis: '提交时已经检查过；若没有用例失败，说明预检这一处冗余（同步后基线变化除外）',
    edits: [{ file: 'src/core/engine/precheck.ts', find: '  const contract = contractAppendCheck(root, t, store.readFlow(flowId).integration_branch);', replace: '  const contract = null;' }] },
  { id: 'contract-append-both-off', kind: 'ablate', mechanism: '提交时与预检时的契约只能追加检查都去掉',
    hypothesis: '前两臂各自都没有用例失败时，用它确认"契约只能追加"作为整体仍有测试保护',
    edits: [{ file: 'src/tools/subagent-tools.ts', find: '  const violations = canAppendInterfaces(t) ? contractViolationsAt(', replace: '  const violations = false && canAppendInterfaces(t) ? contractViolationsAt(' },
      { file: 'src/core/engine/precheck.ts', find: '  const contract = contractAppendCheck(root, t, store.readFlow(flowId).integration_branch);', replace: '  const contract = null;' }] },
  { id: 'contract-merge-at-sync-off', kind: 'ablate', mechanism: '预检前同步时的契约结构化三方合并（偏离 73）',
    hypothesis: '契约追加冲突改为交回 worker 解决；预期 contract-merge e2e 失败',
    edits: [{ file: 'src/tools/module-tools.ts', find: '      if (!resolveContractConflicts(wt, conflicts, { integration: 3, task: 2 })) {', replace: '      if (true) {' }] },
  { id: 'contract-merge-at-queue-off', kind: 'ablate', mechanism: '合并队列 rebase 时的契约结构化三方合并（第 12.2 节）',
    hypothesis: '同步已在预检前合并过契约，合并时只有"预检后集成分支又移动且契约冲突"才会走到；预期没有用例失败',
    edits: [{ file: 'src/core/engine/merge-queue.ts', find: '    if (!resolveContractConflicts(wt, conflicts, { integration: 2, task: 3 })) return false;', replace: '    return false;' }] },

  // —— 预检、合并、门禁（同一棵树上的验证次数）——
  { id: 'sync-before-precheck-off', kind: 'ablate', mechanism: '预检前把集成分支同步进任务分支（第 8.1 节 inputs_ready）',
    hypothesis: '不同步时语义冲突推迟到合并验证；预期 precheck/merge-queue 中"预检发现语义冲突"的用例失败，但坏代码仍不进集成分支',
    edits: [{ file: 'src/core/engine/dispatcher.ts', find: '    const synced = await syncTaskInputs(store, flowId, t);', replace: '    const synced = { conflicts: [] as string[] };' }] },
  { id: 'precheck-commands-off', kind: 'ablate', mechanism: '预检命令（typecheck、lint、test、acceptance -- <task>）',
    hypothesis: '预检不跑命令时，失败推迟到合并验证；若只有断言预检行为的用例失败，说明预检是"提前反馈"而非最后防线',
    edits: [{ file: 'src/core/engine/precheck.ts', find: '  const plan = precheckCommands(config.commands, impl, hasAcceptance);', replace: '  const plan: { name: string; shell: string }[] = [];' }] },
  { id: 'merge-verify-off', kind: 'ablate', mechanism: '合并后全量验证',
    hypothesis: '合并不验证时，预检之后集成分支的移动带来的语义冲突、对别的 task 验收测试的破坏会进入集成分支；预期 merge-queue、9.4、9.5 用例失败',
    edits: [{ file: 'src/core/engine/merge-queue.ts', find: "    if (!t.verify.length && t.kind !== 'acctest') return [];", replace: '    return [];' }] },
  { id: 'gate-commands-off', kind: 'ablate', mechanism: '阶段门禁的 auto 命令',
    hypothesis: '若只有断言门禁失败路径的用例失败，说明门禁的价值只在合并验证没覆盖的命令（e2e、contract_*）与覆盖率',
    edits: [{ file: 'src/core/stage/gates.ts', find: '        for (const name of def.gate.auto!) {', replace: '        for (const name of [] as string[]) {' }] },
  { id: 'merge-batch-off', kind: 'ablate', mechanism: '批量合并（merge_batch，一次全量验证合几个 task）',
    hypothesis: '纯性能机制；预期只有批量合并的专门用例失败',
    edits: [{ file: 'src/core/engine/merge-queue.ts', find: '    const limit = this.config.limits.merge_batch ?? 3;', replace: '    const limit = 1;' }] },
  { id: 'first-eligible-off', kind: 'ablate', mechanism: '合并队列选第一个合格的 task（第 8.1 节 merge_start）',
    hypothesis: '软依赖在 inputs_ready 时已要求生产方 done，进队列的 task 都合格；预期没有 e2e 失败（偏离 57）',
    edits: [
      { file: 'src/core/engine/merge-queue.ts', find: '      const head = mq.queue.find((e) => e.flow === flowId && ', replace: '      const head = mq.queue.slice(0, 1).find((e) => e.flow === flowId && ' },
      { file: 'src/core/state/state-store.ts', find: '      const eligible = mq.queue.find((e) => {', replace: '      const eligible = mq.queue.slice(0, 1).find((e) => {' },
    ] },
  { id: 'foreign-break-routing-off', kind: 'ablate', mechanism: '别的 task 的验收测试被破坏时建 .at-n（第 9.4 节）',
    hypothesis: '不分流时计为当前 task 的合并失败；预期 disputes/acctest-merge 中 9.4 的用例失败',
    edits: [{ file: 'src/core/engine/merge-queue.ts', find: "    if (kind !== 'foreign') return null;", replace: '    if (true) return null;' }] },
  { id: 'awaited-acctest-off', kind: 'ablate', mechanism: 'impl 预检不等硬依赖自己的验收测试（awaitedAcctest，偏离 72）',
    hypothesis: '去掉后 S0 的 impl 与它的 .at 互相等待；预期 S0 相关用例卡住或失败',
    edits: [{ file: 'src/core/acceptance/acceptance-flow.ts', find: "  return latest && !latest.depends_on.some((d) => d.type === 'hard' && d.task === impl) ? latest : undefined;", replace: '  return latest;' }] },
  { id: 'merged-acceptance-filter-off', kind: 'ablate', mechanism: '提交 diff 排除程序合入的验收测试（偏离 47）',
    hypothesis: '预检合入 .at 后返工再提交时，worker 的 diff 含 tests/acceptance/** 被拒；预期返工类用例失败',
    edits: [{ file: 'src/tools/subagent-tools.ts', find: '  const diff = withoutMergedAcceptance(ctx.env.root, ctx.env.flow, t, changedFiles(t.worktree, t.base_sha));', replace: '  const diff = changedFiles(t.worktree, t.base_sha);' }] },

  // —— LLM 判断的约束（原则 14、15）——
  { id: 'must-basis-demotion-off', kind: 'ablate', mechanism: '没有出处的 must 降为 suggest（第 10.3 节）',
    hypothesis: '预期 review 单元与 e2e 中的降级用例失败',
    edits: [{ file: 'src/core/stage/review.ts', find: "    if (level === 'must' && !isValidMustBasis(basis)) {", replace: "    if (false && level === 'must' && !isValidMustBasis(basis)) {" }] },
  { id: 'dispute-evidence-check-off', kind: 'ablate', mechanism: '争议依据必须引用存在的规格或契约位置（偏离 49）',
    hypothesis: '预期争议用例中"依据无效被拒"失败',
    edits: [{ file: 'src/tools/subagent-tools.ts', find: '      facts: { token: ctx.env.token, dispute_test: test, dispute_evidence: p.evidence, dispute_evidence_valid: ev.ok, reason: p.reason } });', replace: '      facts: { token: ctx.env.token, dispute_test: test, dispute_evidence: p.evidence, dispute_evidence_valid: true, reason: p.reason } });' }] },
  { id: 'gate-retry-guard-off', kind: 'ablate', mechanism: '门禁失败后没有任何 task 变化时不重跑（gateFailedWithoutChange）',
    hypothesis: '去掉后门禁可能反复重跑同一结果；预期 gates/P1 用例出现多余轮次或失败',
    edits: [{ file: 'src/core/stage/gates.ts', find: "  const lastFail = [...events].reverse().find((e) => e.type === 'gate_result' && e.to === 'active' && e.data?.['stage'] === stage);\n  if (!lastFail) return false;", replace: "  const lastFail = [...events].reverse().find((e) => e.type === 'gate_result' && e.to === 'active' && e.data?.['stage'] === stage);\n  if (!lastFail || true) return false;" }] },
  { id: 'lean-stage-review-off', kind: 'ablate', mechanism: '精简模式的阶段审查（第 7.6 节）',
    hypothesis: '预期只有断言 S1.rv 的用例失败；它的质量价值只能由 M9 的真实模型对照回答',
    edits: [{ file: 'src/core/stage/stage-acceptance.ts', find: '    if (isLean(flow)) {\n      const r = await resolveStageReview(', replace: '    if (false && isLean(flow)) {\n      const r = await resolveStageReview(' }] },
  { id: 'gate-impl-branch-dead', kind: 'ablate', mechanism: 'runStageGate 里实施阶段的分支（S 阶段已改由 stageStep/afterChecks 驱动）',
    hypothesis: '该分支已无生产调用方；预期只有直接调用它的旧用例失败（死代码）',
    edits: [{ file: 'src/core/stage/gates.ts', find: '  const def = stageDef(config, flow.mode, flow.stage);\n  const isLast = flow.stage === flow.stages.at(-1);', replace: "  throw new Error('ABLATED: runStageGate 实施阶段分支');\n  const def = stageDef(config, flow.mode, flow.stage);\n  const isLast = flow.stage === flow.stages.at(-1);" }] },

  // —— M8.5 实现后的复测 ——
  { id: 'verify-reuse-off', kind: 'ablate', mechanism: '同一棵代码树只验证一次（verify-cache，偏离 76）',
    hypothesis: '去掉后每处都重跑，行为不变；预期只有断言沿用记录（merge-aN-reused.txt、gate-reused.txt）与 verify-cache 单元的用例失败',
    edits: [{ file: 'src/core/verify/verify-cache.ts', find: '  const out = new Map<string, string>();\n  if (!tree) return out;', replace: '  const out = new Map<string, string>();\n  if (!tree || true) return out;' }] },

  // —— 评审提出的简化 ——
  { id: 'proposal-skip-same-tree', kind: 'proposal', mechanism: '同一棵树只验证一次（合并：集成分支未移动时跳过 typecheck/lint/test；门禁：HEAD 即最近合并验证过的提交时跳过重复命令）',
    hypothesis: '只应有断言 evidence 文件名的用例失败；行为（谁通过、谁失败、谁被交回）不变',
    edits: [...MERGE_SKIP_SAME_TREE, ...GATE_SKIP_SAME_TREE, ...PROBE] },
];
