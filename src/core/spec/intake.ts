// 把用户写好的 docs/PRD.md 与 docs/prototype/ 提交到集成分支，返回文件清单；不解析或改写内容。
// 两者在主工作区里有未提交的改动时也以主工作区为准：只提交这两个路径，不碰主工作区里的其他改动。
import { lstatSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StateStore } from '../state/state-store.ts';
import { isLightFlow } from '../state/schemas.ts';
import { git } from '../state/git.ts';
import { isSensitive } from '../state/paths.ts';
import { IMAGE_MIME_TYPES } from '../workspace/forge-read.ts';
import { isUtf8 } from 'node:buffer';
import { PRD_PATH, PROTOTYPE_DIR } from './prd.ts';

// 独立索引提交原语。
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
export interface IntakeFile { path: string; size: number; type: string }
export interface PreparedIntake { files: IntakeFile[]; contents: { rel: string; content: Buffer; mode: '100644' | '100755' }[] }
const MAX_FILES = 500;
const MAX_BYTES = 30 * 1024 * 1024;

/** 读出 docs/PRD.md 与 docs/prototype/ 下的全部文件（路径不变）；符号链接、敏感文件与超量输入直接报错 */
export function prepareInputs(root: string): PreparedIntake {
  const files: IntakeFile[] = [];
  const contents: PreparedIntake['contents'] = [];
  let bytes = 0;
  const visit = (rel: string): void => {
    const abs = path.join(root, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new IntakeError(`输入不能包含符号链接：${rel}。`);
    if (isSensitive(rel.toLowerCase())) throw new IntakeError(`禁止提交敏感文件：${rel}。`);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) if (name !== '.DS_Store') visit(`${rel}/${name}`);
      return;
    }
    if (!st.isFile()) throw new IntakeError(`输入必须是普通文件或目录：${rel}。`);
    if (files.length >= MAX_FILES) throw new IntakeError(`输入超过 ${MAX_FILES} 个文件；请精简原型目录。`);
    bytes += st.size;
    if (bytes > MAX_BYTES) throw new IntakeError(`输入超过 ${MAX_BYTES / 1048576} MiB。`);
    const content = readFileSync(abs);
    const type = IMAGE_MIME_TYPES[path.extname(rel).toLowerCase()] ?? (isUtf8(content) && !content.includes(0) ? 'text' : 'binary');
    contents.push({ rel, content, mode: st.mode & 0o111 ? '100755' : '100644' });
    files.push({ path: rel, size: content.length, type });
  };
  visit(PRD_PATH);
  visit(PROTOTYPE_DIR);
  return { files, contents };
}

/** 独立索引提交：不改变主工作区或主索引，重复接收相同内容不产生新提交 */
export async function importInputs(root: string, store: StateStore, flowId: string, prepared: PreparedIntake = prepareInputs(root)): Promise<IntakeFile[]> {
  const flow = store.readFlow(flowId);
  if (isLightFlow(flow)) throw new IntakeError('修复与小改动流程不接收 PRD。');
  commitFilesToBranch(root, flow.integration_branch, prepared.contents, `pi-forge: ${flowId} 接收 PRD 与原型`);
  const intake = { prd: PRD_PATH, prototype_path: PROTOTYPE_DIR, files: prepared.files };
  if (JSON.stringify(flow.intake) !== JSON.stringify(intake)) await store.setIntake(flowId, intake, 'human', `接收 PRD 与原型，共 ${prepared.files.length} 个文件`);
  return prepared.files;
}
