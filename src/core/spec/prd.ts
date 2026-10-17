// docs/PRD.md 的轻量解析与检查：需求编号 REQ-xxx、验收标准 - ACn、页面表。PRD 由用户在流程外写好，是需求的唯一依据，
// 程序只读出编号与对照关系（覆盖率、审查材料、阶段验收要用），检查结果只警告、不拦流程。解析与检查是纯函数。
import path from 'node:path';
import { git, gitOk } from '../state/git.ts';

export const PRD_PATH = 'docs/PRD.md';
export const PROTOTYPE_DIR = 'docs/prototype';

export interface PrdAc { id: string; text: string; line: number }
export interface PrdReq { id: string; title: string; line: number; acs: PrdAc[] }
/** 页面表的一行：页面名、原型文件（相对仓库根）、对应需求 */
export interface PrdPage { name: string; file: string; reqs: string[]; line: number }
export interface Prd { reqs: PrdReq[]; pages: PrdPage[] }

const REQ_ID = /REQ-\d{3,}/;
const AC_LINE = /^[-*+]\s+(AC\d+)(?![\w])\s*[:：.、]?\s*(.*)$/i;
const splitLines = (md: string): string[] => md.replace(/\r\n?/g, '\n').split('\n');

function cells(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith('|') && !t.includes(' | ')) return null;
  const parts = t.split(/(?<!\\)\|/);
  if (!parts[0]?.trim()) parts.shift();
  if (!parts.at(-1)?.trim()) parts.pop();
  return parts.map((p) => p.trim().replace(/\\\|/g, '|'));
}
const isSeparator = (row: readonly string[]) => row.every((c) => /^:?-{2,}:?$/.test(c));

/** 原型文件格里的路径：去掉反引号与 Markdown 链接，只写文件名时放在 docs/prototype/ 下 */
export function prototypePath(cell: string): string {
  const link = /\]\(([^)]+)\)/.exec(cell);
  const raw = (link ? link[1]! : cell).replace(/`/g, '').trim().replace(/^\.\//, '');
  if (!raw) return '';
  return raw.includes('/') ? raw : `${PROTOTYPE_DIR}/${raw}`;
}

export function parsePrd(md: string): Prd {
  const reqs: PrdReq[] = [];
  const pages: PrdPage[] = [];
  let current: { req: PrdReq; level: number } | null = null;
  let table: { page: number; file: number; reqs: number } | null = null;
  let fenced = false;
  splitLines(md).forEach((raw, i) => {
    const line = i + 1;
    const text = raw.trim();
    if (/^(```|~~~)/.test(text)) { fenced = !fenced; return; }
    if (fenced) return;
    const row = cells(text);
    if (!row) table = null;
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      const id = REQ_ID.exec(heading[2]!)?.[0];
      if (id) {
        const title = heading[2]!.replace(id, '').replace(/\s+/g, ' ').replace(/^[\s:：\-—|]+|[\s:：\-—|]+$/g, '').trim();
        const req: PrdReq = { id, title, line, acs: [] };
        reqs.push(req);
        current = { req, level };
      } else if (current && level <= current.level) current = null;
      return;
    }
    if (row) {
      if (table) {
        if (isSeparator(row)) return;
        const name = row[table.page] ?? '';
        const file = prototypePath(row[table.file] ?? '');
        const reqCell = table.reqs >= 0 ? row[table.reqs] ?? '' : row.join(' ');
        if (name || file) pages.push({ name, file, reqs: [...reqCell.matchAll(/REQ-\d{3,}/g)].map((m) => m[0]), line });
        return;
      }
      const page = row.findIndex((c) => c === '页面');
      const file = row.findIndex((c) => c.includes('原型'));
      if (page >= 0 && file >= 0) { table = { page, file, reqs: row.findIndex((c) => c.includes('需求')) }; return; }
    }
    const ac = AC_LINE.exec(text);
    if (ac && current) current.req.acs.push({ id: ac[1]!.toUpperCase(), text: ac[2]!.trim(), line });
  });
  return { reqs, pages };
}

/**
 * 检查（只警告）：解析不出任何 REQ、某条 REQ 没有 AC、页面表引用的原型文件不存在、同一个编号出现两次。
 * exists 判断仓库里的文件是否存在（路径相对仓库根）。
 */
export function checkPrd(prd: Prd, exists: (rel: string) => boolean): string[] {
  const out: string[] = [];
  if (!prd.reqs.length) out.push(`${PRD_PATH} 里没有解析出任何需求：需求标题里要带编号，例如「### 6.3 商品  REQ-003」`);
  const seen = new Map<string, number>();
  for (const r of prd.reqs) {
    const first = seen.get(r.id);
    if (first !== undefined) out.push(`${r.id} 出现了两次（第 ${first} 行与第 ${r.line} 行）`);
    else seen.set(r.id, r.line);
    if (!r.acs.length) out.push(`${r.id}「${r.title}」没有验收标准：在需求下面每条一行，以「- AC1」开头`);
    const acs = new Set<string>();
    for (const a of r.acs) {
      if (acs.has(a.id)) out.push(`${r.id}.${a.id} 出现了两次（第 ${a.line} 行）`);
      acs.add(a.id);
    }
  }
  for (const p of prd.pages) {
    if (!p.file) out.push(`页面表第 ${p.line} 行「${p.name}」没有写原型文件`);
    else if (!exists(p.file)) out.push(`页面「${p.name}」的原型文件 ${p.file} 不存在`);
  }
  return out;
}

/** 全部 AC：`REQ-003.AC1` → 原文 */
export function acMap(prd: Prd): Map<string, string> {
  return new Map(prd.reqs.flatMap((r) => r.acs.map((a) => [`${r.id}.${a.id}`, a.text] as const)));
}

/** 给出的 AC 编号中能在 PRD 里找到的原文；找不到的不返回 */
export function acTexts(prd: Prd, ids: readonly string[]): Record<string, string> {
  const all = acMap(prd);
  return Object.fromEntries(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!]));
}

/** 计划里的页面 id 对应的页面表行：页面名相同，或原型文件名（不含扩展名）相同 */
export function pageOf(prd: Prd, id: string): PrdPage | undefined {
  return prd.pages.find((p) => p.name === id) ?? prd.pages.find((p) => p.file && path.posix.basename(p.file).replace(/\.[^.]+$/, '') === id);
}

/** 「通用约定」一节（不含标题，到下一个二级标题为止）；没有这一节时为空 */
export function conventionsSection(md: string): string {
  const lines = splitLines(md);
  const start = lines.findIndex((l) => /^##\s*(?:[\d.、]+\s*)?通用约定\s*$/.test(l.trim()));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##?\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** 读某个提交或分支上的 PRD 原文；没有时为 null */
export function readPrdText(root: string, ref: string): string | null {
  const obj = `${ref}:${PRD_PATH}`;
  return gitOk(root, ['cat-file', '-e', obj]) ? git(root, ['show', obj]) : null;
}

/** 某个提交或分支上的 PRD；没有时为空（没有需求、没有页面） */
export function readPrd(root: string, ref: string): Prd {
  const text = readPrdText(root, ref);
  return text === null ? { reqs: [], pages: [] } : parsePrd(text);
}

/** 某个提交或分支上的 PRD 检查（只警告）：原型文件在同一个提交里找 */
export function prdWarningsAt(root: string, ref: string): string[] {
  const text = readPrdText(root, ref);
  if (text === null) return [`${ref} 上没有 ${PRD_PATH}`];
  return checkPrd(parsePrd(text), (rel) => gitOk(root, ['cat-file', '-e', `${ref}:${rel}`]));
}
