// 解析并校验 workflow.yaml：schema 校验 + 引用校验 + 角色策略推导。错误指出 YAML 路径与行号。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LineCounter, parseDocument, isNode } from 'yaml';
import { PHASES, validate, type ThinkingLevel, type WorkflowFile } from './schemas.ts';
import { COMMANDS_FILE, commandsTextAt, commandsTextIn, parseProjectCommands, type ProjectCommands, type SharedEnvSetting } from './project-commands.ts';

export const BUILTIN_READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
export const BUILTIN_WRITE_TOOLS = ['write', 'edit'] as const;
export const FLOW_TOOLS = [
  'forge_status', 'forge_wait', 'forge_claim', 'forge_note', 'forge_submit',
  'forge_block', 'forge_learn', 'notes', 'history', 'forge_sync',
  'forge_read', 'forge_spec', 'forge_change', 'forge_change_request',
  'forge_resolve_timeout', 'forge_decide',
  'forge_service', 'forge_propose_plan', 'forge_review_report', 'forge_review_confirm',
  'forge_qa_report', 'forge_qa_confirm',
  'forge_add_dependency', 'forge_private_deps',
] as const;
/** 所有角色（包括 orchestrator）都隐式拥有的工具 */
export const MEMORY_TOOLS = ['notes', 'history'] as const;
export const DEFAULT_COMPACT_AT = 0.7;
/**
 * Pi 内置的编排工具（0.99 起）：codemode 在沙箱中运行模型写的 JavaScript，脚本通过 tools.<名称>() 调用本角色已启用的其他工具。
 * 已实测：脚本中的每个工具调用都经过 tool_call 处理函数（guard 照常拦截与计违规）。它自己不直接读写文件。
 */
export const ORCHESTRATING_TOOLS = ['codemode'] as const;
/** 只能显式分配给特定角色；按层运行时夹具的 *-engineer 视为 worker */
const ROLE_EXCLUSIVE: Record<string, readonly string[]> = {
  forge_add_dependency: ['worker', 'architect'], forge_private_deps: ['worker', 'architect'],
  forge_service: ['worker', 'architect', 'stage-qa'], forge_propose_plan: ['architect'],
  forge_review_report: ['reviewer'], forge_review_confirm: ['reviewer'],
  forge_qa_report: ['stage-qa'], forge_qa_confirm: ['stage-qa'],
  forge_read: ['orchestrator'], forge_spec: ['orchestrator'], forge_change: ['orchestrator'],
  forge_resolve_timeout: ['orchestrator'], forge_decide: ['orchestrator'],
};
/** orchestrator 严格使用这份白名单 */
const ORCHESTRATOR_ALLOWED = new Set(['read', 'grep', 'find', 'ls', 'forge_read', 'ask_user', 'forge_spec', 'forge_change', 'forge_status', 'forge_wait', 'forge_change_request', 'forge_resolve_timeout', 'forge_decide', ...MEMORY_TOOLS]);
const WEB_GROUP = 'web';

export type ToolKind = 'read' | 'write' | 'bash' | 'flow' | 'web' | 'ext-read' | 'other';

export interface ResolvedRole {
  name: string;
  modelTier: string;
  model: string;
  thinking: ThinkingLevel | null;
  scopes: string[];
  /** 展开后的具体工具名；bash 只由角色的 bash 字段授予 */
  tools: Set<string>;
  /** 有序的工具列表，用于动态启用 */
  toolList: string[];
  bash: 'none' | 'full' | 'readonly' | 'allowlist';
  /** allowlist 档位额外允许的命令名（引用 commands，按前缀匹配） */
  bashAllow: string[];
  writes: string[];
  /** null 表示读不受路径限制（敏感文件除外） */
  env: Record<string, string>;
  rules: string[];
}

export class ConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`workflow.yaml 校验失败：\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

export class FlowConfig {
  readonly raw: WorkflowFile;
  readonly roles: Record<string, ResolvedRole>;
  readonly warnings: string[];
  private readonly kinds: Map<string, ToolKind>;
  /** commands.yaml 的内容；null 时用 workflow.yaml 里旧的 commands（老项目） */
  private project: ProjectCommands | null = null;

  constructor(raw: WorkflowFile, roles: Record<string, ResolvedRole>, kinds: Map<string, ToolKind>, warnings: string[]) {
    this.raw = raw;
    this.roles = roles;
    this.kinds = kinds;
    this.warnings = warnings;
  }

  get limits() { return this.raw.limits; }
  /** 项目命令：commands.yaml（集成分支上最新的一份，见 syncCommands），没有时用 workflow.yaml 里旧的 commands */
  get commands(): Record<string, string> { return this.project?.commands ?? this.raw.commands ?? {}; }
  get guiCommands(): string[] { return this.project?.gui_commands ?? this.raw.gui_commands ?? []; }
  get sharedEnv(): SharedEnvSetting | undefined { return this.project?.shared_env ?? this.raw.shared_env; }
  setProjectCommands(p: ProjectCommands | null): void { this.project = p; }

  /**
   * 换成某个分支（通常是集成分支）上的 commands.yaml；分支上没有时保持不变。
   * 格式不对时保持不变并返回错误（不让 worker 写坏的文件把程序停住；P1 闸门与审查会发现）。
   */
  syncCommands(root: string, ref: string): string | null {
    const text = commandsTextAt(root, ref);
    if (text === null) return null;
    try { this.project = parseProjectCommands(text, `${ref}:${COMMANDS_FILE}`); return null; } catch (e) { return (e as Error).message; }
  }
  /** 触发压缩的上下文占比 */
  get compactAt(): number { return this.raw.context?.compact_at ?? DEFAULT_COMPACT_AT; }

  role(name: string): ResolvedRole {
    const r = this.roles[name];
    if (!r) throw new ConfigError([`角色 ${name} 未在 workflow.yaml 中定义`]);
    return r;
  }

  /** 子进程应启用的工具列表 */
  activeTools(role: string): string[] {
    return this.role(role).toolList;
  }

  toolKind(tool: string): ToolKind {
    return this.kinds.get(tool) ?? 'other';
  }

  /** DAG 校验用的目录：角色 scopes、scope 可写范围、命令名、单任务文件上限 */
  dagCatalog(): { roles: Record<string, { scopes: string[] }>; scopes: Record<string, string[]>; commands: string[]; maxTaskFiles: number } {
    return {
      roles: Object.fromEntries(Object.values(this.roles).map((r) => [r.name, { scopes: r.scopes }])),
      scopes: this.scopeWrites(),
      commands: Object.keys(this.commands),
      maxTaskFiles: this.raw.limits.max_task_files,
    };
  }

  scopeWrites(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.raw.scopes).map(([k, v]) => [k, v.writes]));
  }
}

/** 读 workflow.yaml，再读 commands.yaml（默认同目录，即主工作区；子进程传自己的 worktree） */
export function loadConfig(file: string, commandsDir = path.dirname(file)): FlowConfig {
  const config = parseConfig(readFileSync(file, 'utf8'));
  const text = commandsTextIn(commandsDir) ?? (commandsDir !== path.dirname(file) ? commandsTextIn(path.dirname(file)) : null);
  if (text !== null) {
    try { config.setProjectCommands(parseProjectCommands(text)); } catch (e) { config.warnings.push((e as Error).message); }
  }
  return config;
}

export function parseConfig(source: string): FlowConfig {
  const lc = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lc, prettyErrors: false });
  if (doc.errors.length) {
    throw new ConfigError(doc.errors.map((e) => `YAML 语法错误：${e.message.split('\n')[0]}`));
  }
  const raw = doc.toJS() as unknown;
  const at = (path: (string | number)[]) => {
    const node = doc.getIn(path, true);
    const off = isNode(node) ? node.range?.[0] : undefined;
    const label = path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');
    return off === undefined ? label : `${label}（第 ${lc.linePos(off).line} 行）`;
  };

  // 已删除的配置项：旧项目的 workflow.yaml 里还有时忽略并提醒，不当错误
  const removedWarnings: string[] = [];
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, Record<string, unknown> | undefined>;
    const dropKey = (parent: string | null, key: string) => {
      const holder = parent ? o[parent] : (o as Record<string, unknown>);
      if (holder && typeof holder === 'object' && key in holder) { delete (holder as Record<string, unknown>)[key]; removedWarnings.push(`${parent ? `${parent}.` : ''}${key} 已不再支持，已忽略`); }
    };
    dropKey(null, 'acctest_workspace'); dropKey('modes', 'feature'); dropKey('limits', 'lean_below_loc'); dropKey('testing', 'max_disputes'); dropKey('implementation_gate', 'test_author'); dropKey('review', 'per_task'); dropKey('review', 'skip_sizes');
    // 已删除的工具名：旧 workflow.yaml 里还列着时去掉并告警，不让整个配置失效
    const REMOVED_TOOLS = new Set(['forge_request_scope', 'forge_resolve_scope', 'forge_spec_amend', 'forge_dispute']);
    const roles = o['roles'];
    if (roles && typeof roles === 'object') {
      for (const [name, def] of Object.entries(roles as Record<string, { tools?: unknown }>)) {
        if (!def || !Array.isArray(def.tools)) continue;
        const gone = def.tools.filter((t) => typeof t === 'string' && REMOVED_TOOLS.has(t));
        if (gone.length) { def.tools = def.tools.filter((t) => !gone.includes(t)); removedWarnings.push(`roles.${name}.tools 里的 ${gone.join('、')} 已不再支持，已忽略`); }
      }
    }
  }
  const schemaErrors = validate('workflow', raw);
  if (schemaErrors.length) {
    throw new ConfigError(schemaErrors.map((e) => {
      const ptr = e.slice('workflow'.length).split(':')[0]!;
      const path = ptr.split('/').filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
      return `${at(path)}: ${e.slice(e.indexOf(':') + 1).trim()}`;
    }));
  }
  const wf = raw as WorkflowFile;
  // schema 的 default 只描述配置；解析时补齐实际运行所需的默认值。
  wf.limits.max_precheck_failures ??= 3;
  wf.limits.max_merge_failures ??= 2;
  wf.limits.change_max_tasks ??= 3;
  // 状态机按 limits.review_max_rounds 判定审查轮数用尽；取自 review.max_rounds
  (wf.limits as Record<string, unknown>)['review_max_rounds'] ??= wf.review?.max_rounds ?? 2;
  const errors: string[] = [];
  const warnings: string[] = [...removedWarnings];

  for (const [tier, model] of Object.entries(wf.models)) {
    if (/^<.*>$/.test(model.trim())) warnings.push(`${at(['models', tier])}: 未填写具体模型（当前为占位符 ${model}）`);
  }

  // 闸门命令
  for (const mode of ['build'] as const) {
    const stages = wf.modes[mode]?.stages ?? [];
    if (wf.modes[mode] && (stages.length !== 2 || stages[0]?.id !== 'P0' || stages[1]?.id !== 'P1')) {
      errors.push(`${at(['modes', mode, 'stages'])}: ${mode} 只能按顺序配置 P0、P1；S 阶段由计划生成，使用 implementation_gate`);
    }
    const seen = new Set<string>();
    let lastPhase = -1;
    stages.forEach((s, i) => {
      if (s.phase) {
        const idx = PHASES.indexOf(s.phase);
        if (idx < lastPhase) errors.push(`${at(['modes', mode, 'stages', i, 'phase'])}: phase ${s.phase} 不能排在 ${PHASES[lastPhase]} 之后（高层阶段只能按 ${PHASES.join(' → ')} 前进）`);
        lastPhase = Math.max(lastPhase, idx);
      }
      if (seen.has(s.id)) errors.push(`${at(['modes', mode, 'stages', i, 'id'])}: 阶段 id ${s.id} 重复`);
      seen.add(s.id);
    });
  }

  // 工具分类
  const kinds = new Map<string, ToolKind>();
  for (const t of BUILTIN_READ_TOOLS) kinds.set(t, 'read');
  for (const t of BUILTIN_WRITE_TOOLS) kinds.set(t, 'write');
  for (const t of FLOW_TOOLS) kinds.set(t, 'flow');
  for (const t of ORCHESTRATING_TOOLS) kinds.set(t, 'other');
  kinds.set('bash', 'bash');
  kinds.set('ask_user', 'ext-read');
  for (const [group, tools] of Object.entries(wf.tool_groups)) {
    for (const t of tools) {
      // 扩展工具只读或联网；写文件只用内置 write/edit
      const kind: ToolKind = group === WEB_GROUP ? 'web' : 'ext-read';
      const prev = kinds.get(t);
      if (prev && prev !== kind) errors.push(`${at(['tool_groups', group])}: 工具 ${t} 的类别冲突（${prev} 与 ${kind}）`);
      else kinds.set(t, kind);
    }
  }

  const roles: Record<string, ResolvedRole> = {};
  for (const [name, def] of Object.entries(wf.roles)) {
    if (!(def.model in wf.models)) errors.push(`${at(['roles', name, 'model'])}: 模型档位 ${def.model} 未在 models 中定义`);
    const scopes = def.scopes ?? [];
    scopes.forEach((s, i) => {
      if (!(s in wf.scopes)) errors.push(`${at(['roles', name, 'scopes', i])}: scope ${s} 未在 scopes 中定义`);
    });
    const writes = [...new Set(scopes.flatMap((s) => wf.scopes[s]?.writes ?? []))];
    if (def.writes && (def.writes.length !== writes.length || def.writes.some((w) => !writes.includes(w)))) {
      errors.push(`${at(['roles', name, 'writes'])}: writes 由 scopes 并集推导，不能手写为不同的值（推导结果：${JSON.stringify(writes)}）`);
    }

    const toolList: string[] = [];
    const bash: ResolvedRole['bash'] = def.bash ?? 'none';
    if (def.bash === 'allowlist' && !def.bash_allow?.length) {
      errors.push(`${at(['roles', name, 'bash_allow'])}: bash: allowlist 必须配置 bash_allow 命令名数组`);
    }
    if (def.bash_allow && def.bash !== 'allowlist') {
      errors.push(`${at(['roles', name, 'bash_allow'])}: bash_allow 只能用于 bash: allowlist`);
    }
    // bash_allow 里的命令名在 commands.yaml 里找；没有定义的只是没有可放行的内容（项目未必都有），不算错误
    const addTool = (t: string, loc: string) => {
      if (t === 'bash' || t === 'bash_readonly') {
        errors.push(`${loc}: tools 中不能声明 ${t}，请改用角色的 bash: full、readonly 或 allowlist 字段`);
      } else if (kinds.has(t)) toolList.push(t);
      else errors.push(`${loc}: 未知工具 ${t}（不是内置工具、forge_* 工具，也不在任何 tool_groups 中）`);
    };
    def.tools.forEach((t, i) => {
      const loc = at(['roles', name, 'tools', i]);
      if (t.startsWith('@')) {
        const g = wf.tool_groups[t.slice(1)];
        if (!g) errors.push(`${loc}: 工具组 ${t.slice(1)} 未在 tool_groups 中定义`);
        else for (const tool of g) addTool(tool, loc);
      } else addTool(t, loc);
    });
    if (bash !== 'none') toolList.push('bash');
    // 子进程角色隐式拥有 forge_block、forge_learn；专属工具均须显式授予。
    if (name !== 'orchestrator') toolList.push('forge_block', 'forge_learn');
    // orchestrator 隐式拥有 forge_decide：阻塞、门禁用尽、变更请求先由它决定
    else toolList.push('forge_decide');
    // 有 forge_submit 的角色隐式拥有 forge_claim
    if (toolList.includes('forge_submit')) toolList.push('forge_claim');
    toolList.push(...MEMORY_TOOLS);
    const unique = [...new Set(toolList)];
    const tools = new Set(unique);

    for (const t of unique) {
      const owners = ROLE_EXCLUSIVE[t];
      if (owners && !owners.includes(name)) errors.push(`${at(['roles', name, 'tools'])}: ${t} 只能分配给 ${owners.join('、')}`);
    }
    if (name === 'orchestrator') {
      const extra = unique.filter((t) => !ORCHESTRATOR_ALLOWED.has(t));
      if (extra.length) errors.push(`${at(['roles', name, 'tools'])}: orchestrator 只能使用 ${[...ORCHESTRATOR_ALLOWED].join('、')}，不能有 ${extra.join('、')}`);
      if (writes.length) errors.push(`${at(['roles', name, 'scopes'])}: orchestrator 不能有可写范围`);
    }
    if (writes.length === 0) {
      const w = unique.filter((t) => kinds.get(t) === 'write');
      if (w.length) errors.push(`${at(['roles', name, 'tools'])}: ${name} 没有可写范围，不能拥有写工具 ${w.join('、')}`);
    }

    roles[name] = {
      name, modelTier: def.model, model: wf.models[def.model] ?? '', thinking: def.thinking ?? null,
      scopes, tools, toolList: unique, bash, bashAllow: [...(def.bash_allow ?? [])], writes, env: def.env ?? {},
      rules: [...new Set(scopes.flatMap((s) => wf.scopes[s]?.rules ?? []))],
    };
  }
  if (!roles['orchestrator']) errors.push('roles: 缺少 orchestrator 角色');
  // 模型引用：档位名必须在 models 中；provider/model 原样使用
  const modelRef = (ref: string | undefined, loc: (string | number)[]) => {
    if (ref && !ref.includes('/') && !(ref in wf.models)) errors.push(`${at(loc)}: 模型档位 ${ref} 未在 models 中定义（也可以写 provider/model）`);
  };
  for (const [name, def] of Object.entries(wf.roles)) modelRef(def.escalate_model, ['roles', name, 'escalate_model']);

  if (errors.length) throw new ConfigError(errors);
  return new FlowConfig(wf, roles, kinds, warnings);
}
