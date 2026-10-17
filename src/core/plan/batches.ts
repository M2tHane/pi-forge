// docs/plan.md 的「程序读取的部分」：批次、后端 domain、前端页面顺序、公共文件。解析、校验与派生任务都是纯函数。
// 校验只拦调度做不下去的情况（批次或 domain 重名、after 指向不存在或更晚的 domain、after 成环、空批次），其余只提醒。
import { parse as parseYaml } from 'yaml';
import type { FlowFile, TaskFile } from '../state/schemas.ts';
import type { TaskInput } from '../state/state-store.ts';
import { findCycle } from '../state/dag.ts';
import { ownAcceptanceGlob } from '../state/paths.ts';
import { pageOf, type Prd } from '../spec/prd.ts';

export const PLAN_MD = 'docs/plan.md';
export const PLAN_SECTION = '程序读取的部分';
/** 架构阶段提交时必须存在的文件 */
export const ARCH_REQUIRED_FILES = ['AGENTS.md', 'docs/arch/overview.md', 'docs/arch/domains.md', 'docs/contracts/openapi.yaml', 'docs/contracts/page-api.md', 'commands.yaml', PLAN_MD] as const;
/** 架构阶段的 task 额外可写的验收目录与项目规则 rules/** */
export const S0_EXTRA_WRITES = ['tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**', 'rules/**'] as const;

export interface BackendDomain { domain: string; after: string[]; paths: string[] }
export interface Batch { id: string; title: string; reqs: string[]; backend: BackendDomain[]; frontend: string[] }
export interface BatchPlan { max_parallel_backend?: number; batches: Batch[]; shared: string[] }
type PlanStage = NonNullable<FlowFile['s_stages']>[number];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] | null => v === undefined || v === null ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) ? v.map((x) => (x as string).trim()) : null;

/** 拆成说明部分（给人读）与「## 程序读取的部分」里第一个代码块的内容；没有这一节或没有代码块时 yaml 为 null */
export function splitPlan(md: string): { prose: string; yaml: string | null } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s*(?:[\\d.、]+\\s*)?${PLAN_SECTION}\\s*$`).test(l.trim()));
  if (start < 0) return { prose: md.trim(), yaml: null };
  const prose = lines.slice(0, start).join('\n').trim();
  const open = lines.findIndex((l, i) => i > start && /^(```|~~~)/.test(l.trim()));
  if (open < 0) return { prose, yaml: null };
  const fence = lines[open]!.trim().slice(0, 3);
  const close = lines.findIndex((l, i) => i > open && l.trim().startsWith(fence));
  return { prose, yaml: lines.slice(open + 1, close < 0 ? undefined : close).join('\n') };
}

/** 「风险与假设」一节（不含标题）；没有时为空 */
export function risksSection(prose: string): string {
  const lines = prose.split('\n');
  const start = lines.findIndex((l) => /^#{2,3}\s*(?:[\d.、]+\s*)?风险/.test(l.trim()));
  if (start < 0) return '';
  const level = lines[start]!.trim().match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** 解析 yaml 区块的形状：没见过的字段忽略，列表字段可以不写 */
export function parseBatchPlan(md: string): { plan: BatchPlan | null; errors: string[]; warnings: string[] } {
  const { yaml } = splitPlan(md);
  const fail = (e: string) => ({ plan: null, errors: [e], warnings: [] });
  if (yaml === null) return fail(`${PLAN_MD} 缺少「## ${PLAN_SECTION}」一节或其中的 yaml 代码块`);
  let raw: unknown;
  try { raw = parseYaml(yaml); } catch (e) { return fail(`${PLAN_MD} 的 yaml 区块不是合法的 YAML：${(e as Error).message.split('\n')[0]}`); }
  if (!isObj(raw)) return fail(`${PLAN_MD} 的 yaml 区块应是一个映射（max_parallel_backend、batches、shared）`);
  const errors: string[] = [];
  if (!Array.isArray(raw['batches']) || !raw['batches'].length) return fail(`${PLAN_MD}：batches 至少要有一个批次`);
  const batches: Batch[] = raw['batches'].map((b, i): Batch => {
    const at = `batches[${i}]`;
    if (!isObj(b)) { errors.push(`${at} 应是一个映射（id、title、reqs、backend、frontend）`); return { id: '', title: '', reqs: [], backend: [], frontend: [] }; }
    const id = typeof b['id'] === 'string' && b['id'].trim() ? b['id'].trim() : '';
    if (!id) errors.push(`${at} 缺少 id`);
    const reqs = strings(b['reqs']);
    if (!reqs) errors.push(`${at}.reqs 应是需求编号的列表`);
    const frontend = strings(b['frontend']);
    if (!frontend) errors.push(`${at}.frontend 应是页面 id 的列表`);
    const backend: BackendDomain[] = [];
    if (b['backend'] !== undefined && b['backend'] !== null && !Array.isArray(b['backend'])) errors.push(`${at}.backend 应是列表`);
    else for (const [j, d] of ((b['backend'] as unknown[] | undefined) ?? []).entries()) {
      const name = typeof d === 'string' ? d.trim() : isObj(d) && typeof d['domain'] === 'string' ? d['domain'].trim() : '';
      if (!name) { errors.push(`${at}.backend[${j}] 缺少 domain`); continue; }
      const after = isObj(d) ? strings(d['after']) : [];
      const paths = isObj(d) ? strings(d['paths']) : [];
      if (!after) errors.push(`${at}.backend[${j}].after 应是 domain 名的列表`);
      if (!paths) errors.push(`${at}.backend[${j}].paths 应是路径的列表`);
      backend.push({ domain: name, after: after ?? [], paths: paths ?? [] });
    }
    return { id, title: typeof b['title'] === 'string' ? b['title'].trim() : '', reqs: reqs ?? [], backend, frontend: frontend ?? [] };
  });
  const shared = strings(raw['shared']);
  if (!shared) errors.push('shared 应是路径的列表');
  const mpb = raw['max_parallel_backend'];
  const valid = Number.isInteger(mpb) && (mpb as number) > 0;
  const warnings = mpb !== undefined && mpb !== null && !valid ? ['max_parallel_backend 应是正整数，已忽略'] : [];
  const plan: BatchPlan = { batches, shared: shared ?? [], ...(valid ? { max_parallel_backend: mpb as number } : {}) };
  return errors.length ? { plan: null, errors, warnings } : { plan, errors: [], warnings };
}

/** 用户与鉴权的真实实现所在的 domain：S0 只定鉴权接口与开发、测试用的桩 */
export const IDENTITY = 'identity';

/** 校验：errors 是调度做不下去的情况，warnings 只提醒 */
export function checkBatchPlan(plan: BatchPlan, prd: Prd): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const batchOf = new Map<string, number>();
  const ids = new Set<string>();
  plan.batches.forEach((b, i) => {
    if (ids.has(b.id)) errors.push(`批次 id ${b.id} 重复`);
    ids.add(b.id);
    if (!b.backend.length && !b.frontend.length) errors.push(`批次 ${b.id} 既没有 backend 也没有 frontend`);
    for (const d of b.backend) {
      if (batchOf.has(d.domain)) errors.push(`domain ${d.domain} 重名（批次 ${plan.batches[batchOf.get(d.domain)!]!.id} 与 ${b.id}）`);
      else batchOf.set(d.domain, i);
    }
  });
  const edges = new Map<string, string[]>();
  plan.batches.forEach((b, i) => {
    for (const d of b.backend) {
      for (const a of d.after) {
        const at = batchOf.get(a);
        if (at === undefined) errors.push(`domain ${d.domain} 的 after 指向不存在的 domain ${a}`);
        else if (at > i) errors.push(`domain ${d.domain}（批次 ${b.id}）的 after 指向更晚批次 ${plan.batches[at]!.id} 的 domain ${a}`);
      }
      if (!edges.has(d.domain)) edges.set(d.domain, d.after.filter((a) => batchOf.has(a)));
    }
  });
  const cycle = findCycle([...edges].map(([id, after]) => ({ id, depends_on: after.map((task) => ({ task, type: 'hard' as const })) })));
  if (cycle) errors.push(`domain 的 after 形成环：${cycle.join(' → ')}`);
  const planned = new Set(plan.batches.flatMap((b) => b.reqs));
  const known = new Set(prd.reqs.map((r) => r.id));
  const missing = prd.reqs.filter((r) => !planned.has(r.id)).map((r) => r.id);
  if (missing.length) warnings.push(`PRD 里这些需求没有出现在任何批次：${missing.join('、')}`);
  const unknownReqs = [...planned].filter((r) => !known.has(r));
  if (unknownReqs.length && prd.reqs.length) warnings.push(`批次里这些需求编号在 PRD 里找不到：${unknownReqs.join('、')}`);
  const unknownPages = plan.batches.flatMap((b) => b.frontend).filter((p) => !pageOf(prd, p));
  if (unknownPages.length) warnings.push(`这些页面 id 在 PRD 的页面表里找不到对应项：${[...new Set(unknownPages)].join('、')}`);
  // 别的 domain 只依赖 S0 定的鉴权接口、开发时用桩，不等 identity（stock run-01：登录 → 分类 → 商品三环依赖把 4 个能并行的任务拖成串行）
  const waits = plan.batches.flatMap((b) => b.backend).filter((d) => d.after.includes(IDENTITY)).map((d) => d.domain);
  if (waits.length) warnings.push(`这些 domain 写了 after: [${IDENTITY}]：${waits.join('、')}。别的 domain 只依赖 S0 定的鉴权接口、开发时用桩，可以和 ${IDENTITY} 并行`);
  const at = batchOf.get(IDENTITY);
  if (at !== undefined && at > 0) warnings.push(`${IDENTITY} 不在第 1 批（在 ${plan.batches[at]!.id}）：之前批次的门禁与浏览器验收只能在鉴权桩下跑`);
  return { errors, warnings };
}

/** 页面 id 的说明：PRD 页面表里的原型文件与对应需求 */
function pageBrief(prd: Prd, id: string): string {
  const p = pageOf(prd, id);
  return p ? `原型：${p.file || '（页面表里没写）'}；对应需求：${p.reqs.join('、') || '（没写）'}` : '原型：PRD 的页面表里找不到这个页面，按 docs/contracts/page-api.md';
}

/**
 * 按计划生成批次阶段 S1…Sn 与任务（编号从 firstId 起）：每个 domain 一个后端任务（after 在本批的为硬依赖，前面批次的已完成）；
 * 第一个有页面的批次先做前端基础；页面按顺序一个接一个；有页面的批次最后接入真实接口（依赖本批全部任务，不单独审查）。
 * 前端任务接着同一批里上一个前端任务的会话做。
 */
export function deriveBatchTasks(plan: BatchPlan, prd: Prd, firstId: number, opts: { verify?: string[] } = {}): { stages: PlanStage[]; tasks: TaskInput[] } {
  let n = firstId;
  const nextId = () => `T-${String(n++).padStart(3, '0')}`;
  const stages: PlanStage[] = [];
  const tasks: TaskInput[] = [];
  let foundationDone = false;
  const hard = (task: string, reason: string): TaskFile['depends_on'][number] => ({ task, type: 'hard', reason });
  plan.batches.forEach((b, i) => {
    const stage = `S${i + 1}`;
    stages.push({ id: stage, goal: b.title ? `${b.id} ${b.title}` : b.id, exit: [...b.reqs] });
    const reqs = b.reqs.length ? `本批需求：${b.reqs.join('、')}（验收标准见 docs/PRD.md）。` : '';
    // 角色 backend / frontend 决定调度池与角色提示；layers 决定注入哪份 rules/<layer>.md
    const mk = (layer: 'backend' | 'frontend', title: string, description: string, deps: TaskFile['depends_on'], writes: string[], extra: Partial<TaskInput> = {}): TaskInput => {
      const id = nextId();
      return { id, stage, kind: 'impl', role: layer, title, description, scopes: ['code'], layers: [layer], depends_on: deps, inputs: [],
        writes: [...new Set([...writes, ownAcceptanceGlob(id)])], verify: [...(opts.verify ?? [])], ...(plan.shared.length ? { shared: [...plan.shared] } : {}), ...extra };
    };
    const domainTask = new Map<string, string>();
    const backend = b.backend.map((d) => {
      const deps = d.after.filter((a) => domainTask.has(a) || b.backend.some((x) => x.domain === a));
      return { d, deps };
    });
    // 本批内按 after 排好顺序再编号，依赖总是指向已编号的任务
    const ordered: typeof backend = [];
    const placed = new Set<string>();
    while (ordered.length < backend.length) {
      const next = backend.find((x) => !placed.has(x.d.domain) && x.deps.every((a) => placed.has(a)));
      if (!next) break;
      ordered.push(next);
      placed.add(next.d.domain);
    }
    for (const { d, deps } of ordered) {
      const t = mk('backend', `后端 ${d.domain}`, `后端 domain「${d.domain}」的整条链路：领域模型、服务、仓储、数据访问、controller、DTO、本 domain 的迁移与测试。职责、表与对外接口见 docs/arch/domains.md，HTTP 接口严格按 docs/contracts/openapi.yaml。${reqs}`,
        deps.map((a) => hard(domainTask.get(a)!, `需要 domain ${a}`)), d.paths, { domain: d.domain });
      domainTask.set(d.domain, t.id);
      tasks.push(t);
    }
    let prevFront: string | null = null;
    const frontIds: string[] = [];
    if (b.frontend.length && !foundationDone) {
      const t = mk('frontend', '前端基础', `前端基础：DESIGN.md、theme.css、公共组件、布局，按 docs/prototype/ 的原型统一视觉与交互。${reqs}`, [], []);
      tasks.push(t);
      prevFront = t.id;
      frontIds.push(t.id);
      foundationDone = true;
    }
    for (const page of b.frontend) {
      const t = mk('frontend', `页面 ${page}`, `页面「${page}」：严格按原型实现页面结构与交互，以及加载、空、错误、无权限四种状态，对着 mock 开发。${pageBrief(prd, page)}；用到的接口见 docs/contracts/page-api.md 里这一页。${reqs}`,
        prevFront ? [hard(prevFront, '前端按页面顺序开发')] : [], [], { page, ...(prevFront ? { fork_from_task: prevFront } : {}) });
      tasks.push(t);
      prevFront = t.id;
      frontIds.push(t.id);
    }
    if (b.frontend.length) {
      const deps = [...domainTask.values(), ...frontIds].map((x) => hard(x, '接入真实接口要等本批的页面与后端都完成'));
      tasks.push(mk('frontend', `接入真实接口（${b.id}）`, `把本批页面（${b.frontend.join('、')}）从 mock 切到真实接口，修好接口不一致的地方，跑本批的验收测试。前端不能改契约；契约有问题向架构师提问。${reqs}`,
        deps, [], { review: 'skip', ...(prevFront ? { fork_from_task: prevFront } : {}) }));
    }
  });
  return { stages, tasks };
}
