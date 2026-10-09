// 来源：pi-flow scripts/real-build.ts @ 31f3f15
// 第六轮真实模型冒烟：接收/讨论 → 主 agent 规划 → 模块实施与验收。
//   node scripts/real-build.ts [--keep] [--no-replan] [--dir <已有项目目录>]
// 只批准闸门、转达预设变更；整个实验最多代答一次，不人工放行失败验收。
// 主会话与子进程都用 Workbuddy/glm-5.3-flash high，保留会话和计时报告。
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activePauses, describePause } from '../src/core/model-pause.ts';
import { StateStore } from '../src/core/state-store.ts';
import { costReport, formatRow } from '../src/core/cost.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION = path.join(ROOT, 'src/pi-adapter/extension.ts');
const argv = process.argv.slice(2);
const args = new Set(argv);
const existing = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : undefined;
const DEFAULT_DESC = '做一个纯 JavaScript（ES 模块，Node 24，无第三方依赖）的待办清单库：createTodoList() 返回对象，提供 add(title) 返回带自增 id 的待办、list() 返回全部待办、done(id) 标记完成（id 不存在时抛错）。数据只保存在内存中。代码放在 src/server/todo/，测试用 node:test。';
const desc = argv.includes('--desc') ? argv[argv.indexOf('--desc') + 1]! : DEFAULT_DESC;
// --desc-file：需求较长时用 /forge-build --prd；--feature-file：建完后再做一次功能变更
const descFile = argv.includes('--desc-file') ? path.resolve(argv[argv.indexOf('--desc-file') + 1]!) : undefined;
const featureFile = argv.includes('--feature-file') ? path.resolve(argv[argv.indexOf('--feature-file') + 1]!) : undefined;
const sh = (cwd: string, cmd: string, a: string[]) => execFileSync(cmd, a, { cwd, encoding: 'utf8' }).trim();
const t0 = Date.now();
const stamp = () => `${Math.round((Date.now() - t0) / 1000)}s`;
const step = (s: string) => console.log(`\n\x1b[1m▶ [${stamp()}] ${s}\x1b[0m`);

// 当前正在执行的 pi 命令：脚本被中断时转发 SIGTERM，让它结束自己拉起的 subagent，而不是留下孤儿进程
let current: ReturnType<typeof spawn> | null = null;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，结束正在执行的 pi 命令及其子进程…`);
    if (!current) process.exit(130);
    current.once('close', () => process.exit(130));
    current.kill('SIGTERM');
    setTimeout(() => process.exit(130), 15_000).unref();
  });
}

function pi(cwd: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn('pi', ['-p', '--session-dir', `${cwd}.session`, '--session-id', 'round6-main', '--model', 'Workbuddy/glm-5.3-flash', '--thinking', 'high', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', EXTENSION, ...(message.startsWith('/') ? [message] : ['/forge-resume', message])],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' } });
    let out = '';
    c.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
    c.stderr.on('data', (b) => { out += b; process.stdout.write(b); });
    current = c;
    c.on('close', (code) => { current = null; return code === 0 ? resolve(out) : reject(new Error(`pi 退出码 ${code}`)); });
  });
}

const dir = existing ?? mkdtempSync(path.join(tmpdir(), 'pi-forge-real-build-'));
console.log(`项目目录：${dir}`);
try {
  if (!existing) {
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "todo-lib", "type": "module", "scripts": { "test": "node --test" } }\n');
  sh(dir, 'git', ['add', '.']);
  sh(dir, 'git', ['-c', 'user.name=demo', '-c', 'user.email=demo@local', 'commit', '-q', '-m', '空项目']);

  step('/forge init');
  await pi(dir, '/forge init');
  const wf = path.join(dir, 'workflow.yaml');
  // 纯 JS 项目：没有 typecheck、lint、e2e；测试用 node --test
  writeFileSync(wf, readFileSync(wf, 'utf8').replace(/commands:[\s\S]*?\nlimits:/, `commands:
  install: "true"
  typecheck: "true"
  lint: "true"
  test: "node --test --test-timeout=60000"
  e2e: "node --test --test-timeout=60000"
limits:`));
  sh(dir, 'git', ['add', 'workflow.yaml']);
  sh(dir, 'git', ['-c', 'user.name=demo', '-c', 'user.email=demo@local', 'commit', '-q', '-m', '调整命令']);

  step(descFile ? '/forge-build --prd' : '/forge-build（讨论备用路径）');
  await pi(dir, descFile ? `/forge-build --prd ${JSON.stringify(descFile)}` : `/forge-build ${JSON.stringify(desc)}`);
  }
  const store = new StateStore(dir);
  let replanned = args.has('--no-replan') || !!descFile;
  const correctionsFile = path.join(`${dir}.session`, 'experiment-corrections.json');
  let corrections = Math.max(argv.includes('--corrections-used') ? Number(argv[argv.indexOf('--corrections-used') + 1]) : 0,
    existsSync(correctionsFile) ? Number(JSON.parse(readFileSync(correctionsFile, 'utf8')).count) : 0);
  const recordCorrection = () => {
    corrections++;
    mkdirSync(path.dirname(correctionsFile), { recursive: true });
    writeFileSync(correctionsFile, JSON.stringify({ count: corrections }) + '\n');
  };
  let stopped = false;
  const drive = async () => { for (let i = 0; i < 40; i++) {
    const active = store.readState().active_flow;
    if (!active) return;
    const f = store.readFlow(active);
    const rev = store.readRevision(active);
    const pauses = activePauses(store, new Date());
    if (pauses.length) {
      step(`模型暂停，停止：${pauses.map((p) => describePause(p, new Date())).join('；')}`);
      stopped = true;
      return;
    }
    if (rev?.status === 'proposed') {
      step(`计划修订待批准：${rev.summary}`);
      await pi(dir, '/forge-approve');
      continue;
    }
    if (f.replan_request) {
      step('主 agent 处理待起草的计划修订');
      await pi(dir, '请按用户的计划修订请求起草并用 forge_revise_plan 提交；保持请求中的全部需求与验收标准，提交后等待批准。');
      continue;
    }
    if (f.stage_status === 'awaiting_human') {
      step(`阶段 ${f.stage} 等待批准`);
      if (f.stage === f.stages.at(-1)) {
        await pi(dir, '/forge-status --timing');
        await pi(dir, '/forge report');
      }
      await pi(dir, f.stage === f.stages.at(-1) ? '/forge-approve --yes' : '/forge-approve --rules all');
      continue;
    }
    const stuck = store.listAcceptances(active).find((a) => a.status === 'needs_human');
    if (stuck) {
      step(`${stuck.task} 验收需要人工处理，停止：\n${stuck.results.filter((r) => !r.passed).map((r) => `- ${r.id} ${r.evidence}`).join('\n')}`);
      stopped = true;
      return;
    }
    const blocked = store.listTasks(active).filter((t) => t.status === 'blocked');
    const busy = store.listTasks(active).some((t) => t.lease || ['queued_merge', 'merging', 'ready'].includes(t.status));
    if (blocked.length && !busy) {
      if (corrections >= 1) {
        step(`任务仍阻塞，停止：${blocked.map((t) => `${t.id}：${t.blocked_reason}`).join('；')}`);
        stopped = true;
        return;
      }
      recordCorrection();
      const b = blocked[0]!;
      step(`${b.id} 阻塞：${b.blocked_reason}\n→ 代替用户回答（纠正性干预 ${corrections} 次）`);
      await pi(dir, `/forge unblock ${b.id} "同意你给出的建议（默认方案），按建议继续。不得削弱已有测试或变更需求。"`);
      continue;
    }
    if (!replanned && f.stage === 'E' && store.listTasks(active).some((t) => t.stage === 'E' && t.status === 'done')) {
      replanned = true;
      step('实施中途转达预设计划修订');
      await pi(dir, '/forge replan "还需要 remove(id) 删除待办（id 不存在时抛错），以及 clearDone() 清除已完成的待办"');
      continue;
    }
    if (['D0', 'D2'].includes(f.stage) || f.replan_request) {
      const before = JSON.stringify([f.requirements, f.planning, f.replan_request]);
      step(`阶段 ${f.stage} → 主 agent 按下一步指引处理`);
      const output = await pi(dir, '请按当前流程的下一步指引处理接收、需求讨论、规划或计划修订；完成需要的 forge_* 提交后停止，等待用户批准。');
      const after = store.readFlow(active);
      if (JSON.stringify([after.requirements, after.planning, after.replan_request]) === before) {
        if (corrections >= 1) { step(`主 agent 没有推进，停止：${output.slice(-1200)}`); stopped = true; return; }
        recordCorrection();
        step(`代替用户回答（纠正性干预 ${corrections} 次）`);
        await pi(dir, '同意你给出的建议（默认方案），按建议继续。保持原需求与验收标准。');
      }
      continue;
    }
    step(`阶段 ${f.stage}（${f.stage_status}）→ /forge next`);
    await pi(dir, '/forge next');
  }
  if (store.readState().active_flow) { step('超过脚本 40 轮上限，停止'); stopped = true; }
  };
  await drive();
  const buildEnd = Date.now();
  if (featureFile && !stopped && !store.readState().active_flow) {
    step(`需求变更：/forge-build --feature --prd ${featureFile}`);
    await pi(dir, `/forge-build --feature --prd ${JSON.stringify(featureFile)}`);
    await drive();
    step(`变更耗时 ${Math.round((Date.now() - buildEnd) / 1000)}s（新建部分 ${Math.round((buildEnd - t0) / 1000)}s）`);
    const feat = store.listFlows().find((id) => store.readFlow(id).mode === 'feature');
    if (feat) { const c = costReport(store, { flow: feat }); console.log(`变更流程 ${feat}：${formatRow(c.total)}`); for (const r of c.byRole) console.log(formatRow(r)); }
  }
  step('结果');
  console.log(`纠正性干预：${corrections} 次；完整结束：${!stopped && !store.readState().active_flow}`);
  await pi(dir, '/forge-status --timing');
  await pi(dir, '/forge report');
  console.log(sh(dir, 'git', ['log', '--oneline', '--first-parent', 'main']));
  const flowId = store.listFlows().find((id) => store.readFlow(id).mode === 'build') ?? store.listFlows().at(-1)!;
  const flow = store.readFlow(flowId);
  console.log(`\n流程 ${flowId}：${flow.stage}/${flow.stage_status}，耗时 ${stamp()}`);
  for (const t of store.listTasks(flowId)) console.log(`- ${t.id} [${t.stage}/${t.kind}] ${t.title}（${t.role}）${t.status}${t.attempts ? ` 返工 ${t.attempts}` : ''}${t.blocked_reason ? ` 阻塞：${t.blocked_reason.slice(0, 120)}` : ''}`);
  try { console.log(`\n测试：${sh(dir, 'node', ['--test', '--test-reporter=tap']).split('\n').filter((l) => /^# (pass|fail)/.test(l)).join('，')}`); } catch (e) { console.log(`测试失败：${String(e).slice(0, 500)}`); }
  const cost = costReport(store, { flow: flowId });
  console.log(`\n${formatRow(cost.total)}`);
  for (const r of cost.byRole) console.log(formatRow(r));
  console.log(`\n知识库：${store.readKnowledge().entries.map((e) => `${e.id}[${e.status}] ${e.content.slice(0, 80)}`).join('\n  ') || '（空）'}`);
  const ev = store.readEvents().filter((e) => e.flow === flowId);
  console.log(`\n违规 ${ev.filter((e) => e.type === 'violation').length} 次：${ev.filter((e) => e.type === 'violation').map((e) => (e.reason ?? '').slice(0, 100)).join('\n  ')}`);
  console.log(`合并后验证失败 ${ev.filter((e) => e.trigger === 'merge_verify_fail').length} 次`);
  // 工具调用统计（来自会话留档；codemode 脚本内部的调用不单独计）
  const { summarizeSession, findSessionFile } = await import('../src/core/session-log.ts');
  const calls = new Map<string, { runs: number; calls: number; errors: number }>();
  for (const r of store.listRuns().filter((x) => x.flow === flowId)) {
    const f = r.session_file ?? (r.session_dir ? findSessionFile(r.session_dir) : null);
    const row = calls.get(r.role) ?? { runs: 0, calls: 0, errors: 0 };
    row.runs++;
    if (f && existsSync(f)) { const s = summarizeSession(f); row.calls += s.toolCalls.length; row.errors += s.toolCalls.filter((c) => c.error).length; }
    calls.set(r.role, row);
  }
  console.log(`\n工具调用（顶层，按角色）：`);
  for (const [role, c] of calls) console.log(`  ${role}：${c.runs} 次运行，${c.calls} 次工具调用，其中失败 ${c.errors} 次`);
  const runs = store.listRuns().filter((x) => x.flow === flowId);
  console.log(`升级模型的运行 ${runs.filter((r) => r.escalated).length} 次；被终止 ${runs.filter((r) => r.outcome === 'killed').length} 次；接着上次对话的返工 ${runs.filter((r) => r.forked_from).length} 次；模型暂停 ${runs.filter((r) => r.outcome === 'unavailable').length} 次`);
  console.log(`完整性校验：${(await store.verifyIntegrity()).ok ? '通过' : '失败'}`);
  if (stopped || store.readState().active_flow) process.exitCode = 1;
} finally {
  if (!args.has('--keep') && process.exitCode !== 1) { rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.worktrees`, { recursive: true, force: true }); }
}
