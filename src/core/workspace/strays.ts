// 残留进程清理（第四轮后续）：子进程结束后，结束工作目录仍在任务 worktree 或临时目录里的进程。
// 真实冒烟：模型把死循环的测试放到后台跑，外层结束后 node 进程留下来，一个个占满 CPU。
// 用 lsof 查每个进程的工作目录（macOS 与 Linux 都有）；没有 lsof 时什么也不做。
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface StrayOptions {
  /** 不结束这些进程及其后代：进程组 id 等于其中之一，或祖先链上有其中之一的进程都保留（仍在运行的其他 run 的 pi 进程 pid）。
   *  审查、修复与原任务共用 worktree，按工作目录找残留会把刚派发的下一个 run（或它正在跑的测试）杀掉。 */
  keepGroups?: readonly number[];
}

/** 进程树：pid → { ppid, pgid }（ps 不可用时为空） */
export function processTree(): Map<number, { ppid: number; pgid: number }> {
  const tree = new Map<number, { ppid: number; pgid: number }>();
  let out = '';
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
  } catch { return tree; }
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m) tree.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]) });
  }
  return tree;
}

/** pid 是否属于 keep 中某个进程：自己、同进程组或后代 */
function keptBy(pid: number, pgid: number, keep: ReadonlySet<number>, tree: ReadonlyMap<number, { ppid: number; pgid: number }>): boolean {
  if (keep.has(pid) || keep.has(pgid)) return true;
  let cur = pid;
  for (let i = 0; i < 64; i++) {
    const p = tree.get(cur);
    if (!p || p.ppid <= 1) return false;
    if (keep.has(p.ppid) || keep.has(p.pgid)) return true;
    cur = p.ppid;
  }
  return false;
}

/** 工作目录在这些目录（含子目录）中的进程 pid；不含本进程与 keepGroups 里的进程组 */
export function processesIn(dirs: readonly string[], opts: StrayOptions = {}): number[] {
  const roots = dirs.filter((d) => existsSync(d)).map((d) => realpathSync(d));
  if (!roots.length) return [];
  const keep = new Set(opts.keepGroups ?? []);
  const tree = keep.size ? processTree() : new Map<number, { ppid: number; pgid: number }>();
  let out: string;
  try {
    out = execFileSync('lsof', ['-n', '-w', '-d', 'cwd', '-Fpgn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
  } catch (e) {
    // lsof 有进程无权查看时也会以非零退出，但标准输出仍然可用
    out = (e as { stdout?: string }).stdout ?? '';
  }
  const pids: number[] = [];
  let pid = 0;
  let pgid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); pgid = 0; }
    else if (line.startsWith('g')) pgid = Number(line.slice(1));
    else if (line.startsWith('n') && pid && pid !== process.pid && !keptBy(pid, pgid, keep, tree)) {
      const cwd = line.slice(1);
      if (roots.some((r) => cwd === r || cwd.startsWith(r + path.sep))) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

/** 结束这些目录里的残留进程，返回被结束的 pid */
export function killStrays(dirs: readonly string[], opts: StrayOptions = {}): number[] {
  const pids = processesIn(dirs, opts);
  for (const p of pids) {
    try { process.kill(p, 'SIGKILL'); } catch { /* 已退出 */ }
  }
  return pids;
}
