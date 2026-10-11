// 来源：pi-flow test/fixtures/fake-subagent/launcher.ts @ 31f3f15
// fake-subagent：实现 SubagentLauncher，用脚本代替模型调用工具。
// 每次调用都经过真实的 SubagentRuntime（guard + forge_* 工具）；内置工具在 worktree 中真实执行。
import { redactSecrets } from '../../../src/core/security/redact.ts';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SubagentHandle, SubagentLauncher, SubagentSpec, RunOutcome } from '../../../src/core/engine/launcher.ts';
import type { StateStore } from '../../../src/core/state/state-store.ts';
import type { FlowConfig } from '../../../src/core/state/config.ts';
import { SubagentRuntime } from '../../../src/core/engine/subagent-runtime.ts';
import { runEnvFrom, type RunEnv } from '../../../src/tools/subagent-tools.ts';

export class Terminated extends Error {}

export interface CallResult { ok: boolean; text: string }

export interface FakeAgent {
  spec: SubagentSpec;
  env: RunEnv;
  call(tool: string, input?: Record<string, unknown>): Promise<CallResult>;
  /** 用篡改过的环境（例如伪造 token）调用 forge_* 工具 */
  callAs(env: Partial<RunEnv>, tool: string, input?: Record<string, unknown>): Promise<CallResult>;
}

export type Script = (a: FakeAgent) => Promise<void>;

export class FakeLauncher implements SubagentLauncher {
  readonly launched: SubagentSpec[] = [];
  readonly transcripts: { role: string; calls: { tool: string; ok: boolean; text: string }[] }[] = [];
  /** 运行中插话（时间预算到期的收尾提醒、/forge-add） */
  readonly steers: { run: string; message: string }[] = [];
  private readonly store: StateStore;
  private readonly config: FlowConfig;
  private readonly pick: (spec: SubagentSpec, nth: number) => Script;

  constructor(store: StateStore, config: FlowConfig, pick: (spec: SubagentSpec, nth: number) => Script) {
    this.store = store;
    this.config = config;
    this.pick = pick;
  }

  launch(spec: SubagentSpec): SubagentHandle {
    this.launched.push(spec);
    const env = runEnvFrom(spec.env);
    if (!env) throw new Error('缺少 PI_FORGE_* 环境变量');
    const nth = this.launched.filter((s) => s.env['PI_FORGE_TASK'] === env.task && s.env['PI_FORGE_ROLE'] === env.role).length;
    const transcript = { role: env.role, calls: [] as { tool: string; ok: boolean; text: string }[] };
    this.transcripts.push(transcript);
    let terminated = false;
    let calls = 0;

    const exec = async (rt: SubagentRuntime, tool: string, input: Record<string, unknown>): Promise<CallResult> => {
      if (terminated) throw new Terminated();
      if (!spec.tools.includes(tool)) return { ok: false, text: `工具 ${tool} 未启用` };
      const g = await rt.gate({ toolName: tool, input }, spec.cwd);
      if (g.block) {
        if (g.terminate) { terminated = true; throw new Terminated(g.reason); }
        return { ok: false, text: g.reason };
      }
      calls++;
      try {
        if (rt.isFlowTool(tool)) return { ok: true, text: (await rt.callFlowTool(tool, input)).text };
        const p = typeof input['path'] === 'string' ? path.resolve(spec.cwd, input['path']) : '';
        switch (tool) {
          case 'write':
            mkdirSync(path.dirname(p), { recursive: true });
            writeFileSync(p, String(input['content'] ?? ''));
            return { ok: true, text: `Successfully wrote to ${input['path']}` };
          case 'read':
            return { ok: true, text: readFileSync(p, 'utf8') };
          case 'edit': {
            let s = readFileSync(p, 'utf8');
            for (const e of input['edits'] as { oldText: string; newText: string }[]) s = s.replace(e.oldText, e.newText);
            writeFileSync(p, s);
            return { ok: true, text: 'edited' };
          }
          case 'bash': {
            // 与 subagent 扩展的 tool_result 钩子一致：检查类命令的失败交给运行时比较（第六轮 B2）
            let r: CallResult;
            try {
              r = { ok: true, text: execSync(String(input['command']), { cwd: spec.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
            } catch (e) {
              const x = e as { stdout?: string; stderr?: string; status?: number };
              r = { ok: false, text: `${x.stdout ?? ''}${x.stderr ?? ''}\nCommand exited with code ${x.status ?? 1}` };
            }
            const c = await rt.afterToolResult('bash', input, !r.ok, r.text);
            if (c.terminate) { terminated = true; throw new Terminated(c.note); }
            return c.note ? { ...r, text: `${r.text}\n\n${c.note}` } : r;
          }
          default:
            return { ok: true, text: `（fake）${tool}` };
        }
      } catch (e) {
        if (e instanceof Terminated) throw e;
        return { ok: false, text: (e as Error).message };
      }
    };

    const rt = new SubagentRuntime(env, this.store, this.config);
    const agent: FakeAgent = {
      spec, env,
      call: async (tool, input = {}) => {
        // 与 subagent 扩展的 tool_result 钩子一致：结果里的密钥打码（第六轮 D4）
        const raw = await exec(rt, tool, input);
        const r = { ...raw, text: redactSecrets(raw.text).text };
        transcript.calls.push({ tool, ...r });
        return r;
      },
      callAs: async (override, tool, input = {}) => {
        const r = await exec(new SubagentRuntime({ ...env, ...override }, this.store, this.config), tool, input);
        transcript.calls.push({ tool: `${tool}(伪造)`, ...r });
        return r;
      },
    };
    const script = this.pick(spec, nth);
    const outcome = (exitCode: number, error: string | null): RunOutcome => ({
      exitCode, stderrTail: '', error, model: spec.model, turns: calls,
      tokens: { input: 100 * (calls + 1), output: 10 * (calls + 1), cache_read: 50 * calls, cache_write: 0 },
      stopReason: error ? 'error' : 'stop', lastText: '',
    });
    // 异步执行：dispatch 立即返回，与真实子进程一致
    const done = new Promise<void>((r) => setImmediate(r)).then(() => script(agent)).then(
      () => outcome(0, null),
      (e) => outcome(1, e instanceof Terminated ? '被 guard 终止' : String(e)),
    );
    return { pid: undefined, done, kill: () => { terminated = true; }, steer: (message) => { this.steers.push({ run: env.run, message }); return !terminated; } };
  }
}
