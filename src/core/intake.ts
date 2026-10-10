// 来源：pi-flow src/core/intake.ts @ 31f3f15（改编）
// 将需求文档与原型原件提交到集成分支，返回文件清单；不解析或生成输入内容。
// 来源有两种：/forge-build --prd/--prototype 指定的路径；不指定时扫描项目 docs/ 下用户放的文档（偏离第 71 条）。
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StateStore } from './state-store.ts';
import { git } from './git.ts';
import { isSensitive, normalizeRelPath } from './paths.ts';
import { IMAGE_MIME_TYPES } from './forge-read.ts';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

// 来源：pi-flow src/core/requirements.ts @ 31f3f15；独立索引提交原语。
export function commitFilesToBranch(root: string, branch: string, files: readonly { rel: string; content: string | Buffer; mode?: '100644' | '100755' }[], message: string): string | null {
  const ref = `refs/heads/${branch}`;
  const parent = git(root, ['rev-parse', ref]).trim();
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-intake-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    git(root, ['read-tree', parent], { env });
    let changed = false;
    files.forEach((f, i) => {
      const file = path.join(dir, `content-${i}`);
      writeFileSync(file, f.content);
      // 原件不经过 .gitattributes 的换行或 clean 过滤器。
      const blob = git(root, ['hash-object', '-w', '--no-filters', file]).trim();
      const mode = f.mode ?? '100644';
      const old = git(root, ['ls-tree', parent, '--', `:(literal)${f.rel}`]).trim();
      if (old.startsWith(`${mode} blob ${blob}\t`)) return;
      changed = true;
      git(root, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${f.rel}`], { env });
    });
    if (!changed) return null;
    const tree = git(root, ['write-tree'], { env }).trim();
    const sha = git(root, ['commit-tree', tree, '-p', parent, '-m', message], { engineIdentity: true }).trim();
    git(root, ['update-ref', ref, sha, parent]);
    return sha;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export class IntakeError extends Error {}
/** prd、prototype 是用户指定的路径；都不给时 docs 为 true，扫描项目 docs/ */
export interface IntakeInput { prd?: string; prototype?: string; docs?: { ingested: ReadonlySet<string> } }
export interface IntakeFile { path: string; size: number; type: string }
/** prd：需求文档在集成分支上的位置（文件或目录）；没有任何需求文档时为 undefined */
export interface IntakeResult { prd?: string; prototype?: string; files: IntakeFile[]; skipped?: string[] }
interface InputFile { rel: string; content: Buffer; mode: '100644' | '100755' }
export interface PreparedIntake extends IntakeResult { contents: InputFile[] }
const MAX_FILES = 500;
const MAX_BYTES = 30 * 1024 * 1024;

/** 在创建流程前完成输入检查，目录内相对路径保持不变。 */
export function prepareInputs(root: string, input: IntakeInput): PreparedIntake {
  const contents: InputFile[] = [];
  const files: IntakeFile[] = [];
  let bytes = 0;
  const collect = (source: string, label: string, destination: string): string => {
    const requested = path.resolve(root, source);
    if (!existsSync(requested)) throw new IntakeError(`找不到${label} ${source}。`);
    if (lstatSync(requested).isSymbolicLink()) throw new IntakeError(`输入不能包含符号链接：${requested}。`);
    const abs = realpathSync(requested);
    const visit = (file: string, rel: string): void => {
      const local = normalizeRelPath(root, file);
      if ([rel, local ?? '', file].some((p) => p.toLowerCase().split('/').some((part) => part === '.git' || part === '.forge')
          || isSensitive(p.toLowerCase()) || isSensitive(`${p.toLowerCase()}/`))) {
        throw new IntakeError(`禁止接收状态目录或敏感文件：${file}。`);
      }
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new IntakeError(`输入不能包含符号链接：${file}。`);
      if (stat.isDirectory()) {
        for (const name of readdirSync(file).sort()) visit(path.join(file, name), rel ? `${rel}/${name}` : name);
        return;
      }
      if (!stat.isFile()) throw new IntakeError(`输入必须是普通文件或目录：${file}。`);
      if (files.length >= MAX_FILES) throw new IntakeError(`输入超过 ${MAX_FILES} 个文件；请缩小 PRD 或原型目录。`);
      bytes += stat.size;
      if (bytes > MAX_BYTES) throw new IntakeError(`输入超过 ${MAX_BYTES / 1048576} MiB。`);
      const content = readFileSync(file);
      const target = `${destination}/${rel}`;
      const type = IMAGE_MIME_TYPES[path.extname(rel).toLowerCase()] ?? (isUtf8(content) && !content.includes(0) ? 'text' : 'binary');
      contents.push({ rel: target, content, mode: stat.mode & 0o111 ? '100755' : '100644' });
      files.push({ path: target, size: content.length, type });
    };
    const isFile = lstatSync(abs).isFile();
    const before = files.length;
    visit(abs, isFile ? path.basename(abs) : '');
    if (files.length === before) throw new IntakeError(`${label} ${source} 是空目录。`);
    return isFile ? `${destination}/${path.basename(abs)}` : destination;
  };
  // macOS 的 /tmp 可能是符号链接：比较路径时先规范化根路径。
  const canonicalRoot = realpathSync(root);
  root = canonicalRoot;
  const skipped: string[] = [];
  let prd: string | undefined;
  if (input.prd !== undefined) prd = collect(input.prd, 'PRD', 'docs/spec/inputs/prd');
  else if (input.docs) {
    const before = files.length;
    for (const rel of listDocInputs(root, skipped)) {
      const content = readFileSync(path.join(root, 'docs', rel));
      if (input.docs.ingested.has(gitBlobId(content))) { skipped.push(`docs/${rel}（已在之前的流程入库）`); continue; }
      if (files.length >= MAX_FILES) throw new IntakeError(`docs/ 下的文档超过 ${MAX_FILES} 个；请只保留本次需要的需求文档。`);
      bytes += content.length;
      if (bytes > MAX_BYTES) throw new IntakeError(`docs/ 下的文档超过 ${MAX_BYTES / 1048576} MiB。`);
      const target = `${DOCS_INPUT_DEST}/${rel}`;
      const type = IMAGE_MIME_TYPES[path.extname(rel).toLowerCase()] ?? (isUtf8(content) && !content.includes(0) ? 'text' : 'binary');
      contents.push({ rel: target, content, mode: '100644' });
      files.push({ path: target, size: content.length, type });
    }
    if (files.length > before) prd = DOCS_INPUT_DEST;
  }
  const prototype = input.prototype === undefined ? undefined : collect(input.prototype, '原型', 'docs/spec/inputs/prototype');
  return { ...(prd !== undefined ? { prd } : {}), ...(prototype !== undefined ? { prototype } : {}), files, contents, ...(skipped.length ? { skipped } : {}) };
}

/** 项目 docs/ 下由 pi-forge 写入的目录：不是用户放的需求文档 */
export const MANAGED_DOC_DIRS = ['spec', 'contracts', 'arch', 'plan', 'qa', 'review', 'research', 'rules-draft'] as const;
/** docs/ 下的文档入库到集成分支的位置（保持 docs/ 内的相对路径） */
export const DOCS_INPUT_DEST = 'docs/spec/inputs/docs';

/** git 的 blob 编号（与 git hash-object --no-filters 相同），用来识别已经入库过的文档 */
export function gitBlobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/**
 * docs/ 下哪些文件算用户的需求文档（纯函数，输入是 docs/ 内的相对路径）：
 * 跳过 pi-forge 维护的目录、隐藏文件与目录、敏感文件。返回 [采用的, 跳过的及原因]。
 */
export function pickDocInputs(rels: readonly string[]): { take: string[]; skip: string[] } {
  const take: string[] = [];
  const skip: string[] = [];
  for (const rel of [...rels].sort()) {
    const parts = rel.split('/');
    if ((MANAGED_DOC_DIRS as readonly string[]).includes(parts[0]!)) continue;
    if (parts.some((x) => x.startsWith('.'))) continue;
    if (isSensitive(`docs/${rel}`.toLowerCase())) { skip.push(`docs/${rel}（敏感文件，不入库）`); continue; }
    take.push(rel);
  }
  return { take, skip };
}

/** 列出 docs/ 下的普通文件（不跟随符号链接），按 pickDocInputs 过滤；跳过的写进 skipped */
function listDocInputs(root: string, skipped: string[]): string[] {
  const docs = path.join(root, 'docs');
  if (!existsSync(docs) || !lstatSync(docs).isDirectory()) return [];
  const rels: string[] = [];
  const visit = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) { skipped.push(`docs/${r}（符号链接，不入库）`); continue; }
      if (st.isDirectory()) { if (!name.startsWith('.') && !(rel === '' && (MANAGED_DOC_DIRS as readonly string[]).includes(name))) visit(abs, r); continue; }
      if (st.isFile()) rels.push(r);
    }
  };
  visit(docs, '');
  const { take, skip } = pickDocInputs(rels);
  skipped.push(...skip);
  return take;
}

/** 已经入库过的文档（某个分支 docs/spec/inputs/ 下的 blob 编号），feature 模式用来跳过旧文档 */
export function ingestedBlobs(root: string, ref: string): Set<string> {
  try {
    return new Set(git(root, ['ls-tree', '-r', ref, '--', 'docs/spec/inputs']).split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2]!).filter(Boolean));
  } catch { return new Set(); }
}

/** 独立索引提交不改变主工作区或主索引，重复接收相同内容不产生新提交。 */
export async function importInputs(root: string, store: StateStore, flowId: string, input: IntakeInput, prepared?: PreparedIntake): Promise<IntakeResult> {
  const flow = store.readFlow(flowId);
  if (flow.mode === 'fix') throw new IntakeError('修复流程不接收 PRD。');
  const result = prepared ?? prepareInputs(root, input);
  const out = { ...(result.prd !== undefined ? { prd: result.prd } : {}), ...(result.prototype !== undefined ? { prototype: result.prototype } : {}), files: result.files, ...(result.skipped ? { skipped: result.skipped } : {}) };
  // 没有任何文档：不记 intake，主会话从访谈开始
  if (!result.contents.length) return out;
  commitFilesToBranch(root, flow.integration_branch, result.contents, `pi-forge: ${flowId} 接收需求文档${result.prototype ? '与原型' : ''}原件`);
  const intake = { ...(result.prd !== undefined ? { prd: result.prd } : {}), ...(result.prototype !== undefined ? { prototype_path: result.prototype } : {}), files: result.files };
  if (JSON.stringify(flow.intake) !== JSON.stringify(intake)) await store.setIntake(flowId, intake, 'human', `接收需求文档与原型原件，共 ${result.files.length} 个文件`);
  return out;
}
