// 依赖清单与锁文件的纯函数：共享构建环境据此判断一个 worktree 的依赖清单相对共享环境是"相同、纯追加还是有改动"。
// 从 workspace.ts 搬出了 LOCKFILES、MANIFESTS、lockHash、hasManifest（workspace.ts 仍然 re-export，调用方不变）。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { git } from '../state/git.ts';

/** 计算缓存键的锁文件名（任意目录层级） */
export const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Gemfile.lock', 'composer.lock'];
/** 包清单文件名（任意目录层级）：有清单或锁文件才需要 install */
export const MANIFESTS = ['package.json', 'pnpm-workspace.yaml', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts'];

const inNodeModules = (f: string) => f.split('/').includes('node_modules');

/** 锁文件哈希（纯函数）：按路径排序后把路径与内容一起哈希；没有锁文件时为 null，不缓存 */
export function lockHash(files: readonly { path: string; content: Buffer | string }[]): string | null {
  const locks = files.filter((f) => LOCKFILES.includes(path.posix.basename(f.path)) && !inNodeModules(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!locks.length) return null;
  const h = createHash('sha256');
  for (const f of locks) h.update(f.path).update('\0').update(f.content).update('\0');
  return h.digest('hex').slice(0, 32);
}

/** 文件列表里是否有包清单或锁文件（纯函数；node_modules 下的不算） */
export function hasManifest(files: readonly string[]): boolean {
  return files.some((f) => !inNodeModules(f) && [...MANIFESTS, ...LOCKFILES].includes(path.posix.basename(f)));
}

/** 工作区里的文件（已跟踪 + 未跟踪未忽略），用来找清单与锁文件；不是 git 仓库时为空 */
export function listWorkspaceFiles(dir: string): string[] {
  try { return git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean); } catch { return []; }
}

/** 依赖快照：键 → 版本说明。键 npm:<目录>:<包名>、py:<清单路径>:<包名> 是单个依赖；键 #opaque:… 是无法逐项比较的内容（其他生态的清单、overrides 等），任何变化都算"有改动" */
export type DepSnapshot = Record<string, string>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const NPM_OPAQUE_FIELDS = ['overrides', 'resolutions', 'pnpm', 'packageManager', 'workspaces', 'bundledDependencies'] as const;

/** 从包清单提取依赖快照（纯函数）；锁文件不参与（它们随安装变化，由 lockHash 单独记录） */
export function depSnapshot(files: readonly { path: string; content: Buffer | string }[]): DepSnapshot {
  const out: DepSnapshot = {};
  for (const f of files) {
    if (inNodeModules(f.path)) continue;
    const base = path.posix.basename(f.path);
    const dir = path.posix.dirname(f.path);
    const text = f.content.toString();
    if (base === 'package.json') {
      let j: Record<string, unknown> | null = null;
      try { j = JSON.parse(text) as Record<string, unknown>; } catch { /* 解析失败按不透明内容处理 */ }
      if (!j || typeof j !== 'object') { out[`#opaque:${f.path}`] = sha(text); continue; }
      for (const sec of NPM_SECTIONS) {
        const m = j[sec];
        if (m && typeof m === 'object') for (const [name, spec] of Object.entries(m as Record<string, unknown>)) out[`npm:${dir}:${name}`] = String(spec);
      }
      for (const field of NPM_OPAQUE_FIELDS) if (field in j) out[`#opaque:${f.path}#${field}`] = sha(JSON.stringify(j[field]));
    } else if (/^requirements.*\.txt$/.test(base)) {
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+#.*$/, '').trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/.exec(line);
        if (m) out[`py:${f.path}:${m[1]!.toLowerCase().replace(/[-_.]+/g, '-')}`] = m[2]!.trim();
        else out[`#opaque:${f.path}#${sha(line)}`] = line;
      }
    } else if (MANIFESTS.includes(base)) {
      out[`#opaque:${f.path}`] = sha(text);
    }
  }
  return out;
}

export interface DepChange {
  kind: 'same' | 'additive' | 'changed';
  /** 共享环境里没有的依赖键 */
  added: string[];
  /** 版本说明不同、或不透明内容不同的键 */
  changed: string[];
}

/**
 * worktree 的依赖相对共享环境的变化（纯函数）：
 * worktree 里有、共享环境没有的单个依赖 = 追加；同一依赖说明不同、或不透明内容（其他生态的清单、overrides）有差别 = 改动；
 * 共享环境里有而 worktree 没有的不算（任务分支可能比共享环境旧，程序也从不卸载共享环境里的包，不影响别的任务）。
 */
export function classifyDeps(shared: DepSnapshot, wt: DepSnapshot): DepChange {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of Object.entries(wt)) {
    if (!(k in shared)) (k.startsWith('#opaque:') ? changed : added).push(k);
    else if (shared[k] !== v) changed.push(k);
  }
  return { kind: changed.length ? 'changed' : added.length ? 'additive' : 'same', added: added.sort(), changed: changed.sort() };
}

/** 程序能直接装进共享环境的追加：只限根目录 package.json 的依赖（其他生态与子包清单保守地走私有副本） */
export function addableToShared(added: readonly string[]): boolean {
  return added.length > 0 && added.every((k) => k.startsWith('npm:.:'));
}
/** npm:.:left-pad → left-pad */
export const depNameOfKey = (k: string) => k.slice('npm:.:'.length);

/** 按锁文件推断"追加一个依赖"的命令（依赖说明从环境变量 FORGE_DEP 取，不拼进命令文本）；没有包清单时为 null */
export function defaultAddCommand(files: readonly string[], dev: boolean): string | null {
  const names = new Set(files.filter((f) => !inNodeModules(f)).map((f) => path.posix.basename(f)));
  if (names.has('pnpm-lock.yaml')) return `pnpm add${dev ? ' -D' : ''} "$FORGE_DEP"`;
  if (names.has('yarn.lock')) return `yarn add${dev ? ' -D' : ''} "$FORGE_DEP"`;
  if (names.has('bun.lock') || names.has('bun.lockb')) return `bun add${dev ? ' -d' : ''} "$FORGE_DEP"`;
  if (names.has('package-lock.json') || names.has('npm-shrinkwrap.json') || names.has('package.json')) return `npm install${dev ? ' -D' : ''} "$FORGE_DEP"`;
  return null;
}

const DEP_NAME = /^(@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const DEP_VERSION = /^[A-Za-z0-9._^~*+<>=|-]{1,64}$/;
/** 依赖名与版本的格式检查（纯函数）；返回问题，合格时为 null */
export function depSpecProblem(name: string, version?: string): string | null {
  if (!DEP_NAME.test(name) || name.length > 214) return `依赖名 ${JSON.stringify(name.slice(0, 80))} 格式不对（例如 left-pad 或 @scope/pkg）`;
  if (version !== undefined && !DEP_VERSION.test(version)) return `版本 ${JSON.stringify(version.slice(0, 80))} 格式不对（例如 1.2.3、^1.2.0、latest）`;
  return null;
}
