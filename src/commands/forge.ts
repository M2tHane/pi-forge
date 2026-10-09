// 来源：pi-flow src/commands/flow.ts @ 31f3f15（改名）
// /forge 子命令的业务实现（不依赖 Pi）：init、doctor、resume、status、next。M6、M7 在此扩展 approve、unblock、--cost。
import { formatTiming, timingReport } from '../core/timing.ts';
import { DEFAULT_CHECKPOINT_MINUTES, listCheckpoints, restoreCheckpoint } from '../core/checkpoints.ts';
import { finishReport } from '../core/finish-report.ts';
import type { FlowConfig } from '../core/config.ts';
import type { StateStore } from '../core/state-store.ts';
import type { Engine } from '../core/dispatcher.ts';
import type { RoleSettingsFile } from '../core/schemas.ts';
import { initProject, formatInit } from '../core/init.ts';
import { doctor, formatDoctor } from '../core/doctor.ts';
import { resume, type DecisionAnswer } from '../core/resume.ts';
import { formatPreflight } from '../core/preflight.ts';
import { activeFlowId, statusText } from '../tools/orchestrator-tools.ts';
import { splitArgs } from './args.ts';
import { approveStage, rejectStage, unblockTask, startFlow } from '../core/stages.ts';
import { importInputs, intakeBrief, type IntakeInput } from '../core/intake.ts';
import { DESIGN_STAGES } from '../modes/plan.ts';
import { FINAL_REVIEW_DOC, FinalReviewError, describeReview, finishReview, fixFindings } from '../core/final-review.ts';
import { addRequirement } from '../core/additions.ts';
import { acceptManually } from '../core/acceptance.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { costReport, formatCost } from '../core/cost.ts';
import { renderStatus, visibleFlows } from '../core/status-view.ts';
import { applyDrafts, formatDrafts, listDrafts, type Draft } from '../core/rules-draft.ts';
import { findSessionFile, formatRunDetail, summarizeSession } from '../core/session-log.ts';
import { budgetState, formatBudget } from '../core/cost-control.ts';
import { RevisionError, approveRevision, rejectRevision, requestReplan } from '../core/revision.ts';
import { KnowledgeError, acceptCandidate, formatKnowledgeList, markPromoted, promoteToDraft, retireEntries, searchKnowledge } from '../core/knowledge.ts';
import { loadConfig } from '../core/config.ts';
import { checkDependencies } from '../core/dependencies.ts';
import { activePauses, describePause, matchPausedModel } from '../core/model-pause.ts';
import { git } from '../core/git.ts';
import type { StateStore as Store } from '../core/state-store.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface FlowUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}

export interface EngineHandle { store: StateStore; engine: Engine; config: FlowConfig }

export interface CommandEnv {
  root: string;
  packageRoot: string;
  ui: FlowUi | null;
  /** 取得（必要时创建）本会话的引擎；会获取引擎锁，被其他会话持有时抛错 */
  engine(): EngineHandle;
  /** 只读访问状态（不获取引擎锁） */
  store(): StateStore;
  roleSettings(): RoleSettingsFile;
  availableModels(): string[];
  /** 进入调度模式（orchestrator）：收窄工具、切换到 orchestrator 的模型；返回提示信息 */
  activateOrchestrator(): Promise<string | void> | string | void;
  /** 退出调度模式：恢复进入前的模型、思考级别与工具 */
  deactivateOrchestrator?(): Promise<string> | string;
  /** 非交互模式：命令结束后进程退出，需要等待引擎跑完 */
  waitForIdle: boolean;
  /** 以用户身份给主会话发一条消息、开始一轮（需求讨论开始时让主 agent 先提问）；非交互模式不提供 */
  startConversation?(text: string): void;
  /** 当前 Pi 版本与 Pi 包的安装位置（用于依赖检查）；测试环境可不提供 */
  dependencies?(): { piVersion: string; packageRoots: string[] };
}

export const FLOW_USAGE = [
  '用法：',
  '  /forge-status            当前处于哪个阶段（接收或需求 → 规划 → 实施 → 完成）、进度、正在做什么、需要你处理什么',
  '  /forge-status --detail   完整的任务列表与内部状态',
  '  /forge next              由程序选择 ready 任务并派发',
  '  /forge-resume            会话丢失后恢复，并进入调度模式',
  '  /forge off               退出调度模式，恢复原来的模型与工具（流程状态不变）',
  '  /forge doctor [--fix]    状态完整性与前置条件检查；--fix 清理残留 worktree 与提示文件',
  '  /forge init              初始化项目骨架（可重复执行，不覆盖）',
  '  /forge-approve [--yes]   批准当前阶段（仅用户）；实施阶段批准时把集成分支合入主分支',
  '                          规划阶段批准时应用项目专属规则（--rules none 不应用）',
  '  /forge-reject "<意见>"   打回需求或规划（或待批准的计划修订）：主 agent 带着意见修改后重新提交',
  '  /forge-add "<需求>" [--task <任务>]   中途追加需求：送到正在做的模块；有多个模块时交给主 agent 安排',
  '  /forge accept <任务>     验收"需要你处理"时人工放行这个模块',
  '  /forge review [fix <R-编号>... | done]   最终代码审查（review.final 开启时）：查看结论；挑选要修的建议；其余不修、结束审查',
  '  /forge answer [<任务>]   回答阻塞任务提出的问题（弹出输入框），回答后任务继续',
  '  /forge unblock <任务> ["<回答>"] [--attempts N]   解除阻塞（无界面时用它回答）',
  '  /forge gate              闸门失败并修复后，重跑当前阶段闸门',
  '  /forge rules [apply [all|<草案文件>...]]   查看或应用规则与命令草案（docs/rules-draft/，来自规划或知识提升）',
  '  /forge models [resume <模型>|all]   查看因额度用完、限流而暂停的模型；resume 立即恢复派发',
  '  /forge budget [tokens|cost|minutes <数值>]   查看或设置本流程的预算（minutes 不含等你的时间）；超出后暂停派发新任务',
  '  /forge checkpoint [restore <任务>]  列出运行中自动拍的工作区检查点；工作区被改坏时恢复',
  '  /forge report                      收尾汇报：做了什么、各模块结果、要你打开查看的条目、需要确认的地方、用时与用量',
  '  /forge replan "<要改什么>"   执行中修订计划：主 agent 起草（新增模块、调整或取消未开始的模块），你批准后生效',
  '  /forge sync              把主分支同步进集成分支（每个阶段开始时自动执行）',
  '  /forge run [<run_id>]    某次子进程运行的工具调用摘要与最后的回复（会话留档）；不给 id 时列出最近的运行',
  '  /forge knowledge [...]   项目知识库：列出、搜索、确认候选、废弃、提升为规则草案（/forge knowledge help）',
  '  /forge-status --timing   耗时分布：各阶段、子进程按角色与结果、合并排队与验证、阻塞、最长的任务（--json 输出 JSON）',
  '  /forge-status --cost     成本统计：按流程、阶段、角色、模型、任务汇总 token 与耗时，返工最多的任务',
  '  /forge abort [--yes]     中止当前修复或流程（集成分支保留，主分支不受影响）',
].join('\n');

/** 命令作用的流程：等待用户处理的修复 > 活动的 build/feature 流程 > 进行中的修复 */
export function currentFlowId(store: Store): string {
  const fix = store.openFixFlow();
  if (fix?.stage_status === 'awaiting_human') return fix.id;
  const active = store.readState().active_flow;
  if (active) return active;
  if (fix) return fix.id;
  return activeFlowId(store);
}

function fullStatus(store: Store, engine: Engine | null): string {
  const parts: string[] = [];
  const active = store.readState().active_flow;
  if (active) parts.push(statusText(store, engine, active));
  const fix = store.openFixFlow();
  if (fix) {
    parts.push(statusText(store, engine, fix.id));
    if (fix.stage_status === 'awaiting_human') {
      const why = [...store.readEvents()].reverse().find((e) => e.flow === fix.id && e.type === 'gate_result')?.reason ?? '';
      parts.push(`修复 ${fix.id} 等待你决定：${why}\n继续按修复处理 → /forge-approve；改用功能流程 → /forge abort 后 /forge-build --feature "<描述>"`);
    }
  }
  if (!parts.length) parts.push('当前没有进行中的流程。开始：/forge-build "<描述>"、/forge-build --feature "<描述>" 或 /forge-fix "<描述>"。');
  const recent = store.readKnowledge().entries.filter((e) => e.status === 'active' || e.status === 'candidate').slice(-5);
  if (recent.length) parts.push(`最近的项目知识（全部：/forge knowledge）：\n${formatKnowledgeList(recent)}`);
  return parts.join('\n\n');
}

function formatPauses(store: Store): string {
  const now = new Date();
  const pauses = activePauses(store, now);
  if (!pauses.length) return '没有被暂停的模型。';
  return `被暂停的模型：\n${pauses.map((p) => `- ${describePause(p, now)}`).join('\n')}\n恢复：/forge models resume <模型>；或用 /forge-config 给受影响的角色换模型（换后立即继续）。`;
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const positional = (argv: string[]) => argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--') && argv[i - 1] !== '--yes'));

const DECIDE_CONTINUE = '继续：保留未提交的改动，重新派发给原角色';
const DECIDE_DISCARD = '丢弃：清除未提交的改动，任务回到 ready';

export async function runFlowCommand(args: string, env: CommandEnv): Promise<string> {
  const argv = splitArgs(args);
  const sub = argv[0] ?? 'status';
  switch (sub) {
    case 'init': {
      const r = await initProject(env.root, env.packageRoot, env.dependencies?.());
      return `${formatInit(r)}\n\n前置条件：\n${formatPreflight(r.preflight)}\n\n下一步：执行 /forge-config 为各角色选择模型，然后 /forge-build 开始。`;
    }
    case 'doctor': {
      let days: number | undefined;
      try { days = loadConfig(path.join(env.root, 'workflow.yaml')).limits.session_retention_days; } catch { /* 配置错误由前置条件检查报告 */ }
      const r = await doctor(env.root, env.store(), { fix: argv.includes('--fix'), preflight: { roleSettings: env.roleSettings(), availableModels: env.availableModels(), ...env.dependencies?.() },
        ...(days ? { sessionRetentionDays: days } : {}) });
      return formatDoctor(r);
    }
    case 'resume': {
      const h = env.engine();
      const active = new Set(h.engine.activeRuns().map((r) => r.run_id));
      const r = await resume({ root: env.root, store: h.store, config: h.config, activeRunIds: active }, env.ui ? async (q) => {
        const pick = await env.ui!.select(`${q.task} 的租约已过期，worktree 有未提交的改动：\n${q.changes.slice(0, 10).join('\n')}`, [DECIDE_CONTINUE, DECIDE_DISCARD]);
        return pick === DECIDE_CONTINUE ? 'continue' : pick === DECIDE_DISCARD ? ('discard' as DecisionAnswer) : undefined;
      } : undefined);
      if (!r.ok) return r.brief;
      await env.activateOrchestrator();
      const flowId = h.store.readState().active_flow;
      if (flowId) {
        await h.engine.pump(flowId);
        h.engine.startLeaseWatch();
        if (env.waitForIdle) await h.engine.idle();
      }
      return r.brief;
    }
    case 'status': {
      const store = env.store();
      if (argv.includes('--cost')) {
        const config = loadConfig(path.join(env.root, 'workflow.yaml'));
        const budgets = visibleFlows(store).flatMap((f) => { const b = budgetState(store, config, f); return b ? [`${f.id} ${formatBudget(b)}`] : []; });
        return [formatCost(costReport(store), store.listFixLogs()), ...budgets].join('\n\n');
      }
      if (argv.includes('--detail')) return fullStatus(store, null);
      if (argv.includes('--timing')) {
        const flows = visibleFlows(store);
        if (!flows.length) return '没有进行中的流程。';
        const reports = flows.map((f) => timingReport(store, f.id));
        return argv.includes('--json') ? JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) : reports.map(formatTiming).join('\n\n');
      }
      return renderStatus(store, loadConfig(path.join(env.root, 'workflow.yaml')));
    }
    case 'abort': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const flow = h.store.readFlow(flowId);
      if (!argv.includes('--yes')) {
        const msg = `中止 ${flow.id}「${flow.title}」：运行中的子进程会被终止，集成分支与 worktree 保留，主分支不受影响。`;
        if (!env.ui) return `${msg}\n确认请执行 /forge abort --yes`;
        if ((await env.ui.select(`${msg}确认？`, ['确认中止', '取消'])) !== '确认中止') return '已取消。';
      }
      for (const r of h.engine.activeRuns().filter((x) => x.flow === flowId)) h.engine.kill(r.run_id);
      await h.store.transitionStage(flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
      return `已中止 ${flowId}。${flow.mode === 'fix' ? '如需改用功能流程：/forge-build --feature "<描述>"' : ''}`;
    }
    case 'next': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      // 先推进程序步骤：引擎重启后，已提交、排队合并的任务（第四轮起提交直接进合并队列）只有 pump 会处理
      const before = new Set(h.engine.activeRuns().map((r) => r.run_id));
      await h.engine.pump(flowId);
      await h.engine.next(flowId);
      const d = h.engine.activeRuns().filter((r) => !before.has(r.run_id));
      const head = d.length ? `已派发：${d.map((x) => `${x.task} → ${x.role}（run ${x.run_id}）`).join('；')}` : '没有可派发的任务。';
      if (env.waitForIdle) await h.engine.idle();
      return `${head}\n\n${renderStatus(h.store, h.config)}`;
    }
    case 'approve': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      if (h.store.readFlow(flowId).mode === 'fix') return '修复不需要批准：合并后由验收者确认，通过即合入主分支。验收"需要你处理"时用 /forge accept <任务> 放行。';
      if (h.store.readRevision(flowId)?.status === 'proposed') {
        const text = await approveRevision({ root: env.root, store: h.store, config: h.config }, flowId);
        await h.engine.pump(flowId);
        const d = await h.engine.next(flowId);
        if (env.waitForIdle) await h.engine.idle();
        return `${text}${d.length ? `\n已派发：${d.map((x) => `${x.task} → ${x.role}`).join('；')}` : ''}\n\n${renderStatus(h.store, h.config)}`;
      }
      const flow = h.store.readFlow(flowId);
      if (flow.stage === flow.stages.at(-1) && flow.stage_status === 'awaiting_human' && !argv.includes('--yes')) {
        const msg = `批准阶段 ${flow.stage} 将把 ${flow.integration_branch} 合入 ${h.config.raw.main_branch}，流程随之结束。`;
        if (!env.ui) return `${msg}\n确认请执行 /forge-approve --yes`;
        const ok = await env.ui.select(`${msg}确认？`, ['确认合入并结束流程', '取消']);
        if (ok !== '确认合入并结束流程') return '已取消。';
      }
      const stageBefore = h.store.readFlow(flowId).stage;
      let text = await approveStage({ root: env.root, store: h.store, config: h.config }, flowId, option(argv, '--note'));
      // 规划阶段批准时应用项目专属规则与命令（没有界面时默认全部应用）
      if (stageBefore === 'D2') text += `\n${await offerDrafts(env, h, flowId, option(argv, '--rules') ?? (env.ui ? undefined : 'all'))}`;
      if (h.store.readState().active_flow) {
        await h.engine.pump(flowId);
        const d = await h.engine.next(flowId);
        if (env.waitForIdle) await h.engine.idle();
        return `${text}${d.length ? `\n已派发：${d.map((x) => `${x.task} → ${x.role}`).join('；')}` : ''}\n\n${renderStatus(h.store, h.config)}`;
      }
      return text;
    }
    case 'reject': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      if (h.store.readRevision(flowId)?.status === 'proposed') {
        const text = await rejectRevision({ root: env.root, store: h.store, config: h.config }, flowId, argv.slice(1).join(' '));
        env.startConversation?.('我打回了计划修订，请按下一步指引重新起草。');
        return text;
      }
      const text = await rejectStage({ root: env.root, store: h.store, config: h.config }, flowId, argv.slice(1).join(' '));
      await h.engine.pump(flowId);
      env.startConversation?.(`我打回了${h.store.readFlow(flowId).stage === 'D0' ? '需求说明' : '规划'}，请按下一步指引修改。`);
      return text;
    }
    case 'unblock': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const [, taskId, answer] = positional(argv);
      if (!taskId) throw new Error('用法：/forge unblock <任务> ["<回答>"] [--attempts N]');
      const owner = [h.store.readState().active_flow, h.store.openFixFlow()?.id].filter((x): x is string => !!x)
        .find((f) => h.store.listTasks(f).some((t) => t.id === taskId && t.status === 'blocked'));
      if (owner && owner !== flowId) {
        const text = await unblockTask({ root: env.root, store: h.store, config: h.config }, owner, taskId, answer, option(argv, '--attempts') !== undefined ? Number(option(argv, '--attempts')) : undefined);
        await h.engine.pump(owner);
        return text;
      }
      const att = option(argv, '--attempts');
      const text = await unblockTask({ root: env.root, store: h.store, config: h.config }, flowId, taskId, answer, att !== undefined ? Number(att) : undefined);
      await h.engine.pump(flowId);
      if (h.store.readFlow(flowId).mode !== 'fix') await h.engine.next(flowId);
      if (env.waitForIdle) await h.engine.idle();
      return text;
    }
    case 'gate': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      await h.engine.rerunGate(flowId);
      return renderStatus(h.store, h.config);
    }
    case 'rules': {
      const h = env.engine();
      const flowId = currentFlowIdOrNull(h.store);
      const drafts = allDrafts(env.root, h, flowId);
      if (argv[1] !== 'apply') {
        return drafts.length
          ? `待应用的规则与命令草案${flowId ? `（${flowId} 与主分支）` : '（主分支）'}：\n${formatDrafts(drafts)}\n应用：/forge rules apply all，或 /forge rules apply <草案文件>...`
          : '没有待应用的规则或命令草案。';
      }
      const picks = argv.slice(2);
      const chosen = !picks.length || picks.includes('all') ? drafts : drafts.filter((d) => picks.includes(d.file) || picks.includes(path.basename(d.file)));
      if (!chosen.length) throw new Error(`没有匹配的草案。可用：${drafts.map((d) => d.file).join('、') || '无'}`);
      return applyAndReport(env, h, flowId, chosen);
    }
    case 'checkpoint': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      if (argv[1] === 'restore') {
        const id = argv[2];
        if (!id) return '用法：/forge checkpoint restore <任务>';
        const t = h.store.readTask(flowId, id);
        if (t.lease) return `${id} 正在运行（run ${t.lease.run_id}），等它结束或 /forge stop 后再恢复。`;
        if (!t.worktree || !existsSync(t.worktree)) return `${id} 的工作区不存在，无法恢复。`;
        const n = restoreCheckpoint(env.root, t.worktree, flowId, id);
        await h.store.recordEvent({ flow: flowId, task: id, actor: 'human', type: 'note', reason: `从检查点恢复工作区（${n} 个文件）` });
        return `已把 ${id} 的工作区恢复到检查点（${n} 个文件；之后新增的文件保留）。`;
      }
      if (argv[1]) return '用法：/forge checkpoint（列出）、/forge checkpoint restore <任务>';
      const list = listCheckpoints(env.root).filter((c) => c.flow === flowId);
      return list.length ? `检查点（运行中每 ${h.config.limits.checkpoint_minutes ?? DEFAULT_CHECKPOINT_MINUTES} 分钟自动拍一次，任务结束后删除）：\n${list.map((c) => `- ${c.task}：${c.at}（${c.sha.slice(0, 8)}）`).join('\n')}\n工作区被改坏时用 /forge checkpoint restore <任务> 恢复。` : `${flowId} 没有检查点。`;
    }
    case 'report': {
      const h = env.engine();
      return finishReport(h.store, currentFlowId(h.store));
    }
    case 'budget': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const kind = argv[1];
      if (kind === 'tokens' || kind === 'cost' || kind === 'minutes') {
        const v = Number(argv[2]);
        if (!Number.isFinite(v) || v <= 0 || (kind !== 'cost' && !Number.isInteger(v))) return `用法：/forge budget tokens <正整数>、/forge budget cost <正数> 或 /forge budget minutes <正整数>`;
        const cur = h.store.readFlow(flowId).budget ?? {};
        await h.store.setFlowBudget(flowId, { ...cur, [kind]: v });
        await h.engine.pump(flowId);
        const d = await h.engine.next(flowId);
        if (env.waitForIdle) await h.engine.idle();
        const b = budgetState(h.store, h.config, h.store.readFlow(flowId));
        return `已设置 ${flowId} 的预算。${b ? formatBudget(b) : ''}${d.length ? `\n已派发：${d.map((x) => `${x.task} → ${x.role}`).join('；')}` : ''}`;
      }
      if (kind) return '用法：/forge budget（查看）、/forge budget tokens <数值>、/forge budget cost <金额>、/forge budget minutes <分钟>';
      const b = budgetState(h.store, h.config, h.store.readFlow(flowId));
      return b ? `${flowId} ${formatBudget(b)}` : `${flowId} 没有设置预算（workflow.yaml 的 budget 或 /forge budget tokens|cost|minutes <数值>）。`;
    }
    case 'models': {
      if (argv[1] === 'resume') {
        const name = argv[2];
        if (!name) return '用法：/forge models resume <模型>（provider/id 或只写 id）或 /forge models resume all';
        const h = env.engine();
        const hits = matchPausedModel(h.store.readModelPauses().pauses, name);
        if (!hits.length) return `没有被暂停的模型 ${name}。${formatPauses(h.store)}`;
        for (const p of hits) await h.engine.resumeModel(p.model);
        if (env.waitForIdle) await h.engine.idle();
        return `已恢复 ${hits.map((p) => p.model).join('、')}，受影响的任务会重新派发。如果额度仍未恢复，会再次暂停。`;
      }
      if (argv[1]) return '用法：/forge models（查看）、/forge models resume <模型>|all';
      return formatPauses(env.store());
    }
    case 'add': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const task = option(argv, '--task');
      const text = positional(argv).slice(1).join(' ');
      const r = await addRequirement({ root: env.root, store: h.store, config: h.config, steer: (f, t, m) => h.engine.steer(f, t, m) }, flowId, text, task);
      await h.engine.pump(flowId);
      // 交给主 agent 的（需求、规划阶段的意见，或实施阶段的修订请求）：让它这一轮就处理
      const f = h.store.readFlow(flowId);
      if (f.mode !== 'fix' && !task && (DESIGN_STAGES.has(f.stage) || f.replan_request)) env.startConversation?.(`我追加了需求：${text}`);
      if (env.waitForIdle) await h.engine.idle();
      return r;
    }
    case 'accept': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const [, taskId] = positional(argv);
      if (!taskId) throw new Error('用法：/forge accept <任务> [--note "<说明>"]（只能放行验收"需要你处理"的模块）');
      const r = await acceptManually(h.store, flowId, taskId, option(argv, '--note') ?? '');
      await h.engine.pump(flowId);
      if (env.waitForIdle) await h.engine.idle();
      return r;
    }
    case 'review': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const sub = positional(argv)[1];
      if (!sub) {
        const r = h.store.readFinalReview(flowId);
        return r ? `${describeReview(r)}\n（完整内容见集成分支上的 ${FINAL_REVIEW_DOC}）` : h.config.raw.review?.final ? '最终代码审查还没开始（所有模块验收通过后开始）。' : '最终代码审查没有开启（在 workflow.yaml 中设置 review.final: true 开启）。';
      }
      let text: string;
      try {
        if (sub === 'fix') {
          const ids = positional(argv).slice(2);
          if (!ids.length) throw new FinalReviewError('用法：/forge review fix R-3 R-5（/forge review 查看条目）');
          text = await fixFindings(h.store, flowId, ids);
        } else if (sub === 'done') text = await finishReview(h.store, flowId);
        else throw new FinalReviewError('用法：/forge review、/forge review fix <R-编号>...、/forge review done');
      } catch (e) {
        if (e instanceof FinalReviewError) throw new Error(e.message);
        throw e;
      }
      await h.engine.pump(flowId);
      await h.engine.next(flowId);
      if (env.waitForIdle) await h.engine.idle();
      return text;
    }
    case 'replan': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      try {
        const reason = argv.slice(1).join(' ');
        await requestReplan({ root: env.root, store: h.store, config: h.config }, flowId, reason, 'human');
        env.startConversation?.(`我要修订计划：${reason}`);
        return '已交给主 agent 起草计划修订（其他任务照常进行）。起草后用 /forge-approve 批准，或 /forge-reject "<意见>" 打回。';
      } catch (e) {
        if (e instanceof RevisionError) return `未发起：${e.message}`;
        throw e;
      }
    }
    case 'sync': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      const r = await h.engine.sync(flowId);
      const main = h.config.raw.main_branch;
      const text = !r ? '合并正在进行，稍后再试。'
        : r.kind === 'up_to_date' ? `集成分支已包含 ${main} 的全部提交。`
          : r.kind === 'synced' ? `已把 ${main} 同步进集成分支（${r.files} 个文件，${r.sha.slice(0, 8)}）。`
            : r.kind === 'merge_fix' ? `同步冲突：${r.conflicts.join('、')}。已生成 ${r.task} 解决冲突，完成后集成分支即与 ${main} 同步。`
              : r.kind === 'fixing' ? `冲突修复任务 ${r.task} 尚未完成，完成后再同步。`
                : `同步冲突，需要你处理：${r.reason}。在 ${h.store.readFlow(flowId).integration_branch} 上合并 ${main} 并解决冲突后再执行 /forge sync；在此之前不会派发新任务。`;
      await h.engine.pump(flowId);
      if (r?.kind !== 'conflict') await h.engine.next(flowId);
      if (env.waitForIdle) await h.engine.idle();
      return text;
    }
    case 'run':
      return runDetail(argv[1], env.store());
    case 'knowledge':
      try {
        return await runKnowledge(argv.slice(1), env);
      } catch (e) {
        if (e instanceof KnowledgeError) return `未完成：${e.message}`;
        throw e;
      }
    case 'answer':
      return runFlowAnswer(argv, env);
    case 'off':
      if (!env.deactivateOrchestrator) return '当前环境不支持调度模式。';
      return env.deactivateOrchestrator();
    case 'help': case '-h': case '--help':
      return FLOW_USAGE;
    default:
      throw new Error(`未知子命令 ${sub}。\n${FLOW_USAGE}`);
  }
}

export const BUILD_USAGE = [
  '用法：',
  '  /forge-build --prd <文件或目录> [--arch <文件或目录>] [--design <目录>]',
  '                                          从零建新项目：带上写好的 PRD、技术架构与原型（例如 Claude Design 的导出目录）；',
  '                                          主 agent 只就缺口提问，然后直接规划给你审，再按模块实施（--from 等同 --prd）',
  '  /forge-build "<想法>"                    没有 PRD 时：主 agent 先和你逐轮讨论需求，再规划、实施',
  '  /forge-build --feature ...               在已有项目上加功能，参数相同',
  '小改动（单文件、几十行以内）直接用 pi 更划算；缺陷修复用 /forge-fix。',
].join('\n');

export const FIX_USAGE = [
  '用法：',
  '  /forge-fix "<问题描述>"            修复缺陷：实现者定位并修复（加回归测试）→ 合并时跑全量测试 → 验收者复现确认 → 合入主分支',
  '  /forge-fix --from <文件>           用写好的问题描述开始',
].join('\n');

async function ensureInitialized(env: CommandEnv, lines: string[]): Promise<void> {
  if (!existsSync(path.join(env.root, '.forge', 'state.json')) || !existsSync(path.join(env.root, 'workflow.yaml'))) {
    lines.push(formatInit(await initProject(env.root, env.packageRoot, env.dependencies?.())));
  }
}

/** /forge-build 的输入：--prd（或 --from）、--arch、--design */
function intakeOptions(argv: string[]): IntakeInput | null {
  const prd = option(argv, '--prd') ?? option(argv, '--from');
  const arch = option(argv, '--arch');
  const design = option(argv, '--design');
  if (prd === undefined) {
    if (arch !== undefined || design !== undefined) throw new Error('--arch、--design 要和 --prd 一起用（PRD 是必需的）。');
    return null;
  }
  return { prd, ...(arch !== undefined ? { arch } : {}), ...(design !== undefined ? { design } : {}) };
}

/** PRD 的标题作为流程名：文件取第一行，目录取其中第一个 md 的第一行 */
function intakeTitle(root: string, prd: string): string {
  const abs = path.resolve(root, prd);
  if (!existsSync(abs)) throw new Error(`找不到 PRD ${prd}`);
  const file = statSync(abs).isFile() ? abs : readdirSync(abs).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(abs, f))[0];
  const first = file ? readFileSync(file, 'utf8').split('\n').find((l) => l.trim()) ?? '' : '';
  return first.replace(/^#+\s*/, '').trim().slice(0, 120) || path.basename(abs);
}

function readFromFile(env: CommandEnv, argv: string[]): string | null {
  const file = option(argv, '--from');
  if (file === undefined) return null;
  const abs = path.resolve(env.root, file);
  if (!existsSync(abs)) throw new Error(`找不到文件 ${file}`);
  const text = readFileSync(abs, 'utf8').trim();
  if (!text) throw new Error(`${file} 是空文件`);
  return text;
}

/** build/feature 流程不能与进行中的流程并存 */
function assertNoActiveFlow(h: EngineHandle): void {
  const active = h.store.readState().active_flow;
  if (active) {
    const f = h.store.readFlow(active);
    throw new Error(`已有进行中的流程 ${f.id}「${f.title}」。同一时间只允许一个 build 或 feature 流程；请执行 /forge-resume 继续。`);
  }
}

/** /forge-build 与 /forge-build --feature */
export async function runFlowBuild(args: string, env: CommandEnv): Promise<string> {
  const argv = splitArgs(args);
  if (argv[0] === 'help' || argv[0] === '--help') return BUILD_USAGE;
  const lines: string[] = [];
  await ensureInitialized(env, lines);
  const h = env.engine();
  const mode = argv.includes('--feature') ? 'feature' : 'build';
  const intake = intakeOptions(argv);
  const description = argv.filter((a, i) => !a.startsWith('--') && !['--from', '--prd', '--arch', '--design'].includes(argv[i - 1] ?? '')).join(' ').trim();
  assertNoActiveFlow(h);
  if (intake) return startBuildFlow(env, mode, description || intakeTitle(env.root, intake.prd), lines, intake);
  if (!description) throw new Error(`请带上 PRD（--prd），或写下你的想法（主 agent 会和你讨论）。\n${BUILD_USAGE}`);
  return startBuildFlow(env, mode, description, lines);
}

/** 开流程前检查依赖：Pi 版本过低直接拒绝；插件缺失或版本未经验证只提醒 */
function dependencyGate(env: CommandEnv, config: FlowConfig, lines: string[]): void {
  const deps = env.dependencies?.();
  if (!deps) return;
  const items = checkDependencies({ config, ...deps });
  const errors = items.filter((i) => i.level === 'error');
  if (errors.length) throw new Error(`依赖检查未通过：\n${errors.map((i) => `✗ ${i.item}：${i.detail}`).join('\n')}`);
  const warns = items.filter((i) => i.level === 'warn');
  if (warns.length) lines.push(`依赖提醒（不影响开始，相关工具可能不可用；/forge doctor 查看）：\n${warns.map((i) => `! ${i.item}：${i.detail}`).join('\n')}`, '');
}

/** intake：用户带来的 PRD、架构与原型，原样放进集成分支，主 agent 接着做就绪检查 */
async function startBuildFlow(env: CommandEnv, mode: 'build' | 'feature', title: string, lines: string[], intake?: IntakeInput): Promise<string> {
  const h = env.engine();
  dependencyGate(env, h.config, lines);
  // 先检查输入是否存在，避免建了流程才发现路径写错
  if (intake) for (const [label, p] of [['PRD', intake.prd], ['技术架构', intake.arch], ['原型', intake.design]] as const) if (p && !existsSync(path.resolve(env.root, p))) throw new Error(`找不到${label} ${p}`);
  const flow = await startFlow({ root: env.root, store: h.store, config: h.config }, mode, title);
  await env.activateOrchestrator();
  if (intake) {
    const r = await importInputs(env.root, h.store, flow.id, intake);
    lines.push(`已接收 PRD（${r.prd}）${r.arch ? `、技术架构（${r.arch}）` : ''}${r.pages.length ? `、原型 ${r.pages.length} 页` : ''}${r.design_doc ? '、设计规范 DESIGN.md' : ''}，放在集成分支 ${flow.integration_branch} 上。`);
  }
  await h.engine.pump(flow.id);
  const d = await h.engine.next(flow.id);
  lines.push(`已创建流程 ${flow.id}（${flow.mode}），阶段：${flow.stages.join(' → ')}；集成分支 ${flow.integration_branch}。`);
  if (d.length) lines.push(`已派发 ${d.map((x) => `${x.task} → ${x.role}（${x.model}）`).join('；')}。`);
  if (env.waitForIdle) await h.engine.idle();
  lines.push('', renderStatus(h.store, h.config));
  env.startConversation?.(intake ? `我带来了 PRD${intake.arch ? '、技术架构' : ''}${intake.design ? '与原型' : ''}，请检查后开始。\n\n${intakeBrief(env.root, h.store.readFlow(flow.id))}` : `开始需求讨论：${title}`);
  return lines.join('\n');
}

/** /forge-fix */
export async function runFlowFix(args: string, env: CommandEnv): Promise<string> {
  const argv = splitArgs(args);
  if (argv[0] === 'help' || argv[0] === '--help') return FIX_USAGE;
  const lines: string[] = [];
  await ensureInitialized(env, lines);
  const h = env.engine();
  const fromFile = readFromFile(env, argv);
  const desc = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--from').join(' ').trim();
  const description = fromFile ? fromFile.split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 120) : desc;
  const brief = fromFile ?? '';
  if (!description) throw new Error(`请描述问题：现象、复现步骤、期望结果。\n${FIX_USAGE}`);

  const active = h.store.readState().active_flow;
  if (active) {
    const f = h.store.readFlow(active);
    if (f.stage_status !== 'awaiting_human') {
      throw new Error(`进行中的流程 ${f.id} 正在阶段 ${f.stage} 运行（${f.stage_status}），不能同时修复。等它进入等待审批时再修复，或把问题作为该流程的一部分处理。`);
    }
    if (!argv.includes('--yes')) {
      const msg = `流程 ${f.id} 正在等待审批（阶段 ${f.stage}）。修复会直接合入 ${h.config.raw.main_branch}，与该流程并行。`;
      if (!env.ui) return `${msg}\n确认请在原命令后加 --yes`;
      if ((await env.ui.select(`${msg}继续？`, ['继续修复', '取消'])) !== '继续修复') return '已取消。';
    }
  }
  const main = h.config.raw.main_branch;
  dependencyGate(env, h.config, lines);
  const fix = await h.store.createFixFlow(description, main, git(env.root, ['rev-parse', main]).trim());
  if (brief) await h.store.saveFlowBrief(fix.id, brief);
  await env.activateOrchestrator();
  await h.engine.pump(fix.id);
  lines.push(`已创建修复 ${fix.id}，实现者开始定位并修复。`);
  if (env.waitForIdle) await h.engine.idle();
  lines.push('', renderStatus(h.store, h.config));
  return lines.join('\n');
}

/** /forge answer：回答阻塞任务提出的问题（答案来自用户输入，不经模型转述） */
export async function runFlowAnswer(argv: string[], env: CommandEnv): Promise<string> {
  const h = env.engine();
  const flows = [h.store.readState().active_flow, h.store.openFixFlow()?.id].filter((x): x is string => !!x);
  const blocked = flows.flatMap((f) => h.store.listTasks(f).filter((t) => t.status === 'blocked').map((t) => ({ flow: f, t })));
  if (!blocked.length) return '没有等待你回答的问题。';
  const wanted = argv[1];
  let pick = wanted ? blocked.find((x) => x.t.id === wanted) : blocked.length === 1 ? blocked[0] : undefined;
  if (wanted && !pick) throw new Error(`任务 ${wanted} 不在阻塞状态。等待回答的：${blocked.map((x) => x.t.id).join('、')}`);
  if (!env.ui?.input) {
    return `等待你回答的问题：\n${blocked.map((x) => `- ${x.t.id}「${x.t.title}」：${x.t.blocked_reason}\n  → /forge unblock ${x.t.id} "<你的回答>"`).join('\n')}`;
  }
  if (!pick) {
    const labels = blocked.map((x) => `${x.t.id}：${(x.t.blocked_reason ?? '').slice(0, 80)}`);
    const sel = await env.ui.select('选择要回答的问题', labels);
    if (!sel) return '已取消。';
    pick = blocked[labels.indexOf(sel)];
  }
  const answer = (await env.ui.input(`${pick!.t.id}「${pick!.t.title}」的问题：\n${pick!.t.blocked_reason}`, '你的回答（可留空，只解除阻塞）')) ?? undefined;
  if (answer === undefined) return '已取消。';
  const text = await unblockTask({ root: env.root, store: h.store, config: h.config }, pick!.flow, pick!.t.id, answer);
  await h.engine.pump(pick!.flow);
  if (h.store.readFlow(pick!.flow).mode !== 'fix') await h.engine.next(pick!.flow);
  return `${text}${answer.trim() ? '回答已交给该任务。' : ''}`;
}

/** 不要求有进行中的流程（知识提升的规则草案在主分支上） */
function currentFlowIdOrNull(store: Store): string | null {
  try { return currentFlowId(store); } catch { return null; }
}

/** 主分支上的草案（知识提升）+ 当前流程集成分支上的草案（规划）；同名时以集成分支为准 */
function allDrafts(root: string, h: EngineHandle, flowId: string | null): Draft[] {
  const byFile = new Map(listDrafts(root, h.config.raw.main_branch).map((d) => [d.file, d]));
  if (flowId) for (const d of listDrafts(root, h.store.readFlow(flowId).integration_branch)) byFile.set(d.file, d);
  return [...byFile.values()];
}

async function applyAndReport(env: CommandEnv, h: EngineHandle, flowId: string | null, drafts: Draft[]): Promise<string> {
  const r = applyDrafts(env.root, drafts, flowId ?? '知识库');
  if (r.commands) Object.assign(h.config.raw.commands, r.commands);
  const promoted = await markPromoted(h.store, drafts.map((d) => d.file));
  return `已应用：${r.applied.join('、')}，并已提交。之后派发的任务使用新的规则${r.commands ? '与命令' : ''}（子进程提示的稳定前缀变化，模型服务的提示缓存会失效一次）。${promoted.length ? `\n知识 ${promoted.join('、')} 已成为规则，不再作为知识注入。` : ''}`;
}

/** /forge run [<run_id>]：某次运行的工具调用摘要与最后的回复；不给 id 时列出最近的运行 */
function runDetail(id: string | undefined, store: Store): string {
  const runs = store.listRuns().sort((a, b) => a.started_at.localeCompare(b.started_at));
  if (!id) {
    if (!runs.length) return '还没有任何运行记录。';
    return `最近的运行（详情：/forge run <run_id>）：\n${runs.slice(-15).map((r) => `- ${r.run_id}　${r.flow ?? '-'}/${r.task ?? '-'}　${r.role}　${r.outcome ?? (r.ended_at ? '无结果' : '运行中')}　${r.started_at.slice(0, 16).replace('T', ' ')}`).join('\n')}`;
  }
  const r = runs.find((x) => x.run_id === id || x.run_id.startsWith(id));
  if (!r) return `没有找到 run ${id}。最近的运行：/forge run`;
  const file = r.session_file && existsSync(r.session_file) ? r.session_file : r.session_dir ? findSessionFile(r.session_dir) : null;
  let summary = null;
  try { summary = file ? summarizeSession(file) : null; } catch { /* 无法解析时只给路径 */ }
  return formatRunDetail(r, summary, file);
}

const KNOWLEDGE_USAGE = [
  '/forge knowledge [<搜索词>] [--all]          列出或搜索项目知识（--all 含已废弃与已成为规则的）',
  '/forge knowledge accept <K-编号> ["<改写>"]   确认程序提炼的候选，可同时改写内容',
  '/forge knowledge retire <K-编号>... ["<原因>"] 废弃条目',
  '/forge knowledge promote <K-编号>... [--rule <规则名>]   提升为规则草案（docs/rules-draft/），再用 /forge rules apply 应用',
].join('\n');

async function runKnowledge(argv: string[], env: CommandEnv): Promise<string> {
  const store = env.store();
  const ids = argv.slice(1).filter((a) => /^K-\d{3,}$/.test(a));
  const rest = argv.slice(1).filter((a) => !/^K-\d{3,}$/.test(a) && !a.startsWith('--') && a !== option(argv, '--rule'));
  switch (argv[0]) {
    case 'accept': {
      if (ids.length !== 1) return `用法：${KNOWLEDGE_USAGE.split('\n')[1]}`;
      const e = await acceptCandidate(store, ids[0]!, rest.join(' ') || undefined);
      return `已确认 ${e.id}，之后相关任务的提示中会看到它：\n${formatKnowledgeList([e])}`;
    }
    case 'retire': {
      if (!ids.length) return `用法：${KNOWLEDGE_USAGE.split('\n')[2]}`;
      const es = await retireEntries(store, ids, rest.join(' '));
      return `已废弃 ${es.map((e) => e.id).join('、')}。`;
    }
    case 'promote': {
      if (!ids.length) return `用法：${KNOWLEDGE_USAGE.split('\n')[3]}`;
      const config = loadConfig(path.join(env.root, 'workflow.yaml'));
      const r = await promoteToDraft(env.root, store, config, ids, option(argv, '--rule'));
      return `已写入规则草案 ${r.file} 并提交（${ids.join('、')}）。规则只有你能改：确认内容后执行 /forge rules apply ${path.basename(r.file)} 应用；应用前这些条目仍作为知识注入。`;
    }
    case 'help':
      return KNOWLEDGE_USAGE;
    default: {
      const all = argv.includes('--all');
      const query = argv.filter((a) => a !== '--all').join(' ');
      const k = store.readKnowledge();
      const hits = searchKnowledge(k, query, all);
      if (!k.entries.length) return `项目知识库还是空的。任务执行中 agent 会用 forge_learn 记录经验；合并后验证失败会生成候选（knowledge.auto_candidates）。\n\n${KNOWLEDGE_USAGE}`;
      if (!hits.length) return `没有匹配的知识条目${query ? `（${query}）` : ''}。\n\n${KNOWLEDGE_USAGE}`;
      const cand = hits.filter((e) => e.status === 'candidate').length;
      return `项目知识（${hits.length} 条${cand ? `，其中 ${cand} 条候选待确认` : ''}）：\n${formatKnowledgeList(hits)}\n\n${KNOWLEDGE_USAGE}`;
    }
  }
}

/** 规划阶段（D2）批准后：应用规划时写的项目专属规则与命令草案（按 --rules all|none；有界面时让用户选择） */
async function offerDrafts(env: CommandEnv, h: EngineHandle, flowId: string, flag: string | undefined): Promise<string> {
  const drafts = listDrafts(env.root, h.store.readFlow(flowId).integration_branch);
  if (!drafts.length) return '';
  const list = `规划时写了规则与命令草案：\n${formatDrafts(drafts)}`;
  if (flag === 'all') return `${list}\n${await applyAndReport(env, h, flowId, drafts)}`;
  if (flag === 'none') return `${list}\n未应用（之后可用 /forge rules apply）。`;
  if (!env.ui) return `${list}\n建议应用：/forge rules apply all（或逐个指定文件）；不应用时实现者只按通用规则，可能与规划冲突。`;
  const pick = await env.ui.select(`${list}\n\n是否应用？草案是按本项目技术栈写的，通常建议全部应用；不应用时实现者只按通用规则，可能与规划冲突。`, ['全部应用（推荐）', '逐个选择', '暂不应用']);
  if (pick === '全部应用（推荐）') return applyAndReport(env, h, flowId, drafts);
  if (pick !== '逐个选择') return '规则草案暂未应用（之后可用 /forge rules apply）。';
  const chosen: Draft[] = [];
  for (const d of drafts) {
    if ((await env.ui.select(`${d.file} → ${d.target}\n${d.summary}\n\n${d.content.slice(0, 1500)}`, ['应用', '跳过'])) === '应用') chosen.push(d);
  }
  return chosen.length ? applyAndReport(env, h, flowId, chosen) : '没有选择任何草案。';
}
