// subagent 进程内的运行时：根据 run 环境构造 guard 上下文、拦截工具调用、执行 forge_* 工具。
// pi-adapter 的子进程扩展与测试用 fake-subagent 共用这一实现。
import { Value } from 'typebox/value';
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import type { TaskFile } from '../state/schemas.ts';
import { canAppendInterfaces, hashToken } from '../state/state-machine.ts';
import { scratchDir } from '../workspace/worktree.ts';
import { TEST_GLOBS } from '../verify/test-adjust.ts';
import { matchesAny, INTERFACES_PATH, opensWrites } from '../state/paths.ts';
import { enforceToolCall, type GuardContext, type ToolCall } from '../security/guard.ts';
import { failureSummary } from '../workspace/verify-runner.ts';
import { failureSignature } from '../state/failure-signature.ts';
import { FlowToolError, SUBAGENT_TOOLS, type RunEnv, type SubagentToolName, type ToolResult } from '../../tools/subagent-tools.ts';
import { withoutPlaceholders } from '../security/tool-params.ts';

/** note：放行，但要追加到这次工具结果后面的提醒 */
export type GateResult = { block: false; note?: string } | { block: true; reason: string; terminate: boolean };

/** 工具结果的处理：note 追加到结果后面给模型看；terminate 时结束本次运行 */
export type ResultCheck = { note?: string; terminate?: boolean };

/**
 * 原地打转（第四轮复跑看板发现：glm 连续 281 次执行同一条调试命令，心跳续租让租约永不过期）：
 * 连续这么多次完全相同的工具调用时拦下并提示换思路；到上限结束本次运行（计一次失败，重新派发，失败多次后升级模型）。
 */
export const REPEAT_WARN = 5;
export const REPEAT_LIMIT = 10;
/**
 * 滑动窗口（第六轮 B1）：最近 WINDOW 次被放行的调用里，同一个"归一化签名"出现的次数。覆盖交替执行（A-B-A-B）与只改数字参数的重复。
 * 读类工具不计（分段读大文件是正常的）；命令类调用只数上一次改文件之后的次数（改了再测是正常的，改了也没用由 B2 判断）。
 */
export const WINDOW = 30;
export const WINDOW_WARN = 8;
export const WINDOW_LIMIT = 12;
/** 同一个失败（测试、类型检查、lint 的失败输出签名相同）连续出现的次数（第六轮 B2）：改了代码但失败不变，说明没有进展 */
export const SAME_FAILURE_WARN = 3;
export const SAME_FAILURE_LIMIT = 5;

/** 调用的归一化签名：数字换成 #，空白合并，bash 去掉 tail/head 截断与 2>&1 */
export function normalizedSignature(toolName: string, input: unknown): string {
  let v: unknown = input;
  if (toolName === 'bash' && input && typeof input === 'object' && typeof (input as Record<string, unknown>)['command'] === 'string') {
    const cmd = String((input as Record<string, unknown>)['command'])
      .replace(/\|\s*(tail|head)(\s+-n)?\s+-?\d+/g, '')
      .replace(/2>&1/g, '');
    v = { command: cmd };
  }
  return `${toolName}\u0000${JSON.stringify(v ?? null).replace(/\d+/g, '#').replace(/\s+/g, ' ')}`;
}

/** 常见的测试、类型检查、lint 运行器（项目配置的命令之外） */
const CHECK_RUNNER = /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|lint)\b|\b(vitest|jest|pytest|mocha|tsc|eslint|ruff|mypy|go\s+(test|vet)|cargo\s+(test|check|clippy))\b/;

export class SubagentRuntime {
  readonly env: RunEnv;
  readonly store: StateStore;
  readonly config: FlowConfig;
  private readonly now?: () => Date;
  private lastCall = '';
  private repeats = 0;
  /** 最近被放行的调用：签名与是否改文件 */
  private window: { sig: string; writes: boolean; read: boolean }[] = [];
  private lastFailure = '';
  /** 本机的技能目录（子进程扩展按 Pi 的用户目录找到后设置），隔离工作区里也能用 */
  toolDirs: string[] = [];
  private sameFailures = 0;

  constructor(env: RunEnv, store: StateStore, config: FlowConfig, now?: () => Date) {
    this.env = env;
    this.store = store;
    this.config = config;
    if (now) this.now = now;
  }

  task(): TaskFile {
    return this.store.readTask(this.env.flow, this.env.task);
  }

  /** 子进程应启用的工具；只包含当前已注册的工具由调用方过滤 */
  activeTools(): string[] {
    return this.config.activeTools(this.env.role);
  }

  guardContext(cwd: string): GuardContext {
    const t = this.task();
    const flow = this.store.readFlow(this.env.flow);
    const role = this.config.role(this.env.role);
    return {
      config: this.config,
      role: this.env.role,
      cwd,
      // review / qa 在任务结束后可能还会调用读工具：此时 worktree 已删除，不能回退到主工作区（会被当作越界）。cwd 就是派发时的工作目录（原任务的 worktree 或 qa 的临时 worktree）
      workspaceRoot: t.kind === 'review' || t.kind === 'qa' ? cwd : t.worktree ?? this.env.root,
      mainRoot: this.env.root,
      // 实现类任务可以在模块之间的接口文档里追加（只能新增，forge_submit 检查）
      ...(canAppendInterfaces(t) ? { interfaceAdditions: true } : {}),
      // stage-qa 有 full 档 bash，在集成分支的临时 worktree 里不能越出工作区（除临时目录外不能写）
      ...(t.kind === 'qa' ? { isolatedWorkspace: true } : {}),
      ...(this.toolDirs.length ? { toolDirs: this.toolDirs } : {}),
      ...(opensWrites(t) && role.writes.length ? { openWrites: true } : {}),
      // S0 的 architect 写 rules/：task 的 writes 显式包含 rules/** 时，rules/** 不算受保护路径
      ...(t.writes.includes('rules/**') ? { rulesWritable: true as const } : {}),
      // 模块登记的公共文件（第五轮）也可以写；没有可写范围但能运行命令的角色（验收者）也有临时目录
      ...(role.writes.length ? { writes: [...(t.conflict_files ?? t.writes), ...(t.conflict_files ? [] : t.shared ?? [])], scratchDir: scratchDir(this.env.root, this.env.run) } : {}),
      ...(!role.writes.length && role.bash === 'full' ? { scratchDir: scratchDir(this.env.root, this.env.run) } : {}),
      // merge-fix：冲突文件里原任务适配过的已有测试、契约文件（docs/contracts/**）不在角色可写范围内，也要能改
      ...(t.kind === 'merge-fix' && t.conflict_files ? { extraWritable: t.conflict_files.filter((f) => matchesAny(f, [...TEST_GLOBS, INTERFACES_PATH])) } : {}),
    };
  }

  /**
   * 心跳续租：租约剩余不足一半时延长到"现在 + lease_minutes"。持续调用工具的长任务不会被租约看守误杀；
   * 长时间没有任何工具调用的 run 仍按时过期。续租失败（租约已收回或过期）不影响本次判定，由 forge_* 工具报错。
   */
  async heartbeat(): Promise<boolean> {
    let t: TaskFile;
    try { t = this.task(); } catch { return false; }
    const l = t.lease;
    if (!l || l.run_id !== this.env.run) return false;
    const now = (this.now?.() ?? new Date()).getTime();
    const span = this.config.limits.lease_minutes * 60_000;
    const left = Date.parse(l.expires_at) - now;
    if (left <= 0 || left >= span / 2) return false;
    try {
      await this.store.renewLease(this.env.flow, this.env.task, this.env.run, hashToken(this.env.token), new Date(now + span).toISOString(), `run:${this.env.run}`);
      return true;
    } catch {
      return false;
    }
  }

  async gate(call: ToolCall, cwd: string): Promise<GateResult> {
    await this.heartbeat();
    const r = await enforceToolCall(call, this.guardContext(cwd), this.store, { flow: this.env.flow, task: this.env.task, run: this.env.run });
    if (!r.allow) return { block: true, reason: r.reason, terminate: false };
    // 只统计被放行的调用：被 guard 拦下的照常计违规
    const sig = `${call.toolName}\u0000${JSON.stringify(call.input ?? null)}`;
    this.repeats = sig === this.lastCall ? this.repeats + 1 : 1;
    this.lastCall = sig;
    if (this.repeats >= REPEAT_LIMIT) {
      return this.stop(`连续 ${this.repeats} 次执行完全相同的 ${call.toolName} 调用，判定为原地打转，本次运行结束；任务会重新派发。`, call.toolName);
    }
    if (this.repeats >= REPEAT_WARN) {
      return { block: true, terminate: false, reason: `你已连续 ${this.repeats} 次执行完全相同的 ${call.toolName} 调用，结果不会变化。换一个思路（读相关代码、改变输入、缩小问题），或者用 forge_block 说明卡在哪里；再重复 ${REPEAT_LIMIT - this.repeats} 次本次运行会被结束。` };
    }
    // 滑动窗口：交替执行、只改数字参数的重复
    const kind = this.config.toolKind(call.toolName);
    const read = kind === 'read' || kind === 'ext-read' || kind === 'flow';
    const writes = kind === 'write';
    const norm = normalizedSignature(call.toolName, call.input);
    this.window.push({ sig: norm, writes, read });
    if (this.window.length > WINDOW) this.window.shift();
    if (!read) {
      let since = this.window;
      if (!writes) {
        const lastWrite = this.window.findLastIndex((x, i) => x.writes && i < this.window.length - 1);
        since = this.window.slice(lastWrite + 1);
      }
      const n = since.filter((x) => x.sig === norm).length;
      if (n >= WINDOW_LIMIT) return this.stop(`最近 ${this.window.length} 次调用里同一类 ${call.toolName} 调用出现了 ${n} 次${writes ? '' : '（期间没有改过文件）'}，判定为原地打转，本次运行结束；任务会重新派发。`, call.toolName);
      if (n >= WINDOW_WARN) {
        return { block: true, terminate: false, reason: `最近的调用里这一类 ${call.toolName} 调用已经出现 ${n} 次${writes ? '（来回改同样的内容）' : '（期间没有改过文件，结果不会变化）'}。换一个思路（读相关代码、缩小问题、换一种验证方式），或者用 forge_block 说明卡在哪里；再出现 ${WINDOW_LIMIT - n} 次本次运行会被结束。` };
      }
    }
    return r.warning ? { block: false, note: r.warning } : { block: false };
  }

  /** 结束本次运行：计一次失败（理由写进任务的 last_failure，重试时看得到），任务重新派发 */
  private async stop(reason: string, tool: string): Promise<GateResult> {
    await this.store.recordEvent({ flow: this.env.flow, task: this.env.task, actor: `run:${this.env.run}`, type: 'note', reason, data: { run: this.env.run, tool } }).catch(() => {});
    await this.failRun(reason);
    return { block: true, reason, terminate: true };
  }

  private async failRun(reason: string): Promise<void> {
    try {
      const t = this.task();
      if (t.status !== 'in_progress' || t.lease?.run_id !== this.env.run) return;
      await this.store.transitionTask(this.env.flow, this.env.task, { to: 'in_progress', trigger: 'run_failed', actor: `run:${this.env.run}`, facts: { reason } });
      await this.store.updateRun(this.env.run, { outcome: 'failed' }, `run:${this.env.run}`, '原地打转，结束运行');
    } catch { /* 记账失败不影响结束运行 */ }
  }

  /** 是不是在跑测试、类型检查或 lint（项目配置的命令，或常见的运行器） */
  isCheckCommand(command: string): boolean {
    const configured = ['test', 'typecheck', 'lint'].map((k) => this.config.commands[k]?.trim()).filter((c): c is string => !!c && c !== 'true');
    return configured.some((c) => command.includes(c)) || CHECK_RUNNER.test(command);
  }

  /**
   * 工具结果（第六轮 B2）：测试、类型检查、lint 失败时比较失败输出的签名；同样的失败连续出现说明改了也没进展，提醒换思路，到上限结束本次运行。
   * 通过一次就清零。
   */
  async afterToolResult(toolName: string, input: unknown, isError: boolean, output: string): Promise<ResultCheck> {
    if (toolName !== 'bash') return {};
    const command = input && typeof input === 'object' ? String((input as Record<string, unknown>)['command'] ?? '') : '';
    if (!this.isCheckCommand(command)) return {};
    if (!isError) { this.lastFailure = ''; this.sameFailures = 0; return {}; }
    const sig = failureSignature(failureSummary(output));
    this.sameFailures = sig === this.lastFailure ? this.sameFailures + 1 : 1;
    this.lastFailure = sig;
    if (this.sameFailures >= SAME_FAILURE_LIMIT) {
      const r = await this.stop(`同样的检查失败连续出现 ${this.sameFailures} 次（改动没有让失败变化），判定为没有进展，本次运行结束；任务会重新派发。最后的失败：\n${failureSummary(output, 800)}`, 'bash');
      return { note: r.block ? r.reason : '', terminate: true };
    }
    if (this.sameFailures >= SAME_FAILURE_WARN) {
      return { note: `[pi-forge] 同样的失败已经连续出现 ${this.sameFailures} 次：改动没有让结果变化。停下来重新定位原因（读报错指向的代码、加最小复现、检查假设），或者用 forge_block 说明卡在哪里；再出现 ${SAME_FAILURE_LIMIT - this.sameFailures} 次本次运行会被结束。` };
    }
    return {};
  }

  isFlowTool(name: string): name is SubagentToolName {
    return name in SUBAGENT_TOOLS;
  }

  async callFlowTool(name: SubagentToolName, raw: unknown): Promise<ToolResult> {
    const def = SUBAGENT_TOOLS[name];
    const params = withoutPlaceholders(def.params, raw);
    if (!Value.Check(def.params, params)) {
      const errs = [...Value.Errors(def.params, params)].map((e) => `${e.instancePath || '/'} ${e.message}`);
      throw new FlowToolError(`${name} 参数不合法：${errs.join('；')}`);
    }
    const ctx = { store: this.store, config: this.config, env: this.env, ...(this.now ? { now: this.now } : {}) };
    return (def.run as (c: typeof ctx, p: unknown) => ToolResult | Promise<ToolResult>)(ctx, params);
  }
}
