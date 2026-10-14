// 契约的结构解析与符号目录（规格第 6、7.2、12.2 节）。parseContracts 是纯函数；contractFilesAt、contractFilesInDir 只负责读取文件。
// 追加判定与结构化三方合并在 M5 实现。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { git, gitOk } from '../state/git.ts';

export const CONTRACTS_DIR = 'docs/contracts';
export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const MODULE_NAME = /^[a-z][a-z0-9-]*$/;

/** 契约文件：键是相对 docs/contracts/ 的路径（openapi.yaml、paths/x.yaml……），值是文本 */
export type ContractFiles = Readonly<Record<string, string>>;
export interface ContractIssue { file: string; message: string }
export interface ContractSymbol { module: string | null; file: string }
export interface ContractCatalog {
  /** 键：`POST /api/x`（方法大写） */
  apis: Map<string, ContractSymbol>;
  tables: Map<string, ContractSymbol>;
  errors: Map<string, ContractSymbol & { http: number }>;
  /** 键：`<module>#<name>` */
  fns: Map<string, ContractSymbol>;
}
export interface ContractCheck { catalog: ContractCatalog; errors: ContractIssue[]; warnings: ContractIssue[] }

/** errors/<模块>.yaml 中错误码的前缀：模块名大写，短横线换成下划线 */
export const errorPrefix = (module: string) => `${module.toUpperCase().replace(/-/g, '_')}_`;

const moduleOf = (rel: string, dir: string): string | null => {
  const m = rel.match(new RegExp(`^${dir}/([^/]+)\\.(?:ya?ml|md)$`));
  return m ? m[1]! : null;
};

function decodePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer.replace(/^\//, '').split('/').map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
}

function atPointer(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const key of decodePointer(pointer)) {
    if (!cur || typeof cur !== 'object' || !(key in (cur as Record<string, unknown>))) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 解析全部契约文件，给出符号目录与结构错误。文件为空集合时报"缺少契约"。 */
export function parseContracts(all: ContractFiles): ContractCheck {
  // 空文件（含 /forge init 留下的 .gitkeep）视为不存在：architect 没有删除能力，不需要的文件清空即可
  const files: ContractFiles = Object.fromEntries(Object.entries(all).filter(([, text]) => text.trim() !== ''));
  const errors: ContractIssue[] = [];
  const warnings: ContractIssue[] = [];
  const catalog: ContractCatalog = { apis: new Map(), tables: new Map(), errors: new Map(), fns: new Map() };
  const docs = new Map<string, unknown>();
  const at = (file: string) => `${CONTRACTS_DIR}/${file}`;

  for (const [rel, text] of Object.entries(files)) {
    if (!/\.ya?ml$/.test(rel)) continue;
    try { docs.set(rel, parseYaml(text) ?? {}); } catch (e) {
      errors.push({ file: at(rel), message: `不是合法的 YAML：${(e as Error).message.split('\n')[0]}` });
    }
  }
  for (const dir of ['paths', 'components', 'errors', 'modules']) {
    for (const rel of Object.keys(files).filter((f) => f.startsWith(`${dir}/`))) {
      const m = moduleOf(rel, dir);
      if (m === null) errors.push({ file: at(rel), message: `${dir}/ 下只能放 <模块>.${dir === 'modules' ? 'md' : 'yaml'}，不能有子目录或其他文件（不需要的文件把内容清空即可，空文件视为不存在）` });
      else if (m !== 'common' && !MODULE_NAME.test(m)) errors.push({ file: at(rel), message: `模块名 ${m} 只能用小写字母、数字和短横线，并以字母开头` });
    }
  }

  // $ref：相对文件路径必须在 docs/contracts/ 内且存在，JSON pointer 必须能解析
  const resolveRef = (from: string, ref: string): { file: string; target: unknown } | string => {
    const [filePart, pointer = ''] = ref.split('#');
    const file = filePart ? path.posix.normalize(path.posix.join(path.posix.dirname(from), filePart)) : from;
    if (file.startsWith('..') || path.posix.isAbsolute(file)) return `$ref ${ref} 指向 docs/contracts/ 之外`;
    if (!(file in files)) return `$ref ${ref} 引用的文件 ${file} 不存在`;
    if (!docs.has(file)) return `$ref ${ref} 引用的文件 ${file} 无法解析`;
    const target = atPointer(docs.get(file), pointer);
    if (target === undefined) return `$ref ${ref} 在 ${file} 中找不到 ${pointer || '/'}`;
    return { file, target };
  };
  const walkRefs = (file: string, node: unknown) => {
    if (Array.isArray(node)) { node.forEach((n) => walkRefs(file, n)); return; }
    if (!isMap(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const r = resolveRef(file, v);
        if (typeof r === 'string') errors.push({ file: at(file), message: r });
      } else walkRefs(file, v);
    }
  };
  for (const [rel, doc] of docs) walkRefs(rel, doc);

  // openapi.yaml：根文件只放 info、公共 components 与 paths；paths 下每条只能是指向 paths/<模块>.yaml 的 $ref
  const root = docs.get('openapi.yaml');
  if (!('openapi.yaml' in files)) errors.push({ file: at('openapi.yaml'), message: '缺少根文件 openapi.yaml' });
  else if (root !== undefined) {
    if (!isMap(root) || typeof root['openapi'] !== 'string' || !root['openapi'].startsWith('3.')) {
      errors.push({ file: at('openapi.yaml'), message: '根文件必须写 openapi: 3.1.0（OpenAPI 3.x）' });
    }
    const paths = isMap(root) ? root['paths'] : undefined;
    if (paths !== undefined && !isMap(paths)) errors.push({ file: at('openapi.yaml'), message: 'paths 必须是映射' });
    const referenced = new Set<string>();
    for (const [route, entry] of Object.entries(isMap(paths) ? paths : {})) {
      if (!route.startsWith('/')) { errors.push({ file: at('openapi.yaml'), message: `路径 ${route} 必须以 / 开头` }); continue; }
      const ref = isMap(entry) && Object.keys(entry).length === 1 && typeof entry['$ref'] === 'string' ? entry['$ref'] : null;
      const m = ref?.match(/^\.\/paths\/([^/#]+)\.ya?ml#(\/.*)$/);
      if (!ref || !m) {
        errors.push({ file: at('openapi.yaml'), message: `paths 下的 ${route} 只能写一条 $ref: './paths/<模块>.yaml#/<路径>'（path item 写在 paths/<模块>.yaml）` });
        continue;
      }
      const resolved = resolveRef('openapi.yaml', ref);
      if (typeof resolved === 'string') continue; // 已在 walkRefs 报告
      referenced.add(`${resolved.file}#${m[2]}`);
      const item = resolved.target;
      if (!isMap(item)) { errors.push({ file: at(resolved.file), message: `${route} 的 path item 必须是映射` }); continue; }
      const ops = HTTP_METHODS.filter((op) => op in item);
      if (!ops.length) errors.push({ file: at(resolved.file), message: `${route} 没有任何 operation（get、post……）` });
      for (const op of ops) {
        const operation = item[op];
        const key = `${op.toUpperCase()} ${route}`;
        if (!isMap(operation) || !isMap(operation['responses']) || !Object.keys(operation['responses']).length) {
          errors.push({ file: at(resolved.file), message: `${key} 必须写 responses（所有可能的状态码）` });
        }
        if (isMap(operation) && typeof operation['operationId'] !== 'string') warnings.push({ file: at(resolved.file), message: `${key} 缺少 operationId` });
        catalog.apis.set(key, { module: m[1]!, file: at(resolved.file) });
      }
    }
    for (const rel of Object.keys(files).filter((f) => f.startsWith('paths/') && docs.has(f))) {
      const doc = docs.get(rel);
      for (const route of Object.keys(isMap(doc) ? doc : {})) {
        const pointer = `/${route.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (!referenced.has(`${rel}#${pointer}`)) {
          warnings.push({ file: at(rel), message: `${route} 没有在 openapi.yaml 的 paths 中引用，对外不可见` });
        }
      }
    }
  }

  // errors/<模块>.yaml：CODE: { http, message }；错误码以模块前缀开头（common.yaml 除外），全局唯一
  for (const rel of Object.keys(files).filter((f) => f.startsWith('errors/') && docs.has(f))) {
    const module = moduleOf(rel, 'errors');
    const doc = docs.get(rel);
    if (!isMap(doc)) { errors.push({ file: at(rel), message: '错误码文件必须是 CODE: { http, message } 的映射' }); continue; }
    for (const [code, def] of Object.entries(doc)) {
      if (!ERROR_CODE.test(code)) errors.push({ file: at(rel), message: `错误码 ${code} 只能用大写字母、数字和下划线` });
      if (module && module !== 'common' && !code.startsWith(errorPrefix(module))) {
        errors.push({ file: at(rel), message: `错误码 ${code} 必须以模块前缀 ${errorPrefix(module)} 开头（通用错误放 errors/common.yaml）` });
      }
      const http = isMap(def) ? def['http'] : undefined;
      if (!isMap(def) || typeof http !== 'number' || !Number.isInteger(http) || http < 100 || http > 599 || typeof def['message'] !== 'string') {
        errors.push({ file: at(rel), message: `错误码 ${code} 必须写 http（100–599 的整数）与 message` });
      }
      const prev = catalog.errors.get(code);
      if (prev) errors.push({ file: at(rel), message: `错误码 ${code} 与 ${prev.file} 重复` });
      else catalog.errors.set(code, { module, file: at(rel), http: typeof http === 'number' ? http : 0 });
    }
  }

  // data-model.yaml：tables: { 名字: { columns: { 列: {...} } } }
  if (docs.has('data-model.yaml')) {
    const tables = (docs.get('data-model.yaml') as Record<string, unknown> | null)?.['tables'];
    if (!isMap(tables)) errors.push({ file: at('data-model.yaml'), message: '必须有 tables 映射' });
    else for (const [name, def] of Object.entries(tables)) {
      if (!isMap(def) || !isMap(def['columns']) || !Object.keys(def['columns']).length) {
        errors.push({ file: at('data-model.yaml'), message: `表 ${name} 必须写 columns` });
      }
      catalog.tables.set(name, { module: null, file: at('data-model.yaml') });
    }
  }

  // modules/<m>.md：每个 ## 标题是一个跨模块函数
  for (const rel of Object.keys(files).filter((f) => f.startsWith('modules/'))) {
    const module = moduleOf(rel, 'modules');
    if (!module) continue;
    for (const line of files[rel]!.split(/\r?\n/)) {
      const m = line.match(/^##\s+(\S+)\s*$/);
      if (!m) continue;
      const key = `${module}#${m[1]}`;
      if (catalog.fns.has(key)) errors.push({ file: at(rel), message: `函数 ${m[1]} 重复定义` });
      catalog.fns.set(key, { module, file: at(rel) });
    }
  }
  return { catalog, errors, warnings };
}

/** 读取某个 git 引用上的 docs/contracts/ */
export function contractFilesAt(root: string, ref: string): Record<string, string> {
  if (!gitOk(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) return {};
  const out: Record<string, string> = {};
  for (const f of git(root, ['ls-tree', '-r', '--name-only', ref, '--', CONTRACTS_DIR]).split('\n').filter(Boolean)) {
    out[f.slice(CONTRACTS_DIR.length + 1)] = git(root, ['show', `${ref}:${f}`]);
  }
  return out;
}

/** 读取工作区（worktree）里的 docs/contracts/ */
export function contractFilesInDir(dir: string): Record<string, string> {
  const base = path.join(dir, CONTRACTS_DIR);
  const out: Record<string, string> = {};
  if (!existsSync(base)) return out;
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = path.join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(base, p).split(path.sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(base);
  return out;
}
