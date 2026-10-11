// 来源：pi-flow src/core/verify-runner.ts @ 31f3f15
// 运行 workflow.yaml 中的命令（合并后验证与阶段闸门共用）：清理过的环境、超时、输出截断与 evidence 文本。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

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
  return [`命令：${r.command}`, `实际执行：${shell}`, `退出码：${r.exit_code}${r.timed_out ? '（超时）' : ''}`, `耗时：${r.duration_ms} ms`, '', r.output].join('\n');
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

/** 失败签名：摘要归一化（数字、耗时、十六进制、临时路径）后的短哈希。同样的失败重复出现时签名相同 */
export function failureSignature(summary: string): string {
  const norm = summary
    .replace(/(\/[\w.@+-]+)*\/(tmp|var\/folders|worktrees)\/[\w./@+-]*/g, '<path>')
    .replace(/\br-[0-9a-z]{6,}\b/g, '<run>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hex>')
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/g, '<t>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 12);
}
