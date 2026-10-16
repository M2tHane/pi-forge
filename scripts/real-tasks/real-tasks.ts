// 真实模型小规模实验：跳过 orchestrator、P0、P1，在一个现成项目（套件 suites/：mini-boards 小项目、pi-forge 自身约 1.9 万行）上直接种下 S1 的若干 task，
// 用真实 pi 子进程跑 worker → reviewer → 合并 → 阶段门禁（覆盖率、全量测试）→ stage-qa，直到阶段等待签收、需要人工或超时。
// 目的：观察子 agent 撞墙（guard 拦截）、阻塞、返工与完成情况。其中几个 task 是故意的极端情况（见各套件的注释）。
// 用法：node scripts/real-tasks/real-tasks.ts [--suite mini-boards|pi-forge] --model magpie/workbuddy/glm-5.3-flash [--thinking medium]
//       [--reasoning-model magpie/codex/gpt-6.1-sol --reasoning-thinking medium]   # architect、reviewer、stage-qa 用的模型；缺省同 --model
//       [--out <目录>] [--max-min 90] [--parallel 3] [--tasks T-001,T-003] [--poll-sec 15] [--prepare-only]
// 脚本只在结束时读 .forge/ 留档（status、detail、metrics、events、handoffs）；中途只打印一行状态。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { Engine } from '../../src/core/engine/dispatcher.ts';
import { PiLauncher } from '../../src/pi-adapter/launcher.ts';
import { loadConfig } from '../../src/core/state/config.ts';
import type { RoleSettingsFile, ThinkingLevel } from '../../src/core/state/schemas.ts';
import { StateStore } from '../../src/core/state/state-store.ts';
import { miniBoards } from './suites/mini-boards.ts';
import { piForge } from './suites/pi-forge.ts';
import type { Suite } from './suites/types.ts';
import { ensureIntegrationBranch } from '../../src/core/workspace/worktree.ts';
import { renderStatus, statusLine } from '../../src/core/ops/status-view.ts';
import { renderDetail, renderMetricsView } from '../../src/core/ops/status-detail.ts';
import { isSettled } from '../../src/core/state/state-machine.ts';
import { playwrightSkillDir } from '../../src/core/workspace/dependencies.ts';
import { packageRoots } from '../../src/pi-adapter/plugins.ts';
import { homedir } from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SUITES: Record<string, Suite> = { 'mini-boards': miniBoards, 'pi-forge': piForge };

// —— 参数 ——

const argv = process.argv.slice(2);
const get = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const suiteName = get('--suite', 'mini-boards');
const suite = SUITES[suiteName];
if (!suite) throw new Error(`未知套件 ${suiteName}（可选：${Object.keys(SUITES).join('、')}）`);
const model = get('--model', 'magpie/workbuddy/glm-5.3-flash');
const thinking = get('--thinking', 'medium') as ThinkingLevel;
const reasoningModel = get('--reasoning-model', model);
const reasoningThinking = get('--reasoning-thinking', thinking) as ThinkingLevel;
const prepareOnly = argv.includes('--prepare-only');
const out = path.resolve(get('--out', path.join('/tmp/pi-forge-real', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
const maxMin = Number(get('--max-min', '90'));
const parallel = Number(get('--parallel', '3'));
const only = get('--tasks', '').split(',').map((s) => s.trim()).filter(Boolean);
const pollSec = Number(get('--poll-sec', '15'));

const STAGE = 'S1';

// —— 项目准备 ——

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function writeWorkflow(dir: string): void {
  const doc = parseDocument(readFileSync(path.join(ROOT, 'templates/workflow.yaml'), 'utf8'));
  doc.set('project', suite.project);
  doc.set('commands', suite.commands);
  doc.set('generated_paths', []);
  doc.set('shared_env', { enabled: false });
  doc.setIn(['limits', 'max_parallel'], parallel);
  doc.setIn(['limits', 'run_minutes'], suite.runMinutes);
  doc.setIn(['limits', 'lease_minutes'], 30);
  doc.setIn(['models', 'strong'], reasoningModel);
  doc.setIn(['models', 'medium'], reasoningModel);
  doc.setIn(['models', 'cheap'], model);
  // 子进程里没有 codegraph 插件与 codemode，去掉这些工具组
  const roles = doc.get('roles') as { items: { key: unknown; value: { get(k: string): unknown; set(k: string, v: unknown): void } }[] };
  for (const r of roles.items) {
    const tools = r.value.get('tools') as { items: { value: string }[] } | undefined;
    if (tools) r.value.set('tools', tools.items.map((t) => t.value).filter((t) => !/^@codegraph$|^codemode$/.test(t)));
  }
  writeFileSync(path.join(dir, 'workflow.yaml'), String(doc));
}

async function prepare(): Promise<{ dir: string; store: StateStore; flowId: string }> {
  const dir = path.join(out, 'project');
  if (existsSync(dir)) throw new Error(`${dir} 已存在，换一个 --out`);
  mkdirSync(dir, { recursive: true });
  suite.prepare(dir);
  writeWorkflow(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=exp', '-c', 'user.email=exp@x', 'add', '-A');
  git(dir, '-c', 'user.name=exp', '-c', 'user.email=exp@x', 'commit', '-q', '-m', 'S0：骨架、共享代码、规则、冒烟测试');
  const config = loadConfig(path.join(dir, 'workflow.yaml'));
  const store = await StateStore.init(dir, { limits: config.limits });
  const sha = git(dir, 'rev-parse', 'HEAD');
  const flow = await store.createFlow({ mode: 'build', title: suite.title, stages: [STAGE], base_sha: sha });
  ensureIntegrationBranch(dir, flow.integration_branch, sha);
  const chosen = suite.tasks.filter((t) => !only.length || only.includes(t.task.id));
  const ids = new Set(chosen.map((t) => t.task.id));
  for (const t of chosen) t.task.depends_on = t.task.depends_on.filter((d) => ids.has(d.task));
  const reqs = [...new Set(chosen.flatMap((t) => (t.task.ac ?? []).map((a) => a.split('.')[0]!)))];
  await store.setStages(flow.id, [{ id: STAGE, goal: suite.stageGoal, exit: reqs }]);
  await store.addTasks(flow.id, chosen.map((t) => t.task), 'architect');
  const spec = readFileSync(path.join(dir, 'docs/spec/requirements.md'), 'utf8');
  for (const t of chosen) {
    const acText = (t.task.ac ?? []).map((ac) => {
      const [req, n] = ac.split('.');
      const block = spec.split(/^### /m).find((b) => b.startsWith(req!)) ?? '';
      const line = block.split('\n').find((l) => l.startsWith(`- ${n}：`)) ?? '';
      return `- ${ac}：${line.replace(/^- AC\d+：/, '') || '（规格中找不到原文）'}`;
    });
    await store.appendHandoff(flow.id, t.task.id, ['## 任务说明', t.brief, '', '## 负责的 AC', ...acText].join('\n'), 'engine');
  }
  return { dir, store, flowId: flow.id };
}

// —— 运行 ——

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const { dir, store, flowId } = await prepare();
  if (prepareOnly) { console.log(`已准备：${dir}`); process.exit(0); }
  const config = loadConfig(path.join(dir, 'workflow.yaml'));
  const settings: RoleSettingsFile = { version: 1, roles: {
    worker: { model, thinking },
    ...Object.fromEntries(['architect', 'reviewer', 'stage-qa'].map((r) => [r, { model: reasoningModel, thinking: reasoningThinking }])),
  } };
  const log = (line: string) => { const s = `${new Date().toISOString().slice(11, 19)} ${line}`; console.log(s); writeFileSync(path.join(out, 'run.log'), s + '\n', { flag: 'a' }); };
  const engine = new Engine({
    root: dir, store, config, launcher: new PiLauncher(),
    roleSettings: () => settings,
    packageAgentsDir: path.join(ROOT, 'agents'),
    subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
    packageSkillsDir: path.join(ROOT, 'skills'),
    promptVars: (): Record<string, string> => { const d = playwrightSkillDir(packageRoots(dir, process.env['PI_CODING_AGENT_DIR'] ?? path.join(homedir(), '.pi', 'agent'))); return d ? { 'playwright-browser': d } : {}; },
    onError: (e) => log(`程序步骤出错：${(e as Error).stack ?? String(e)}`),
    onMerge: (r) => log(`合并：${JSON.stringify(r).slice(0, 300)}`),
    onGate: (r) => log(`闸门：${JSON.stringify(r).slice(0, 300)}`),
  });
  engine.startLeaseWatch();
  log(`套件 ${suite.name}；项目 ${dir}；worker ${model}（${thinking}）；architect/reviewer/stage-qa ${reasoningModel}（${reasoningThinking}）；task ${store.listTasks(flowId).map((t) => t.id).join('、')}`);
  const started = Date.now();
  let lastLine = '';
  let quiet = 0;
  let stop = '';
  const finish = async (why: string) => {
    stop = why;
    engine.killAll();
    log(`结束：${why}`);
    const sections = [
      ['status.txt', renderStatus(store, config)],
      ['detail.txt', renderDetail(store, config)],
      ['metrics.txt', renderMetricsView(store, new Date(), dir)],
      ['events.jsonl', store.readEvents().map((e) => JSON.stringify(e)).join('\n')],
      ['handoffs.md', store.listTasks(flowId).map((t) => `# ${t.id} ${t.title}（${t.status}）\n\n${store.readHandoff(flowId, t.id)}`).join('\n\n---\n\n')],
      ['runs.json', JSON.stringify(store.listRuns(), null, 2)],
    ] as const;
    for (const [name, text] of sections) writeFileSync(path.join(out, name), text);
    const violations = store.readEvents().filter((e) => e.type === 'violation');
    writeFileSync(path.join(out, 'violations.md'), violations.map((v) => `- ${v.task ?? '-'} ${v.data?.['role']}/${v.data?.['rule']}：${v.reason}\n  ${v.data?.['detail'] ?? ''}`).join('\n') || '（没有被拦下的操作）');
    console.log('\n' + renderStatus(store, config) + '\n\n' + renderMetricsView(store, new Date(), dir) + `\n\n留档：${out}`);
  };
  process.on('SIGINT', () => { void finish('用户中断').then(() => process.exit(130)); });
  while (!stop) {
    try { await engine.pump(flowId); } catch (e) { log(`pump 出错：${(e as Error).message}`); }
    for (const w of [...engine.checkLeases(), ...(await engine.checkDeadlines())]) log(w);
    const flow = store.readFlow(flowId);
    const tasks = store.listTasks(flowId);
    const line = `${statusLine(store, config) ?? ''} | ${tasks.map((t) => `${t.id}:${t.status}`).join(' ')} | 运行中 ${engine.activeRuns().length}`;
    if (line !== lastLine) { log(line); lastLine = line; quiet = 0; } else quiet++;
    if (['awaiting_human', 'needs_human', 'done', 'aborted'].includes(flow.stage_status)) { await finish(`阶段 ${flow.stage} ${flow.stage_status}`); break; }
    const live = tasks.filter((t) => t.status !== 'cancelled');
    if (!engine.activeRuns().length && live.every((t) => isSettled(t) || t.status === 'blocked') && quiet >= 3) { await finish('没有可推进的任务（全部完成或阻塞）'); break; }
    if (Date.now() - started > maxMin * 60_000) { await finish(`超过 ${maxMin} 分钟`); break; }
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
