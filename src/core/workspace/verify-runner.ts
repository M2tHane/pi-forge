// 来源：pi-flow src/core/verify-runner.ts @ 31f3f15
// 运行 workflow.yaml 中的命令（合并后验证与阶段闸门共用）：清理过的环境、超时、输出截断与 evidence 文本。
import { spawn } from 'node:child_process';
import type { StateStore } from '../state/state-store.ts';

export interface VerifyResult { command: string; exit_code: number }

const OUTPUT_LIMIT = 64 * 1024;
export const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60_000;

export interface CommandRun extends VerifyResult { output: string; duration_ms: number; timed_out: boolean }

/** 子进程环境：去掉 run token 等 pi-forge 内部变量 */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('PI_FORGE_')) delete env[k];
  return env;
}

/** extraEnv：第 4.1 节分配的资源变量等，叠加在清理过密钥的环境上 */
export function runShell(command: string, cwd: string, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, extraEnv: Record<string, string> = {}): Promise<Omit<CommandRun, 'command'>> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...scrubbedEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const take = (b: Buffer) => { out = (out + b.toString('utf8')).slice(-OUTPUT_LIMIT); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exit_code: timedOut ? 124 : (code ?? 1), output: out, duration_ms: Date.now() - started, timed_out: timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exit_code: 127, output: String(e), duration_ms: Date.now() - started, timed_out: false });
    });
  });
}

export function evidenceText(r: CommandRun, shell: string): string {
  const missing = detectToolMissing(r.exit_code, r.output);
  return [`命令：${r.command}`, `实际执行：${shell}`, `退出码：${r.exit_code}${r.timed_out ? '（超时）' : ''}`, `耗时：${r.duration_ms} ms`, ...(missing ? [`工具缺失，已跳过：${r.command}（${missing.tool}）`] : []), '', r.output].join('\n');
}

// —— 工具缺失（偏离 108）——

const PEEK_LINES = 10;
/** 测试框架的输出标记：出现在匹配行之前，说明命令已经跑起来了，后面的 not found 是测试自己的输出 */
const TEST_MARK = /^(not ok\b|ok \d|TAP version|# Subtest|✖|✗|✘|×|FAIL\b|PASS\b|RUN\b)/;
const TOOL_MISSING_PATTERNS: { re: RegExp; tool: (m: RegExpExecArray) => string }[] = [
  // sh -c：`sh: 1: redocly: not found`、`/bin/sh: redocly: command not found`、`bash: line 1: x: command not found`
  { re: /^(?:\/\S+\/)?(?:ba|da|z|a)?sh: (?:line )?(?:\d+: )?([^\s:]+): (?:command )?not found$/, tool: (m) => m[1]! },
  // zsh：`zsh: command not found: redocly`
  { re: /^(?:\/\S+\/)?(?:ba|da|z|a)?sh: command not found: (\S+)$/, tool: (m) => m[1]! },
  // pnpm：`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "redocly" not found`，新版本错误码带方括号（`[ERR_PNPM_…] Command "x" not found`），旧版本只有 `Command "x" not found`
  { re: /^(?:\[?ERR_PNPM_\w+\]?\s+)?Command "([^"]+)" not found\b/, tool: (m) => m[1]! },
  // npm / npx
  { re: /^npm (?:error|ERR!) could not determine executable to run\b/, tool: () => 'npx' },
  { re: /^npx: (?:command )?not found$/, tool: () => 'npx' },
  { re: /^(?:\/\S+\/)?env: '?([^:']+)'?: No such file or directory$/, tool: (m) => m[1]! }
];

/**
 * 命令是否因「工具不存在」而失败（纯函数）。只认明确信号，保守：
 * - 退出码 127（shell 的"命令未找到"，spawn 失败也是 127）；
 * - 或退出码非 0，且输出前 10 个非空行里有工具层的固定报错格式（整行匹配，不是随便含 "not found"），
 *   并且这一行之前没有测试框架的输出标记。
 * 断言失败里恰好含 "not found" 字样（行中间、不是整行格式）不会命中。
 */
export function detectToolMissing(exitCode: number, output: string): { tool: string } | null {
  if (exitCode === 0) return null;
  const lines = output.replace(ANSI, '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, PEEK_LINES);
  let found: { tool: string } | null = null;
  for (const line of lines) {
    if (TEST_MARK.test(line)) break;
    const hit = TOOL_MISSING_PATTERNS.map((p) => { const m = p.re.exec(line); return m ? { tool: p.tool(m) } : null; }).find(Boolean);
    if (hit) { found = hit; break; }
  }
  if (exitCode === 127) return found ?? { tool: '未知' };
  return found;
}

/**
 * 工具缺失时记一条事件（note，data.tool_missing 为命令名）并返回 true：调用方把该命令记为跳过，不算失败。
 * 通知按 (flow, 命令) 去重（status-view 的 action）。
 */
export async function noteToolMissing(store: Pick<StateStore, 'recordEvent'>, r: CommandRun, ctx: { flow: string; task?: string; stage?: string; actor: string }): Promise<boolean> {
  const missing = detectToolMissing(r.exit_code, r.output);
  if (!missing) return false;
  await store.recordEvent({ flow: ctx.flow, ...(ctx.task ? { task: ctx.task } : {}), actor: ctx.actor, type: 'note', reason: `工具缺失，已跳过：${r.command}（${missing.tool}）`,
    data: { tool_missing: r.command, tool: missing.tool, ...(ctx.stage ? { stage: ctx.stage } : {}) } });
  return true;
}

// —— 失败输出摘要与签名（第六轮 A2、B3）——

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
/** 判定为"关键"的行：常见测试框架、编译器、运行时的错误标记 */
const KEY_LINE = /\b(error|errors|fail|failed|failing|failure|exception|assert|assertion|panic|traceback|cannot|undefined|not ok|expected|received)\b|TS\d{4}|✗|✘|×|●|FAIL\b|ERR!/i;

export const SUMMARY_LIMIT = 2000;

/** 命令失败时的关键输出：去 ANSI，优先错误行及前后各 2 行，没有就取尾部；上限 limit 字 */
export function failureSummary(output: string, limit = SUMMARY_LIMIT): string {
  const lines = output.replace(ANSI, '').replace(/\r/g, '').split('\n').map((l) => l.trimEnd());
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (!l.trim() || !KEY_LINE.test(l)) return;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
  });
  const pick = (idx: number[]) => {
    const out: string[] = [];
    let prev = -2;
    for (const i of idx) {
      if (!lines[i]!.trim()) continue;
      if (prev >= 0 && i > prev + 1) out.push('…');
      out.push(lines[i]!);
      prev = i;
    }
    return out.join('\n');
  };
  let text = keep.size ? pick([...keep].sort((a, b) => a - b)) : '';
  if (!text) text = lines.filter((l) => l.trim()).slice(-40).join('\n');
  // 关键行太多时保留开头与结尾（第一个错误与汇总通常都有用）
  if (text.length > limit) {
    const half = Math.floor((limit - 3) / 2);
    text = `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
  }
  return text.trim();
}
