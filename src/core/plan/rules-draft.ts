// 规则草案：知识提升（/forge knowledge promote）在 docs/rules-draft/ 写草案，用户确认后由程序写入主工作区的 rules/ 并提交。
// 项目命令不再走草案：architect 直接写仓库根目录的 commands.yaml，随代码合并（见 state/project-commands.ts）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { git, gitOk } from '../state/git.ts';

export const DRAFT_DIR = 'docs/rules-draft';

export interface Draft {
  kind: 'rule';
  /** 草案路径（相对仓库根） */
  file: string;
  /** 写入目标 */
  target: string;
  content: string;
  /** 目标当前内容（新文件为 null） */
  current: string | null;
  /** 变更摘要 */
  summary: string;
}

function lineDiff(cur: string | null, next: string): string {
  if (cur === null) return `新文件，${next.trim().split('\n').length} 行`;
  const a = new Set(cur.split('\n').map((l) => l.trim()).filter(Boolean));
  const b = new Set(next.split('\n').map((l) => l.trim()).filter(Boolean));
  const add = [...b].filter((l) => !a.has(l)).length;
  const del = [...a].filter((l) => !b.has(l)).length;
  return add || del ? `+${add} 行，-${del} 行` : '与现有内容相同';
}

/** 列出某个 git 引用（通常是集成分支）上的草案，并与主工作区现状比较 */
export function listDrafts(root: string, ref: string): Draft[] {
  if (!gitOk(root, ['rev-parse', '--verify', '-q', ref])) return [];
  const files = git(root, ['ls-tree', '-r', '--name-only', ref, '--', DRAFT_DIR]).split('\n').filter(Boolean).sort();
  const out: Draft[] = [];
  for (const file of files) {
    const content = git(root, ['show', `${ref}:${file}`]);
    const base = path.posix.basename(file);
    if (base.endsWith('.md')) {
      const target = `rules/${base}`;
      const abs = path.join(root, target);
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      out.push({ kind: 'rule', file, target, content, current, summary: lineDiff(current, content) });
    }
  }
  return out.filter((d) => !/相同$/.test(d.summary));
}

/** 写入选中的规则草案并提交 */
export function applyDrafts(root: string, drafts: Draft[], flowId: string): { applied: string[] } {
  if (!drafts.length) return { applied: [] };
  const touched: string[] = [];
  for (const d of drafts) {
    if (d.content.split('\n').length > 120) throw new Error(`${d.file} 超过 120 行；规则越长遵守越差，请在规划时精简`);
    mkdirSync(path.join(root, 'rules'), { recursive: true });
    writeFileSync(path.join(root, d.target), d.content.endsWith('\n') ? d.content : `${d.content}\n`);
    touched.push(d.target);
  }
  git(root, ['add', '--', ...touched]);
  if (!gitOk(root, ['diff', '--cached', '--quiet', '--', ...touched])) {
    git(root, ['commit', '-q', '--no-verify', '-m', `pi-forge: 应用 ${flowId} 的规则草案`, '--', ...touched], { engineIdentity: true });
  }
  return { applied: touched };
}

export function formatDrafts(drafts: Draft[]): string {
  return drafts.map((d) => `- ${d.file} → ${d.target}：${d.summary}`).join('\n');
}
