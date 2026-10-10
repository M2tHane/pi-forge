// 消融实验的运行器：node scripts/ablation/run.ts [--only a,b] [--skip a,b] [--parallel 3] [--out <目录>] [--check] [--unit-only] [--no-real-pi]
// --no-real-pi：e2e 不跑用真实 pi 进程的四个文件（它们在并行负载下会超时，且不涉及被消融的机制）
// 每一臂：在 HEAD 建临时 worktree（不动当前工作区）→ 链接 node_modules → 应用替换 → 跑单元与 e2e（TAP）→ 记下失败的用例。
// 结果写到 <out>/<臂>.json，汇总写到 <out>/summary.json。不调用真实 LLM（与 npm test 相同的夹具）。
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { ARMS, type Arm } from './ablations.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const only = opt('only')?.split(',');
const parallel = Number(opt('parallel') ?? 3);
const out = path.resolve(opt('out') ?? '/tmp/forge-ablation');
const checkOnly = args.includes('--check');
const unitOnly = args.includes('--unit-only');
const skip = opt('skip')?.split(',') ?? [];
export const REAL_PI_E2E = ['crash-recovery.test.ts', 'orchestrator-session.test.ts', 'orchestrator-p0.test.ts', 'pi-subprocess.test.ts'];
const e2eFiles = (dir: string) => args.includes('--no-real-pi')
  ? readdirSync(path.join(dir, 'test/e2e')).filter((f) => f.endsWith('.test.ts') && !REAL_PI_E2E.includes(f)).sort().map((f) => `test/e2e/${f}`)
  : ['test/e2e/**/*.test.ts'];

export interface Failure { suite: 'unit' | 'e2e'; file: string; name: string }
export interface ArmResult { id: string; kind: Arm['kind']; mechanism: string; hypothesis: string; commit: string; pass: number; fail: number; failures: Failure[]; minutes: number; error?: string }

/** 应用替换：每段 find 必须恰好出现一次 */
export function applyEdits(dir: string, arm: Arm): void {
  for (const e of arm.edits) {
    const f = path.join(dir, e.file);
    const text = readFileSync(f, 'utf8');
    const n = text.split(e.find).length - 1;
    if (n !== 1) throw new Error(`${arm.id}：${e.file} 中找到 ${n} 处替换目标（应为 1）：${e.find.slice(0, 80)}`);
    writeFileSync(f, text.replace(e.find, () => e.replace));
  }
}

/** 解析 node --test 的 TAP 输出：返回叶子失败（"文件 › 用例"）与通过、失败计数 */
export function parseTap(tap: string, suite: Failure['suite']): { pass: number; fail: number; failures: Failure[] } {
  const stack: { indent: number; name: string }[] = [];
  const failed: string[][] = [];
  for (const line of tap.split('\n')) {
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const indent = sub[1]!.length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      stack.push({ indent, name: sub[2]! });
      continue;
    }
    const res = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # .*)?$/.exec(line);
    if (!res) continue;
    const indent = res[1]!.length;
    while (stack.length && stack.at(-1)!.indent > indent) stack.pop();
    const pathNames = stack.map((s) => s.name);
    if (stack.length && stack.at(-1)!.indent === indent) stack.pop();
    if (res[2] === 'not ok') failed.push(pathNames.length ? pathNames : [res[3]!]);
  }
  const key = (p: string[]) => p.join(' › ');
  const leaves = failed.filter((p) => !failed.some((q) => q.length > p.length && key(q).startsWith(key(p) + ' › ')));
  const num = (k: string) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(tap)?.[1] ?? 0);
  return { pass: num('pass'), fail: num('fail'), failures: leaves.map((p) => ({ suite, file: path.basename(p[0]!), name: p.slice(1).join(' › ') || p[0]! })) };
}

function run(cmd: string, argv: string[], cwd: string, logFile: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const log = createWriteStream(logFile);
    let text = '';
    const child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => { text += b.toString('utf8'); log.write(b); });
    child.stderr.on('data', (b: Buffer) => log.write(b));
    child.on('close', () => { log.end(); resolve(text); });
  });
}

async function runArm(arm: Arm, commit: string): Promise<ArmResult> {
  const started = Date.now();
  const dir = path.join(out, 'wt', arm.id);
  const base: ArmResult = { id: arm.id, kind: arm.kind, mechanism: arm.mechanism, hypothesis: arm.hypothesis, commit, pass: 0, fail: 0, failures: [], minutes: 0 };
  try {
    if (existsSync(dir)) { try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO }); } catch { rmSync(dir, { recursive: true, force: true }); } }
    execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, commit], { cwd: REPO });
    symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    applyEdits(dir, arm);
    if (checkOnly) return { ...base, minutes: 0 };
    const env = { ...process.env, FORGE_ABLATION_PROBE: arm.edits.some((e) => e.find.includes("import { spawn } from 'node:child_process'")) ? path.join(out, `${arm.id}.probe.tsv`) : '' };
    if (env.FORGE_ABLATION_PROBE) rmSync(env.FORGE_ABLATION_PROBE, { force: true });
    const unit = parseTap(await run('node', ['--test', '--test-concurrency=3', '--test-reporter=tap', 'test/unit/**/*.test.ts'], dir, path.join(out, `${arm.id}.unit.tap`), env), 'unit');
    const e2e = unitOnly ? { pass: 0, fail: 0, failures: [] } : parseTap(await run('node', ['--test', '--test-concurrency=2', '--test-reporter=tap', ...e2eFiles(dir)], dir, path.join(out, `${arm.id}.e2e.tap`), env), 'e2e');
    return { ...base, pass: unit.pass + e2e.pass, fail: unit.fail + e2e.fail, failures: [...unit.failures, ...e2e.failures], minutes: Math.round((Date.now() - started) / 6000) / 10 };
  } catch (e) {
    return { ...base, error: (e as Error).message, minutes: Math.round((Date.now() - started) / 6000) / 10 };
  } finally {
    if (!checkOnly) { try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO }); } catch { /* 留给下次清理 */ } }
  }
}

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const arms = ARMS.filter((a) => (!only || only.includes(a.id)) && !skip.includes(a.id));
  const results: ArmResult[] = [];
  const queue = [...arms];
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, async () => {
    for (let arm = queue.shift(); arm; arm = queue.shift()) {
      const r = await runArm(arm, commit);
      results.push(r);
      writeFileSync(path.join(out, `${arm.id}.json`), JSON.stringify(r, null, 2));
      console.log(`${r.id}\t${r.error ? `错误：${r.error}` : `通过 ${r.pass}，失败 ${r.fail}`}\t${r.minutes} 分钟`);
    }
  }));
  if (checkOnly) for (const a of arms) { try { execFileSync('git', ['worktree', 'remove', '--force', path.join(out, 'wt', a.id)], { cwd: REPO }); } catch { /* 无 */ } }
  const order = new Map(ARMS.map((a, i) => [a.id, i]));
  results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  // 分批运行时合并之前的结果
  const merged = new Map<string, ArmResult>();
  for (const f of readdirSync(out).filter((x) => x.endsWith('.json') && x !== 'summary.json')) { const r = JSON.parse(readFileSync(path.join(out, f), 'utf8')) as ArmResult; merged.set(r.id, r); }
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify([...merged.values()].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99)), null, 2));
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) await main();
