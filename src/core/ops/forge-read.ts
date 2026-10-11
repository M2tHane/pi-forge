// 从仓库分支读取产物，不访问工作区，也不依赖 Pi。
import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { git, gitOk } from '../state/git.ts';
import { isSensitive, normalizeRelPath } from '../state/paths.ts';
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';

// 已核实 Pi dist/core/tools/truncate.js 的默认值；业务层不导入 Pi。
export const FORGE_READ_MAX_LINES = 2000;
export const FORGE_READ_MAX_BYTES = 50 * 1024;
export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

export interface ForgeReadInput { path: string; ref?: string; offset?: number; limit?: number }
export interface ForgeReadContext {
  store: Pick<StateStore, 'readState' | 'readFlow'>;
  config: Pick<FlowConfig, 'raw'>;
}
export type ForgeReadResult =
  | { kind: 'text' | 'directory' | 'binary'; ref: string; path: string; text: string; nextOffset?: number }
  | { kind: 'image'; ref: string; path: string; mimeType: string; data: string };
export class ForgeReadError extends Error {}

function readablePath(rel: string): boolean {
  const lower = rel.toLowerCase();
  return !lower.split('/').some((part) => part === '.forge' || part === '.git') && !isSensitive(lower) && !isSensitive(`${lower}/`);
}

function listDirectory(root: string, ref: string, rel: string): string[] {
  const object = rel === '.' ? ref : `${ref}:${rel}`;
  return git(root, ['ls-tree', '-z', object]).split('\0').filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    const [, type] = entry.slice(0, tab).split(' ');
    const name = entry.slice(tab + 1);
    const child = rel === '.' ? name : `${rel}/${name}`;
    return readablePath(child) ? [`${name}${type === 'tree' ? '/' : ''}`] : [];
  });
}

function missingPath(root: string, ref: string, rel: string): never {
  let parent = path.posix.dirname(rel);
  // 上一级本身不存在时，找到最近的可读目录，仍给出可用提示。
  while (parent !== '.' && !gitOk(root, ['cat-file', '-e', `${ref}:${parent}`])) parent = path.posix.dirname(parent);
  const object = parent === '.' ? ref : `${ref}:${parent}`;
  const entries = parent === '.' || git(root, ['cat-file', '-t', object]).trim() === 'tree' ? listDirectory(root, ref, parent) : [];
  throw new ForgeReadError(`路径不存在：${rel}（分支 ${ref.replace(/^refs\/heads\//, '')}）。\n上级目录 ${parent}：\n${entries.join('\n') || '（没有可显示的内容）'}`);
}

/** ref 只接受存在的主分支或流程分支，绝不接受任意 revision。 */
export function forgeRead(root: string, input: ForgeReadInput, ctx: ForgeReadContext): ForgeReadResult {
  const active = ctx.store.readState().active_flow;
  const ref = input.ref ?? (active ? ctx.store.readFlow(active).integration_branch : ctx.config.raw.main_branch);
  if (ref.startsWith('refs/') || ref === 'HEAD' || /^[a-f\d]{4,64}$/i.test(ref)
      || (ref !== ctx.config.raw.main_branch && !/^flow\/[^/]+\/[^/]+$/.test(ref))
      || !gitOk(root, ['check-ref-format', '--branch', ref])) {
    throw new ForgeReadError(`不允许读取 ref ${ref}：只接受主分支或 flow/<流程>/<integration 或任务>，不接受状态引用、SHA 或任意 revision。`);
  }
  const fullRef = `refs/heads/${ref}`;
  if (!gitOk(root, ['show-ref', '--verify', '--quiet', fullRef])) throw new ForgeReadError(`分支不存在：${ref}。`);
  if (!input.path || input.path.includes('\0')) throw new ForgeReadError('path 必须是仓库内的文件或目录路径。');
  const rel = normalizeRelPath(root, input.path);
  if (rel === null) throw new ForgeReadError(`路径不能越出仓库：${input.path}。`);
  if (!readablePath(rel)) throw new ForgeReadError(`禁止读取状态目录或敏感文件：${rel}。`);
  for (const name of ['offset', 'limit'] as const) {
    const value = input[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new ForgeReadError(`${name} 必须是从 1 开始的正整数。`);
  }
  const object = rel === '.' ? fullRef : `${fullRef}:${rel}`;
  if (!gitOk(root, ['cat-file', '-e', object])) missingPath(root, fullRef, rel);
  const type = git(root, ['cat-file', '-t', object]).trim();
  if (type === 'tree' || rel === '.') {
    return { kind: 'directory', ref, path: rel, text: listDirectory(root, fullRef, rel).join('\n') || '（空目录）' };
  }
  if (type !== 'blob') throw new ForgeReadError(`路径不是可读取的文件或目录：${rel}。`);
  const buffer = execFileSync('git', ['show', object], {
    cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mimeType = IMAGE_MIME_TYPES[path.posix.extname(rel).toLowerCase()];
  if (mimeType) return { kind: 'image', ref, path: rel, mimeType, data: buffer.toString('base64') };
  if (!isUtf8(buffer) || /[\x00-\x08\x0b\x0e-\x1f]/.test(buffer.toString('utf8'))) {
    return { kind: 'binary', ref, path: rel, text: '二进制文件，无法显示' };
  }
  const lines = buffer.toString('utf8').split('\n');
  const offset = input.offset ?? 1;
  if (offset > lines.length) throw new ForgeReadError(`offset=${offset} 超出文件末尾（共 ${lines.length} 行）。`);
  const end = Math.min(lines.length, offset - 1 + Math.min(input.limit ?? FORGE_READ_MAX_LINES, FORGE_READ_MAX_LINES));
  const selected: string[] = [];
  let bytes = 0;
  for (let i = offset - 1; i < end; i++) {
    const line = lines[i]!;
    const size = Buffer.byteLength(line, 'utf8') + (selected.length ? 1 : 0);
    if (bytes + size > FORGE_READ_MAX_BYTES) break;
    selected.push(line);
    bytes += size;
  }
  if (!selected.length) {
    return { kind: 'text', ref, path: rel, text: `第 ${offset} 行超过 50 KiB 上限，无法按完整行显示；请将原件拆分为较短的行后重新入库。` };
  }
  const nextOffset = offset + selected.length;
  const more = nextOffset <= lines.length;
  return {
    kind: 'text', ref, path: rel,
    text: selected.join('\n') + (more ? `\n\n[已显示第 ${offset}–${nextOffset - 1} 行，共 ${lines.length} 行；使用 offset=${nextOffset} 继续。]` : ''),
    ...(more ? { nextOffset } : {}),
  };
}
