// 验收测试的返工与单独合并（规格第 9.3–9.5 节）：争议、被别的 task 的契约追加破坏、单独合并与 .fx-n。
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { TaskFile } from './schemas.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import { accBranch, acctestDirs } from './acctest.ts';
import { git, gitOk } from './git.ts';
import { headSha, removeWorktree, taskBranch, worktreePath, worktreesRoot } from './worktree.ts';
import { evidenceText, failureSummary, runShell } from './verify-runner.ts';
import { resourceOptions, withResources } from './resources.ts';

const roundOf = (id: string) => Number(/\.at-(\d+)$/.exec(id)?.[1] ?? 1);

/** 某个 impl 最新的验收测试 task（忽略已取消的）；没有时为 undefined */
export function latestAcctest<T extends Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status'>>(tasks: readonly T[], impl: string): T | undefined {
  return tasks.filter((t) => t.kind === 'acctest' && t.for_task === impl && t.status !== 'cancelled').sort((a, b) => roundOf(a.id) - roundOf(b.id)).at(-1);
}

/** 下一轮验收测试的编号：T-003.at → T-003.at-2 → T-003.at-3 */
export function nextAcctestId(tasks: readonly Pick<TaskFile, 'id'>[], impl: string): string {
  const rounds = tasks.filter((t) => t.id === `${impl}.at` || t.id.startsWith(`${impl}.at-`)).map((t) => roundOf(t.id));
  return `${impl}.at-${Math.max(1, ...rounds) + 1}`;
}

/** 下一个修复 task 的编号：T-003.fx-1、T-003.fx-2 */
export function nextFixId(tasks: readonly Pick<TaskFile, 'id'>[], impl: string): string {
  const n = tasks.map((t) => /^(.+)\.fx-(\d+)$/.exec(t.id)).filter((m) => m?.[1] === impl).map((m) => Number(m![2]));
  return `${impl}.fx-${Math.max(0, ...n) + 1}`;
}

/** 失败输出里出现的验收测试目录所属的 task（tests/acceptance/<task>/ 与 _support/<task>/） */
export function failingAcceptanceDirs(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/tests\/acceptance\/(?:_support\/)?(T-\d{3,})(?=\/)/g)) out.add(m[1]!);
  return [...out].sort();
}

/** own：失败都在本 task 的目录；foreign：都在别的 task 的目录；mixed：都有；unknown：认不出目录 */
export function classifyAcceptanceFailure(ownImpl: string, dirs: readonly string[]): 'own' | 'foreign' | 'mixed' | 'unknown' {
  if (!dirs.length) return 'unknown';
  const own = dirs.includes(ownImpl);
  const foreign = dirs.some((d) => d !== ownImpl);
  return own && foreign ? 'mixed' : own ? 'own' : 'foreign';
}

/**
 * 争议的依据（第 9.3 节）：必须引用规格或契约的具体位置。认可的写法：
 * docs/spec/… 或 docs/contracts/… 的文件（可带 :行号 或 #标题），或规格里存在的 AC 编号（REQ-012.AC2）。
 */
export function validateEvidence(evidence: string, read: (rel: string) => string | null, acIds: ReadonlySet<string>): { ok: boolean; refs: string[]; reason?: string } {
  const refs: string[] = [];
  for (const m of evidence.matchAll(/(docs\/(?:spec|contracts)\/[\w./-]+?\.(?:md|ya?ml|json))(?::(\d+)|#([^\s，。,;；]+))?/g)) {
    const content = read(m[1]!);
    if (content === null) continue;
    if (m[2] && Number(m[2]) > content.split('\n').length) continue;
    if (m[3] && !content.includes(m[3])) continue;
    refs.push(m[0]);
  }
  for (const m of evidence.matchAll(/REQ-\d{3,}\.AC\d+/g)) if (acIds.has(m[0])) refs.push(m[0]);
  return refs.length ? { ok: true, refs } : { ok: false, refs, reason: '依据要引用规格或契约的具体位置：docs/spec/… 或 docs/contracts/… 的文件（可带 :行号 或 #标题），或规格中的 AC 编号' };
}

/** 新建一轮验收测试返工（.at-n）：接着上一个 test-author 的会话，原因写进 handoff */
export async function createAcctestRound(store: StateStore, flowId: string, impl: string, round: NonNullable<TaskFile['acctest_round']>, brief: string, actor: string): Promise<TaskFile> {
  const tasks = store.listTasks(flowId);
  const implTask = tasks.find((t) => t.id === impl);
  if (!implTask) throw new Error(`找不到 ${impl}`);
  const prev = latestAcctest(tasks, impl);
  const flow = store.readFlow(flowId);
  const id = nextAcctestId(tasks, impl);
  const input: TaskInput = {
    id, stage: flow.stage, kind: 'acctest', role: 'test-author', title: `验收测试返工：${implTask.title}`, scopes: [...(prev?.scopes ?? ['acctest'])],
    depends_on: [], inputs: [], writes: acctestDirs(impl), verify: [], for_task: impl, ac: [...(implTask.ac ?? [])],
    ...(implTask.test_interface?.length ? { test_interface: [...implTask.test_interface] } : {}),
    ...(implTask.module ? { module: implTask.module } : {}),
    ...(prev ? { fork_from_task: prev.id } : {}),
    acctest_round: round,
  };
  const [t] = await store.addTasks(flowId, [input], actor);
  await store.appendHandoff(flowId, id, brief, actor);
  return t!;
}

/**
 * 新建修复 task（.fx-n，第 9.5 节）：分支基于"集成分支 + 这批测试"（acc 分支），基线记为集成分支，
 * 这样测试随 .fx-n 一起合并；与 acc 分支一致的测试文件不算 worker 的改动。
 */
export async function createFixRound(root: string, store: StateStore, flowId: string, impl: string, brief: string, actor: string): Promise<TaskFile> {
  const tasks = store.listTasks(flowId);
  const implTask = tasks.find((t) => t.id === impl)!;
  const flow = store.readFlow(flowId);
  const id = nextFixId(tasks, impl);
  const branch = taskBranch(flowId, id);
  const wt = worktreePath(root, flowId, id);
  const base = headSha(root, flow.integration_branch);
  removeWorktree(root, wt, branch);
  git(root, ['worktree', 'add', '-q', '-b', branch, wt, accBranch(flowId, impl)]);
  const input: TaskInput = {
    id, stage: flow.stage, kind: 'fix', role: implTask.role, title: `修复：${implTask.title}`, scopes: [...implTask.scopes],
    depends_on: [], inputs: [], writes: [...implTask.writes], verify: [...implTask.verify], for_task: impl, ac: [...(implTask.ac ?? [])],
    ...(implTask.shared?.length ? { shared: [...implTask.shared] } : {}),
    ...(implTask.module ? { module: implTask.module } : {}),
    ...(implTask.layers?.length ? { layers: [...implTask.layers] } : {}),
    fork_from_task: impl, worktree: wt, branch, base_sha: base,
  };
  const [t] = await store.addTasks(flowId, [input], actor);
  await store.appendHandoff(flowId, id, brief, actor);
  return t!;
}

/** 争议裁决（第 9.3 节）：最新 .at-n 改了测试 → 重跑预检；维持 → 接着 worker 的会话并附上理由；交给用户 → 阻塞 */
export async function resolveDisputes(store: StateStore, flowId: string): Promise<string[]> {
  const out: string[] = [];
  for (const listed of store.listTasks(flowId)) {
    if (listed.status !== 'disputed') continue;
    const t = store.readTask(flowId, listed.id);
    const at = latestAcctest(store.listTasks(flowId), t.for_task ?? t.id);
    if (!at || at.acctest_round?.from_task !== t.id && at.acctest_round?.kind !== 'decide') continue;
    if (at.status === 'blocked') {
      await store.transitionTask(flowId, t.id, { to: 'blocked', trigger: 'dispute_escalated', actor: 'engine',
        facts: { acctest_escalated: true, reason: `争议交给你裁决（${at.id}：${at.blocked_reason ?? ''}）。处理：/forge-decide ${t.id} keep-test 或 /forge-decide ${t.id} fix-test "<说明>"` } });
      out.push(t.id);
    } else if (at.status === 'done') {
      const changed = at.changed_tests === true;
      if (!changed) {
        const why = store.readHandoff(flowId, at.id).trim().split('\n').slice(-20).join('\n');
        await store.appendHandoff(flowId, t.id, `## 争议结论：维持测试（${at.id}）\n${why}\n按测试修改实现；仍认为测试不符合规格时再 forge_dispute，超过次数会交给用户。`, 'engine');
      }
      await store.transitionTask(flowId, t.id, { to: changed ? 'checking' : 'in_progress', trigger: changed ? 'dispute_fixed' : 'dispute_upheld', actor: 'engine',
        facts: { acctest_changed_tests: changed } });
      out.push(t.id);
    }
  }
  return out;
}

/** 单独合并的 acctest（第 9.5 节）进入 checking 时：把 acc 分支检出为普通 worktree，进入合并时与普通 task 一样 rebase、验证 */
export function checkoutAccWorktree(root: string, flowId: string, t: TaskFile): { path: string; branch: string } {
  const impl = t.for_task ?? t.id;
  const branch = accBranch(flowId, impl);
  const wt = worktreePath(root, flowId, t.id);
  removeWorktree(root, wt);
  git(root, ['worktree', 'add', '-q', wt, branch]);
  return { path: wt, branch };
}

export type AcctestCheck = { ok: true } | { ok: false; reason: string; dirs: string[] };

/** 单独合并的预检：在 acc 分支（集成分支 + 测试补丁）的 worktree 中带资源跑 acceptance -- <impl> */
export async function precheckAcctest(root: string, store: StateStore, config: FlowConfig, flowId: string, t: TaskFile, timeoutMs?: number): Promise<AcctestCheck> {
  const impl = t.for_task ?? t.id;
  const cmd = config.commands['acceptance']?.trim();
  if (!cmd || !t.worktree) return { ok: true };
  return withResources(root, `pc-${flowId}-${t.id}`, resourceOptions(config), async (env) => {
    const r = await runShell(`${cmd} -- ${impl}`, t.worktree!, timeoutMs, env);
    await store.saveEvidence(flowId, t.id, 'precheck-acceptance.log', evidenceText({ command: 'acceptance', ...r }, `${cmd} -- ${impl}`), 'precheck');
    return r.exit_code === 0 ? { ok: true } : { ok: false, reason: `验收测试在已有实现上失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output)}`, dirs: failingAcceptanceDirs(r.output) };
  });
}

/** 测试在已有实现上失败（预检或合并验证，失败都在本目录）：acctest 以 report 结束，为原 impl 建 .fx-n */
export async function handOffToFix(root: string, store: StateStore, flowId: string, t: TaskFile, reason: string, actor: string): Promise<string> {
  const impl = t.for_task ?? t.id;
  await store.transitionTask(flowId, t.id, { to: 'done', trigger: 'precheck_fail_handoff', actor,
    facts: { [t.status === 'checking' ? 'precheck_ok' : 'post_verify_ok']: false, failed_tests_own_directory: true, reason: reason.slice(0, 2000) } });
  if (t.worktree && existsSync(t.worktree) && t.worktree.startsWith(worktreesRoot(root))) removeWorktree(root, t.worktree);
  const fx = await createFixRound(root, store, flowId, impl, [
    `# ${impl} 的验收测试在已有实现上失败（${t.id}）`, reason,
    '工作区已包含这批测试。修改实现让它们通过；认为测试不符合规格时用 forge_dispute（引用规格或契约的具体位置），不要改测试。',
  ].join('\n\n'), actor);
  return fx.id;
}

/** 别的 task 的验收测试被破坏（第 9.4 节）：为每个 task 建 .at-n（附失败输出与本 task 追加的契约），当前 task 等它们 done */
export async function handleForeignBreak(root: string, store: StateStore, flowId: string, t: TaskFile, dirs: readonly string[], output: string, actor: string): Promise<string[]> {
  const created: string[] = [];
  const cur = store.readTask(flowId, t.id);
  const contracts = cur.worktree && cur.base_sha && gitOk(cur.worktree, ['rev-parse', '--verify', '-q', 'HEAD'])
    ? git(cur.worktree, ['diff', cur.base_sha, 'HEAD', '--', 'docs/contracts']).slice(0, 6000) : '';
  for (const impl of dirs) {
    const tasks = store.listTasks(flowId);
    if (!tasks.some((x) => x.id === impl)) continue;
    const pending = latestAcctest(tasks, impl);
    if (pending && pending.status !== 'done' && pending.acctest_round?.kind === 'foreign') { created.push(pending.id); continue; }
    const at = await createAcctestRound(store, flowId, impl, { kind: 'foreign', from_task: t.id }, [
      `# 你的验收测试被 ${t.id} 的改动破坏了`,
      `${t.id} 正当地追加了契约，你的测试因此失败，多半是断言了规格没规定的东西（例如整个响应精确相等、没规定的顺序）。改成只断言规格规定的部分，不要删用例。`,
      `失败输出：\n${failureSummary(output, 3000)}`,
      contracts ? `${t.id} 对契约的改动：\n${contracts}` : '',
    ].filter(Boolean).join('\n\n'), actor);
    created.push(at.id);
  }
  await store.transitionTask(flowId, t.id, { to: 'awaiting_inputs', trigger: 'foreign_tests_broken', actor,
    facts: { foreign_acceptance_failed: true, waits_for: created, reason: `等 ${created.join('、')} 修好被破坏的验收测试` } });
  return created;
}

/** 隔离工作区目录（acctest 进入单独合并后不再需要） */
export function dropIsolatedWorkspace(root: string, t: Pick<TaskFile, 'worktree'>): void {
  if (t.worktree && t.worktree.endsWith('-at') && t.worktree.startsWith(worktreesRoot(root))) rmSync(t.worktree, { recursive: true, force: true });
}

/** 某个 task 的验收测试目录在工作区里存在（预检据此决定是否跑 acceptance） */
export const hasAcceptanceDir = (wt: string, impl: string) => existsSync(path.join(wt, 'tests/acceptance', impl));
export const readIn = (dir: string) => (rel: string): string | null => { try { return readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };

/**
 * /forge-decide（第 9.3 节）：争议交给用户后由用户裁决。keep-test 维持测试，worker 接着改实现；
 * fix-test 按说明改测试，新建 .at-n（附用户说明），done 后走 dispute_fixed。没完成的上一轮 .at-n 取消。
 */
export async function decideDispute(store: StateStore, flowId: string, taskId: string, choice: 'keep-test' | 'fix-test', note: string): Promise<string> {
  const t = store.readTask(flowId, taskId);
  if (t.status !== 'blocked' || t.blocked_by !== 'dispute') throw new Error(`${taskId} 不是因争议而阻塞的任务（当前 ${t.status}${t.blocked_by ? `，${t.blocked_by}` : ''}）。`);
  const impl = t.for_task ?? t.id;
  const stale = latestAcctest(store.listTasks(flowId), impl);
  if (stale && ['pending', 'ready', 'blocked'].includes(stale.status)) {
    await store.transitionTask(flowId, stale.id, { to: 'cancelled', trigger: 'cancel', actor: 'human', facts: { reason: `用户已裁决争议（${choice}）` } });
  }
  if (choice === 'keep-test') {
    await store.transitionTask(flowId, taskId, { to: 'in_progress', trigger: 'decide_keep', actor: 'human', facts: { reason: note || '维持测试' } });
    await store.appendHandoff(flowId, taskId, `## 用户裁决：维持测试\n${note || '（无说明）'}\n按测试修改实现。`, 'human');
    return `已裁决：维持 ${impl} 的验收测试，${taskId} 接着修改实现。`;
  }
  if (!note.trim()) throw new Error('fix-test 需要写明怎么改测试：/forge-decide <任务> fix-test "<说明>"');
  await store.transitionTask(flowId, taskId, { to: 'disputed', trigger: 'decide_fix', actor: 'human', facts: { reason: note } });
  const last = [...store.readHandoff(flowId, taskId).matchAll(/## 争议：([^\n]+)/g)].at(-1)?.[1];
  const at = await createAcctestRound(store, flowId, impl, { kind: 'decide', ...(last ? { test: last } : {}), from_task: taskId }, [
    `# 用户裁决：按说明修改测试${last ? `（${last}）` : ''}`, note, '按说明修改测试，在 handoff 写明改了什么，然后 forge_submit。',
  ].join('\n\n'), 'human');
  return `已裁决：按说明修改测试，已派 ${at.id}；改好后 ${taskId} 重新预检。`;
}
