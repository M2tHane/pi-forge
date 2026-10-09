// 来源：pi-flow src/core/intake.ts @ 31f3f15
// 接收用户带进来的输入（第六轮）：PRD、技术架构、原型与设计规范（例如和 Claude 讨论得出的 PRD、Claude Design 的导出物）。
// 程序原样放进集成分支（不解析内容），主 agent 随后做就绪检查、写标准化的需求说明，再直接规划。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { StateStore } from './state-store.ts';
import type { FlowFile } from './schemas.ts';
import { commitFilesToBranch } from './requirements.ts';
import { git } from './git.ts';
import { slug, type FlowMode } from '../modes/plan.ts';

export class IntakeError extends Error {}

export interface IntakeInput {
  /** PRD：文件或目录（必需） */
  prd: string;
  /** 技术架构：文件或目录 */
  arch?: string;
  /** 原型与设计规范：目录或单个 html 文件 */
  design?: string;
}

export const DESIGN_DOC_NAME = 'DESIGN.md';
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '__MACOSX']);
const MAX_FILES = 500;
const MAX_BYTES = 30 * 1024 * 1024;

interface Picked { rel: string; abs: string }

/** 列出文件或目录下的所有文件（相对路径用 /） */
function walk(abs: string, label: string): Picked[] {
  if (!existsSync(abs)) throw new IntakeError(`找不到${label} ${abs}`);
  if (statSync(abs).isFile()) return [{ rel: path.basename(abs), abs }];
  const out: Picked[] = [];
  const visit = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP.has(name)) continue;
      const p = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(p).isDirectory()) visit(p, rel);
      else out.push({ rel, abs: p });
    }
  };
  visit(abs, '');
  if (!out.length) throw new IntakeError(`${label} ${abs} 是空目录`);
  return out;
}

const htmlTitle = (html: string) => /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';

/** 输入在集成分支上的位置：新项目放在固定目录，已有项目按功能分目录，不覆盖之前的 */
export function intakeLayout(mode: FlowMode, title: string) {
  const sub = mode === 'feature' ? `/${slug(title)}` : '';
  return { prd: `docs/prd${sub}`, arch: `docs/architecture${sub}`, prototype: `prototype${sub}` };
}

/**
 * 把输入原样提交到集成分支：PRD → docs/prd/、架构 → docs/architecture/、设计导出物 → prototype/（DESIGN.md 放仓库根目录），
 * 并生成原型页面清单 prototype/INDEX.md。记下 flow.intake。
 */
export async function importInputs(root: string, store: StateStore, flowId: string, input: IntakeInput): Promise<NonNullable<FlowFile['intake']>> {
  const flow = store.readFlow(flowId);
  if (flow.mode === 'fix') throw new IntakeError('修复流程不接收 PRD。');
  const at = intakeLayout(flow.mode, flow.title);
  const files: { rel: string; abs: string }[] = [];
  const prd = walk(path.resolve(root, input.prd), 'PRD');
  files.push(...prd.map((f) => ({ rel: `${at.prd}/${f.rel}`, abs: f.abs })));
  const arch = input.arch ? walk(path.resolve(root, input.arch), '技术架构') : [];
  files.push(...arch.map((f) => ({ rel: `${at.arch}/${f.rel}`, abs: f.abs })));
  let designDoc = false;
  const pages: { rel: string; title: string }[] = [];
  if (input.design) {
    for (const f of walk(path.resolve(root, input.design), '原型')) {
      if (f.rel.toLowerCase() === DESIGN_DOC_NAME.toLowerCase()) { designDoc = true; files.push({ rel: DESIGN_DOC_NAME, abs: f.abs }); continue; }
      const rel = `${at.prototype}/${f.rel}`;
      files.push({ rel, abs: f.abs });
      if (/\.html?$/i.test(f.rel)) pages.push({ rel, title: htmlTitle(readFileSync(f.abs, 'utf8')) });
    }
  }
  if (files.length > MAX_FILES) throw new IntakeError(`输入共 ${files.length} 个文件，超过 ${MAX_FILES} 个；请只给 PRD、架构文档与原型导出目录`);
  const bytes = files.reduce((n, f) => n + statSync(f.abs).size, 0);
  if (bytes > MAX_BYTES) throw new IntakeError(`输入共 ${(bytes / 1048576).toFixed(1)} MB，超过 ${MAX_BYTES / 1048576} MB`);
  const contents: { rel: string; content: string | Buffer }[] = files.map((f) => ({ rel: f.rel, content: readFileSync(f.abs) }));
  if (pages.length) {
    contents.push({ rel: `${at.prototype}/INDEX.md`, content: `# 原型页面\n\n由 pi-forge 接收时生成。\n\n${pages.map((p) => `- \`${p.rel}\`${p.title ? `：${p.title}` : ''}`).join('\n')}\n` });
  }
  commitFilesToBranch(root, flow.integration_branch, contents, `pi-forge: ${flowId} 接收用户提供的 PRD${arch.length ? '、技术架构' : ''}${input.design ? '、原型与设计规范' : ''}`);
  const intake = {
    prd: prd.length === 1 && statSync(path.resolve(root, input.prd)).isFile() ? `${at.prd}/${prd[0]!.rel}` : at.prd,
    ...(arch.length ? { arch: arch.length === 1 && statSync(path.resolve(root, input.arch!)).isFile() ? `${at.arch}/${arch[0]!.rel}` : at.arch } : {}),
    pages: pages.map((p) => p.rel),
    design_doc: designDoc,
  };
  await store.setIntake(flowId, intake, 'human', `接收 PRD ${intake.prd}${intake.arch ? `、架构 ${intake.arch}` : ''}${pages.length ? `、原型 ${pages.length} 页` : ''}${designDoc ? '、设计规范' : ''}`);
  return intake;
}

/** 原文转达的上限（字符）：超出的部分只给路径，用 git show 读 */
export const INTAKE_BRIEF_MAX = 60_000;
const TEXT_FILE = /\.(md|markdown|txt|ya?ml|json)$/i;

/**
 * 接收材料的原文（真实模型实验：PRD 只在集成分支上，主 agent 用 read 在主工作区找不到，以为"没有提供 PRD"另起炉灶）。
 * 开始时把 PRD 与技术架构的文本原样放进给主 agent 的消息；超出上限的只列路径。
 */
export function intakeBrief(root: string, flow: Pick<FlowFile, 'intake' | 'integration_branch'>): string {
  const i = flow.intake;
  if (!i) return '';
  const ref = flow.integration_branch;
  const files = [i.prd, ...(i.arch ? [i.arch] : [])].flatMap((p) =>
    git(root, ['ls-tree', '-r', '--name-only', ref, '--', p]).split('\n').filter((f) => f && TEXT_FILE.test(f)));
  let left = INTAKE_BRIEF_MAX;
  const parts: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const text = git(root, ['show', `${ref}:${f}`]);
    if (text.length > left) { skipped.push(f); continue; }
    left -= text.length;
    parts.push(`===== ${f}（集成分支 ${ref}）=====\n${text.trimEnd()}`);
  }
  return [
    `下面是用户带来的材料原文。它们只在集成分支 ${ref} 上，主工作区里没有，不要用 read 去找；需要再看时用 git show ${ref}:<路径>。`,
    ...parts,
    ...(skipped.length ? [`以下文件太长没有放进来，用 git show ${ref}:<路径> 读：${skipped.join('、')}`] : []),
  ].join('\n\n');
}
