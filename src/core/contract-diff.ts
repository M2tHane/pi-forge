// 契约只能追加的结构化检查（规格第 12.1、12.2 节）。contractDiff 是纯函数；contractViolationsAt 只负责从 git 与 worktree 读两版。
//
// 判定要点：
// - 逐路径比较新旧两版：旧版有的键必须还在且值相同；新版新增的键只在"集合"里允许
//   （路径表、operation 方法、responses、properties、components 里的 schema、错误码表、tables、columns）。
// - 任何数组（含 required、enum）都必须与旧版完全相同；已有节点上新增 required/enum 也算修改。
//   因为 required 不能改，所以新增的 properties 只可能是可选字段；请求与响应用同一条规则，
//   components/ 里无法区分请求还是响应的 schema 也一样：新增必填字段 = 改 required = 违规，新增可选字段 = 追加。
// - 新增列是否"非空"：列定义是映射且（nullable: true 或带 default 键）才算可空/有默认；其余（含 pk、简写字符串、nullable: false 且无 default）都算非空，不允许。
// - 错误码已有条目只比较 http 与 message，其他键（如 req）不检查。
// - modules/*.md 按 `## 名称` 切分：开头（第一个 ## 之前）与每个旧小节必须不变，可以新增小节。
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONTRACTS_DIR, HTTP_METHODS, contractFilesAt, contractFilesInDir } from './contract-check.ts';
import type { ContractFiles } from './contract-check.ts';

export interface ContractViolation { file: string; path: string; message: string }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (isMap(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const join = (segs: string[], k?: string) => [...segs, ...(k === undefined ? [] : [k])].join('.');
const COLLECTION_KEYS = new Set(['responses', 'properties', 'content', 'schemas']);

/** 文件归属：paths/components/errors/modules 下的 <模块>.ext；其他文件返回 null */
function ownerOf(rel: string): { dir: string; module: string } | null {
  const m = rel.match(/^(paths|components|errors|modules)\/([^/]+)\.(?:ya?ml|md)$/);
  return m ? { dir: m[1]!, module: m[2]! } : null;
}

/** 新增列是否可空或有默认值：必须是映射，且 nullable: true 或有 default 键 */
export function isNullableColumn(def: unknown): boolean {
  if (!isMap(def)) return false;
  return def['nullable'] === true || 'default' in def;
}

function addAllowed(file: string, segs: string[], k: string, value: unknown): string | null {
  const last = segs[segs.length - 1];
  const prev = segs[segs.length - 2];
  if (Array.isArray(value) && (k === 'required' || k === 'enum') && last !== 'properties') return `不得新增 ${k}（required、enum 的任何改动都算修改）`;
  if (file === 'data-model.yaml') {
    if (segs.length === 1 && last === 'tables') return null;
    if (segs.length === 3 && segs[0] === 'tables' && last === 'columns') {
      return isNullableColumn(value) ? null : `新增列 ${k} 必须可空（nullable: true）或带 default`;
    }
  } else if (file.startsWith('paths/')) {
    if (segs.length === 0) return null;
    if (segs.length === 1) return (HTTP_METHODS as readonly string[]).includes(k) ? null : `path item 下只能新增 operation（get、post……），不能新增 ${k}`;
    if (segs.length === 2 && k === 'responses') return null;
  } else if (file.startsWith('components/') || file.startsWith('errors/')) {
    if (segs.length === 0) return null;
  }
  if (last && COLLECTION_KEYS.has(last) && prev !== 'properties') return null;
  return `不得给已有内容新增 ${k}（属于修改）`;
}

function diffNode(file: string, o: unknown, n: unknown, segs: string[], out: ContractViolation[]): void {
  if (same(o, n)) return;
  const at = `${CONTRACTS_DIR}/${file}`;
  const push = (p: string, message: string) => out.push({ file: at, path: p, message });
  if (isMap(o) && isMap(n)) {
    // 已有错误码只比较 http 与 message
    const errorEntry = file.startsWith('errors/') && segs.length === 1;
    for (const k of Object.keys(o)) {
      if (errorEntry && k !== 'http' && k !== 'message') continue;
      if (!(k in n)) { push(join(segs, k), `不得删除或改名已有内容 ${k}`); continue; }
      diffNode(file, o[k], n[k], [...segs, k], out);
    }
    if (errorEntry) return;
    for (const k of Object.keys(n)) {
      if (k in o) continue;
      const bad = addAllowed(file, segs, k, n[k]);
      if (bad) push(join(segs, k), bad);
    }
    return;
  }
  const p = join(segs);
  const last = segs[segs.length - 1];
  if (Array.isArray(o) || Array.isArray(n)) {
    push(p, last === 'required' || last === 'enum' ? `不得改动 ${last}` : '不得改动已有数组');
  } else push(p, `不得修改已有值（${JSON.stringify(o)} → ${JSON.stringify(n)}）`);
}

/** 根文件：paths 下只能新增指向本模块 paths 文件的 $ref；其他顶层键（含 components）任何改动都算修改 */
function diffRoot(o: unknown, n: unknown, module: string | undefined, out: ContractViolation[]): void {
  const file = `${CONTRACTS_DIR}/openapi.yaml`;
  if (!isMap(o) || !isMap(n)) { if (!same(o, n)) out.push({ file, path: '', message: '根文件结构被改动' }); return; }
  for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
    if (k !== 'paths') {
      if (!same(o[k], n[k])) out.push({ file, path: k, message: k === 'components' ? '根文件的 components 任何改动都算修改（公共 schema 由 architect 定，模块自己的写进 components/<模块>.yaml）' : `根文件的 ${k} 不得改动` });
      continue;
    }
    const op = isMap(o[k]) ? o[k] : {};
    const np = isMap(n[k]) ? n[k] : {};
    for (const route of Object.keys(op)) {
      if (!(route in np)) out.push({ file, path: `paths.${route}`, message: '不得删除或改名已有路径' });
      else if (!same(op[route], np[route])) out.push({ file, path: `paths.${route}`, message: '不得修改已有路径的引用' });
    }
    const refRe = module === undefined ? /^\.\/paths\/[^/#]+\.ya?ml#\/.*$/ : new RegExp(`^\\./paths/${module.replace(/[^\w-]/g, '\\$&')}\\.ya?ml#/.*$`);
    for (const route of Object.keys(np)) {
      if (route in op) continue;
      const v = np[route];
      const ref = isMap(v) && Object.keys(v).length === 1 ? v['$ref'] : undefined;
      if (typeof ref !== 'string' || !refRe.test(ref)) {
        out.push({ file, path: `paths.${route}`, message: module === undefined ? '根文件 paths 下新增的键只能是 $ref: ./paths/<模块>.yaml#/...' : `根文件 paths 下新增的键只能是 $ref: './paths/${module}.yaml#/...'（指向本模块）` });
      }
    }
  }
}

function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = md.split(/^## +/m);
  out.set('', parts[0]!.trim());
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const name = (nl < 0 ? part : part.slice(0, nl)).trim();
    out.set(name, (nl < 0 ? '' : part.slice(nl + 1)).trim());
  }
  return out;
}

function diffModuleMd(rel: string, o: string, n: string, out: ContractViolation[]): void {
  const file = `${CONTRACTS_DIR}/${rel}`;
  const os = sections(o);
  const ns = sections(n);
  for (const [name, body] of os) {
    const where = name ? `## ${name}` : '(开头)';
    if (!ns.has(name)) out.push({ file, path: where, message: name ? `不得删除或改名已有小节「${name}」` : '文件开头（第一个 ## 之前）不得改动' });
    else if (ns.get(name) !== body) out.push({ file, path: where, message: name ? `不得修改已有小节「${name}」的内容` : '文件开头（第一个 ## 之前）不得改动' });
  }
}

/** 比较两版契约，返回违规列表（空表示全部是合法追加）。只比较改动过的文件。module 为空时不检查文件归属。 */
export function contractDiff(oldFiles: ContractFiles, newFiles: ContractFiles, module: string | undefined): ContractViolation[] {
  const out: ContractViolation[] = [];
  const changed = [...new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])].filter((f) => oldFiles[f] !== newFiles[f]).sort();
  for (const rel of changed) {
    const file = `${CONTRACTS_DIR}/${rel}`;
    const owner = ownerOf(rel);
    if (module !== undefined && owner && owner.module !== module) {
      out.push({ file, path: '', message: `只能改本 task 的 module（${module}）对应的文件；要改 ${owner.module} 模块的契约请走变更请求` });
      continue;
    }
    const oldText = oldFiles[rel];
    const newText = newFiles[rel];
    if (newText === undefined) { out.push({ file, path: '', message: '不得删除已有契约文件' }); continue; }
    if (oldText === undefined) {
      // 新文件：本模块的文件、data-model.yaml 整体视为追加；根文件与未知文件不能新建
      if (owner || rel === 'data-model.yaml') continue;
      out.push({ file, path: '', message: '不得新建此契约文件' });
      continue;
    }
    if (rel.endsWith('.md')) {
      if (owner?.dir === 'modules') diffModuleMd(rel, oldText, newText, out);
      else out.push({ file, path: '', message: '不得改动此文件' });
      continue;
    }
    if (!/\.ya?ml$/.test(rel)) { out.push({ file, path: '', message: '不得改动此文件' }); continue; }
    let o: unknown;
    let n: unknown;
    try { o = parseYaml(oldText) ?? {}; } catch (e) { out.push({ file, path: '', message: `基线版本不是合法的 YAML：${(e as Error).message.split('\n')[0]}` }); continue; }
    try { n = parseYaml(newText) ?? {}; } catch (e) { out.push({ file, path: '', message: `不是合法的 YAML：${(e as Error).message.split('\n')[0]}` }); continue; }
    if (rel === 'openapi.yaml') diffRoot(o, n, module, out);
    else if (owner || rel === 'data-model.yaml') diffNode(rel, o, n, [], out);
    else out.push({ file, path: '', message: '不得改动此文件' });
  }
  return out;
}

/** 基准 ref 的契约 对比 worktree（headDir）里的契约 */
export function contractViolationsAt(root: string, baseRef: string, headDir: string, module: string | undefined): ContractViolation[] {
  return contractDiff(contractFilesAt(root, baseRef), contractFilesInDir(path.join(headDir, 'docs/contracts')), module);
}
