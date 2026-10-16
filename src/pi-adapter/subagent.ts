// 子进程中的 pi-forge 扩展：由 dispatcher 用 -e 最后加载（guard 必须最后执行）。
// 只在 PI_FORGE_* 环境变量齐全时生效：注册本角色可用的 forge_* 工具、收窄启用的工具、拦截所有工具调用。
import path from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { tolerantArgs } from './tool-args.ts';
import { loadConfig } from '../core/state/config.ts';
import { StateStore } from '../core/state/state-store.ts';
import { SubagentRuntime } from '../core/engine/subagent-runtime.ts';
import { SUBAGENT_TOOLS, runEnvFrom, type SubagentToolName } from '../tools/subagent-tools.ts';
import { MISSING_TOOLS_REASON, playwrightSkillDir } from '../core/workspace/dependencies.ts';
import { packageRoots } from './plugins.ts';
import { notesContextMessage } from '../core/engine/notes.ts';
import { taskNotesRel } from '../core/state/state-store.ts';
import { installMemory } from './memory.ts';
import { stopAllServices } from '../core/workspace/services.ts';
import { redactToolResult } from './redact-hook.ts';
import { scratchDir } from '../core/workspace/worktree.ts';

/** 子进程 bash 命令的超时上限（秒），workflow.yaml 的 limits.bash_timeout_s，默认 300 */
export const DEFAULT_BASH_TIMEOUT_S = 300;
export const bashTimeoutS = (config: { limits: { bash_timeout_s?: number } }) => config.limits.bash_timeout_s ?? DEFAULT_BASH_TIMEOUT_S;

/** 没给超时或超过上限时改成上限 */
export function applyBashTimeout(input: Record<string, unknown>, maxS: number): void {
  const t = input['timeout'];
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > maxS) input['timeout'] = maxS;
}

export default function piFlowSubagent(pi: ExtensionAPI): void {
  const env = runEnvFrom(process.env);
  if (!env) return;
  // 项目命令以本 worktree 里的 commands.yaml 为准（集成分支的最新版，或本任务刚改过的）
  const config = loadConfig(path.join(env.root, 'workflow.yaml'), process.cwd());
  const store = new StateStore(env.root, { limits: config.limits });
  const rt = new SubagentRuntime(env, store, config);
  const skill = playwrightSkillDir(packageRoots(env.root, getAgentDir()));
  if (skill) rt.toolDirs = [skill];
  const allowed = new Set(rt.activeTools());

  for (const [name, def] of Object.entries(SUBAGENT_TOOLS) as [SubagentToolName, (typeof SUBAGENT_TOOLS)[SubagentToolName]][]) {
    if (!allowed.has(name)) continue;
    pi.registerTool(tolerantArgs({
      name, label: name, description: def.description, parameters: def.params,
      async execute(_id, params) {
        const r = await rt.callFlowTool(name, params);
        return { content: [{ type: 'text', text: r.text }], details: r.details ?? {} };
      },
    }));
  }

  // forge_service 启动的服务随本次运行结束（第六轮 D2）；引擎回收运行时也会按记录再结束一次
  const stopServices = () => { try { stopAllServices(scratchDir(env.root, env.run)); } catch { /* 清理失败不影响退出 */ } };
  pi.on('session_shutdown', () => { stopServices(); });
  process.once('exit', stopServices);

  // 结构化笔记放回上下文、按阈值压缩（第五轮）
  installMemory(pi, {
    active: () => true,
    notesMessage: () => notesContextMessage(store.readNotes(taskNotesRel(env.flow, env.task)), { title: `任务 ${env.task} 的笔记` }),
    compactAt: () => config.compactAt,
  });

  pi.on('session_start', async () => {
    const registered = new Set(pi.getAllTools().map((t) => t.name));
    pi.setActiveTools([...allowed].filter((t) => registered.has(t)));
    // 角色配置了但没有注册的工具：插件未安装、版本不符或改了工具名。记一条事件，/forge doctor 会提示
    const missing = [...allowed].filter((t) => !registered.has(t));
    if (missing.length) {
      await store.recordEvent({ flow: env.flow, task: env.task, actor: `run:${env.run}`, type: 'note', reason: MISSING_TOOLS_REASON,
        data: { run: env.run, role: env.role, tools: missing } }).catch(() => {});
    }
  });

  // guard 放行但带提醒的调用：提醒追加到这次的工具结果后面
  const gateNotes = new Map<string, string>();
  pi.on('tool_call', async (event, ctx) => {
    const g = await rt.gate({ toolName: event.toolName, input: event.input }, ctx.cwd);
    if (!g.block) {
      if (g.note) gateNotes.set(event.toolCallId, g.note);
      // bash 命令一律有超时（秒）：挂起的测试、没关的服务器不会把整个任务卡住（Pi 1.0.0：event.input 可原地修改）
      if (event.toolName === 'bash') applyBashTimeout(event.input as Record<string, unknown>, bashTimeoutS(config));
      return;
    }
    if (g.terminate) setTimeout(() => ctx.shutdown(), 0);
    return { block: true, reason: g.reason, ...(g.terminate ? { terminate: true } : {}) };
  });

  // 工具结果：先给密钥打码（第六轮 D4）；检查类命令（测试、类型检查、lint）的结果，同样的失败反复出现时提醒，到上限结束本次运行
  // （第六轮 B2；Pi 1.0.0 tool_result 可改写结果，bash 非零退出时 isError 为 true，structuredContent.output 是完整输出）
  pi.on('tool_result', async (event, ctx) => {
    const red = redactToolResult(event);
    const content = red?.content ?? event.content;
    const structuredContent = red ? red.structuredContent : event.structuredContent;
    if (red) {
      await store.recordEvent({ flow: env.flow, task: env.task, actor: `run:${env.run}`, type: 'note', reason: `${event.toolName} 的结果中有 ${red.count} 处疑似密钥，已打码`, data: { run: env.run, tool: event.toolName } }).catch(() => {});
    }
    const gateNote = gateNotes.get(event.toolCallId);
    gateNotes.delete(event.toolCallId);
    const withNotes = (notes: string[]) => ({ content: [...content, ...notes.map((n) => ({ type: 'text' as const, text: `\n\n${n}` }))], ...(structuredContent !== undefined ? { structuredContent } : {}) });
    const changed = gateNote ? withNotes([gateNote]) : red ? { content, ...(structuredContent !== undefined ? { structuredContent } : {}) } : undefined;
    if (event.toolName !== 'bash' || event.parentToolCallId) return changed;
    const sc = structuredContent as { output?: unknown } | undefined;
    const output = typeof sc?.output === 'string' ? sc.output : content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    const c = await rt.afterToolResult('bash', event.input, event.isError, output);
    if (!c.note) return changed;
    if (c.terminate) setTimeout(() => ctx.shutdown(), 0);
    return withNotes([...(gateNote ? [gateNote] : []), c.note]);
  });
}
