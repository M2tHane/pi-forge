// 来源：pi-flow src/core/git.ts @ 31f3f15
// git 子进程封装：统一身份、遇到 index.lock 等锁冲突时短暂重试。
import { execFileSync } from 'node:child_process';

export const ENGINE_GIT_ENV = {
  GIT_AUTHOR_NAME: 'pi-forge', GIT_AUTHOR_EMAIL: 'pi-forge@localhost',
  GIT_COMMITTER_NAME: 'pi-forge', GIT_COMMITTER_EMAIL: 'pi-forge@localhost',
};

/**
 * 路径按 UTF-8 原样输出（core.quotePath=false）：默认会把中文等非 ASCII 路径转义并加引号，按行解析时读不到文件
 * （M9 冒烟：feature 规格文件名是中文，P1 预检按 ref 读规格时漏掉了增量需求，偏离 91）。用环境变量注入，不改参数。
 */
const QUOTE_PATH_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotePath', GIT_CONFIG_VALUE_0: 'false' };

export class GitError extends Error {
  readonly stderr: string;
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(' ')} 失败：${stderr.trim().split('\n').slice(-3).join(' ')}`);
    this.name = 'GitError';
    this.stderr = stderr;
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function git(cwd: string, args: string[], opts: { engineIdentity?: boolean; allowFail?: boolean; env?: Record<string, string> } = {}): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...QUOTE_PATH_ENV, ...(opts.engineIdentity ? ENGINE_GIT_ENV : {}), ...opts.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as { stderr?: string; status?: number };
      const stderr = String(err.stderr ?? '');
      if (/index\.lock|\.lock': File exists|Unable to create .*\.lock/.test(stderr) && attempt < 20) {
        sleep(50 + attempt * 25);
        continue;
      }
      if (opts.allowFail) throw Object.assign(new GitError(args, stderr), { status: err.status });
      throw new GitError(args, stderr);
    }
  }
}

/** 命令以非零退出码表示"否"时使用（如 diff --quiet）。 */
export function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args, { allowFail: true });
    return true;
  } catch {
    return false;
  }
}

/** 工作区未提交的文件（含未跟踪，排除 .forge）；从 engine/context-injector.ts 移入（偏离 106，stage/release 也要用） */
export function dirtyFiles(root: string): Set<string> {
  const out = git(root, ['status', '--porcelain', '-uall', '--', '.', ':(exclude).forge']).split('\n').filter(Boolean);
  return new Set(out.map((l) => l.slice(3)));
}
