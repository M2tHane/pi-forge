// 来源：pi-flow src/core/paths.ts @ 31f3f15
// 路径规范化与 glob 关系判断。guard、dag、提交 diff 检查共用。
import path from 'node:path';
import { minimatch } from 'minimatch';

const MM = { dot: true } as const;
const GLOB_CHARS = /[*?[\]{}]/;

export const PROTECTED_PATHS = ['.forge/**', '.git/**', 'workflow.yaml', 'rules/**', '.pi/**'] as const;
/** 模块之间的接口文档（第五轮）：实现者只能追加 */
export const INTERFACES_PATH = 'docs/contracts/**';
/** implementation_gate.test_author 为 false 时（偏离 81），impl 自己写验收测试：它自己的验收目录 */
export const ownAcceptanceGlob = (impl: string) => `tests/acceptance/${impl}/**`;
/**
 * 偏离 110：lean 且 test_author 关闭时，所有 impl / fix 共用一个验收目录（目录名避开 T-xxx，以免与 usedTaskIds、legacy 判定冲突），
 * 辅助函数只有一份（suite/_helpers.js）。预检按目录名运行 `acceptance -- suite`。
 */
export const SHARED_ACCEPTANCE_DIR = 'suite';
export const SHARED_ACCEPTANCE_GLOB = `tests/acceptance/${SHARED_ACCEPTANCE_DIR}/**`;
/** impl 自己写验收测试时要加进 writes 的 glob：shared（lean）为共享目录，否则是 impl 自己的目录 */
export const selfTestGlob = (impl: string, shared: boolean) => (shared ? SHARED_ACCEPTANCE_GLOB : ownAcceptanceGlob(impl));
type WritesOf = { id: string; for_task?: string | undefined; writes: readonly string[] };
/** task 的 writes 里带有共享验收目录 */
export const writesSharedAcceptance = (t: Pick<WritesOf, 'writes'>) => t.writes.includes(SHARED_ACCEPTANCE_GLOB);
/** task（impl 或它的 fix）的 writes 里带有自己的验收目录（或共享目录），即由 worker 自己写验收测试 */
export const writesOwnAcceptance = (t: WritesOf) => writesSharedAcceptance(t) || t.writes.includes(ownAcceptanceGlob(t.for_task ?? t.id));
/** worker 自己写验收测试时，该 task 的验收目录名：共享目录 suite，否则是 impl 编号 */
export const acceptanceDirOf = (t: WritesOf) => (writesSharedAcceptance(t) ? SHARED_ACCEPTANCE_DIR : (t.for_task ?? t.id));
/** 该 task 自己的验收目录 glob（writesOwnAcceptance 为真时才有意义） */
export const selfTestGlobOf = (t: WritesOf) => selfTestGlob(t.for_task ?? t.id, writesSharedAcceptance(t));
export const SENSITIVE_PATHS = ['**/.env*', '**/*.pem', 'secrets/**', '**/secrets/**'] as const;

/** 把路径规范化为相对 root 的 posix 路径；越出 root 返回 null。不解析符号链接（由调用方用 realpath 处理）。 */
export function normalizeRelPath(root: string, p: string): string | null {
  const abs = path.resolve(root, p);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function matchesAny(rel: string, globs: readonly string[]): boolean {
  return globs.some((g) => minimatch(rel, g, MM));
}

/**
 * lean 的计划里 writes 属于单元测试 / 测试代码的路径（偏离 110，纯函数；偏离 115 起也用于判断单个文件）：任一路径段是 test、tests、__tests__、spec、specs、e2e，
 * 或文件名带 test / spec 标记（a.test.js、foo_test.go、test-utils.js）。不用 globsOverlap：`src/**\/*.js` 与 `*.test.*` 会被误判为重叠。
 */
export function isTestWrite(w: string): boolean {
  const segs = w.split('/').filter(Boolean);
  if (segs.slice(0, -1).some((x) => /^(?:tests?|__tests__|specs?|e2e)$/.test(x))) return true;
  const last = segs.at(-1) ?? '';
  return /^(?:tests?|__tests__|specs?|e2e)$/.test(last) || /(?:^|[._-])(?:test|spec)s?(?:[._-]|$)/.test(last);
}

/**
 * 偏离 115：impl / fix 不受计划 writes 限制，writes 只用于调度互斥与冲突分类。仍不能改的：验收测试（writes 里自己的验收目录除外）、规格；
 * writes 里没有测试路径时也不能新建测试代码（保留偏离 111 的 lean 约束；已有测试的适配另走 adjustableTests）。受保护路径另行检查。
 */
export const OPEN_WRITES_EXCEPT = ['tests/acceptance/**', 'docs/spec/**'] as const;
export const opensWrites = (t: { kind: string }) => t.kind === 'impl' || t.kind === 'fix';
export function openWriteAllowed(rel: string, writes: readonly string[]): boolean {
  if (matchesAny(rel, writes)) return true;
  if (matchesAny(rel, OPEN_WRITES_EXCEPT)) return false;
  return !isTestWrite(rel) || writes.some((w) => isTestWrite(w) && !w.startsWith('tests/acceptance/'));
}

/** read_paths 按顺序覆盖：普通模式允许，! 模式排除；没有匹配默认拒绝。 */
export function matchesReadPaths(rel: string, globs: readonly string[]): boolean {
  let allowed = false;
  for (const glob of globs) {
    const exclude = glob.startsWith('!');
    const pattern = exclude ? glob.slice(1) : glob;
    if (!pattern) continue;
    // 同时匹配目录本身，防止通过 ls/read 读取被排除目录的列表。
    if (minimatch(rel, pattern, { ...MM, nonegate: true }) || minimatch(`${rel}/`, pattern, { ...MM, nonegate: true })) {
      allowed = !exclude;
    }
  }
  return allowed;
}

export function protectedGlobs(): string[] {
  return [...PROTECTED_PATHS];
}

export function isProtected(rel: string): boolean {
  return matchesAny(rel, PROTECTED_PATHS);
}

export function isSensitive(rel: string): boolean {
  return matchesAny(rel, SENSITIVE_PATHS);
}

/** 模式 inner 匹配的路径是否一定落在 outer 内（保守判断：不确定时返回 false）。 */
export function globWithin(inner: string, outer: string): boolean {
  return minimatch.braceExpand(inner).every((i) =>
    minimatch.braceExpand(outer).some((o) => minimatch(i, o, MM)));
}

/** 两个模式是否可能匹配同一路径（保守判断：不确定时返回 true）。 */
export function globsOverlap(a: string, b: string): boolean {
  for (const x of minimatch.braceExpand(a)) {
    for (const y of minimatch.braceExpand(b)) {
      if (segsOverlap(x.split('/').filter(Boolean), y.split('/').filter(Boolean))) return true;
    }
  }
  return false;
}

function segsOverlap(a: string[], b: string[]): boolean {
  const memo = new Map<string, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === a.length && j === b.length) r = true;
    else if (a[i] === '**') r = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (b[j] === '**') r = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) r = false;
    else r = segOverlap(a[i]!, b[j]!) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

function segOverlap(x: string, y: string): boolean {
  const gx = GLOB_CHARS.test(x);
  const gy = GLOB_CHARS.test(y);
  if (!gx && !gy) return x === y;
  if (!gx) return minimatch(x, y, MM);
  if (!gy) return minimatch(y, x, MM);
  // 两边都是通配：比较字面前缀与后缀，冲突即不重叠
  const [px, sx] = literalEnds(x);
  const [py, sy] = literalEnds(y);
  const prefixOk = px.startsWith(py) || py.startsWith(px);
  const suffixOk = sx.endsWith(sy) || sy.endsWith(sx);
  return prefixOk && suffixOk;
}

function literalEnds(s: string): [string, string] {
  const first = s.search(GLOB_CHARS);
  let last = -1;
  for (let i = s.length - 1; i >= 0; i--) if (GLOB_CHARS.test(s[i]!)) { last = i; break; }
  return [s.slice(0, first), s.slice(last + 1)];
}
