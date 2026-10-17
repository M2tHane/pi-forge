// 路径规范化与 glob 关系判断。guard、dag、提交 diff 检查共用。
import path from 'node:path';
import { minimatch } from 'minimatch';

const MM = { dot: true } as const;
const GLOB_CHARS = /[*?[\]{}]/;

export const PROTECTED_PATHS = ['.forge/**', '.git/**', 'workflow.yaml', 'rules/**', '.pi/**'] as const;
/** 契约文档：合并冲突时做结构化三方合并 */
export const INTERFACES_PATH = 'docs/contracts/**';
/** impl 自己写验收测试：它自己的验收目录 */
export const ownAcceptanceGlob = (impl: string) => `tests/acceptance/${impl}/**`;
type WritesOf = { id: string; for_task?: string | undefined; writes: readonly string[] };
/** task（impl 或它的 fix）的 writes 里带有自己的验收目录，即由 worker 自己写验收测试 */
export const writesOwnAcceptance = (t: WritesOf) => t.writes.includes(ownAcceptanceGlob(t.for_task ?? t.id));
/** 该 task 自己的验收目录名（impl 编号） */
export const acceptanceDirOf = (t: Pick<WritesOf, 'id' | 'for_task'>) => t.for_task ?? t.id;
/** 该 task 自己的验收目录 glob */
export const selfTestGlobOf = (t: Pick<WritesOf, 'id' | 'for_task'>) => ownAcceptanceGlob(t.for_task ?? t.id);
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
 * writes 属于单元测试 / 测试代码的路径（纯函数；也用于判断单个文件）：任一路径段是 test、tests、__tests__、spec、specs、e2e，
 * 或文件名带 test / spec 标记（a.test.js、foo_test.go、test-utils.js）。不用 globsOverlap：`src/**\/*.js` 与 `*.test.*` 会被误判为重叠。
 */
export function isTestWrite(w: string): boolean {
  const segs = w.split('/').filter(Boolean);
  if (segs.slice(0, -1).some((x) => /^(?:tests?|__tests__|specs?|e2e)$/.test(x))) return true;
  const last = segs.at(-1) ?? '';
  return /^(?:tests?|__tests__|specs?|e2e)$/.test(last) || /(?:^|[._-])(?:test|spec)s?(?:[._-]|$)/.test(last);
}

/**
 * impl / fix 不受计划 writes 限制（writes 只用于合并冲突与问题归属）：除用户的需求输入（PRD 与原型）与受保护路径外，工作区内任何文件都可以改。
 * 受保护路径另行检查（isProtectedFor）。
 */
export const OPEN_WRITES_EXCEPT = ['docs/PRD.md', 'docs/prototype/**'] as const;
export const opensWrites = (t: { kind: string }) => t.kind === 'impl' || t.kind === 'fix';
export const openWriteAllowed = (rel: string): boolean => !matchesAny(rel, OPEN_WRITES_EXCEPT);

export function protectedGlobs(): string[] {
  return [...PROTECTED_PATHS];
}

export function isProtected(rel: string): boolean {
  return matchesAny(rel, PROTECTED_PATHS);
}
/**
 * 架构师负责的文档：对 backend、frontend 是受保护路径。契约与公共规范要改时问架构师（并行开发的 domain 与页面都依赖它们）；
 * rules/** 本来就受保护。
 */
export const ARCH_OWNED_PATHS = ['docs/contracts/**', 'docs/arch/**', 'docs/plan.md', 'AGENTS.md'] as const;
export const archOwnedProtected = (role: string): boolean => role === 'backend' || role === 'frontend';
/** task 的 writes 显式包含 rules/**（S0 的 architect）时，rules/** 对它不算受保护路径；backend、frontend 另加 ARCH_OWNED_PATHS */
export function isProtectedFor(rel: string, writes: readonly string[], role = ''): boolean {
  if (archOwnedProtected(role) && matchesAny(rel, ARCH_OWNED_PATHS)) return true;
  return isProtected(rel) && !(writes.includes('rules/**') && matchesAny(rel, ['rules/**']));
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
