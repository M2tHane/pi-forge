// 来源：pi-flow src/core/intake.ts @ 31f3f15（改编）
// 将 PRD 与原型原件提交到集成分支，返回文件清单；不解析或生成输入内容。
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StateStore } from './state-store.ts';
import { git } from './git.ts';
import { isSensitive, normalizeRelPath } from './paths.ts';
import { IMAGE_MIME_TYPES } from './forge-read.ts';
import { isUtf8 } from 'node:buffer';

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
export interface IntakeInput { prd: string; prototype?: string }
export interface IntakeFile { path: string; size: number; type: string }
export interface IntakeResult { prd: string; prototype?: string; files: IntakeFile[] }
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
  const prd = collect(input.prd, 'PRD', 'docs/spec/inputs/prd');
  const prototype = input.prototype === undefined ? undefined : collect(input.prototype, '原型', 'docs/spec/inputs/prototype');
  return { prd, ...(prototype !== undefined ? { prototype } : {}), files, contents };
}

/** 独立索引提交不改变主工作区或主索引，重复接收相同内容不产生新提交。 */
export async function importInputs(root: string, store: StateStore, flowId: string, input: IntakeInput, prepared?: PreparedIntake): Promise<IntakeResult> {
  const flow = store.readFlow(flowId);
  if (flow.mode === 'fix') throw new IntakeError('修复流程不接收 PRD。');
  const result = prepared ?? prepareInputs(root, input);
  commitFilesToBranch(root, flow.integration_branch, result.contents, `pi-forge: ${flowId} 接收 PRD${result.prototype ? '与原型' : ''}原件`);
  const intake = { prd: result.prd, ...(result.prototype !== undefined ? { prototype_path: result.prototype } : {}), files: result.files };
  if (JSON.stringify(flow.intake) !== JSON.stringify(intake)) await store.setIntake(flowId, intake, 'human', `接收 PRD 与原型原件，共 ${result.files.length} 个文件`);
  return { prd: result.prd, ...(result.prototype !== undefined ? { prototype: result.prototype } : {}), files: result.files };
}
