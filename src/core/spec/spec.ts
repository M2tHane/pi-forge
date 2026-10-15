// 规格的纯函数解析与检查（spec-lint）。
// 只有程序要靠它解析的格式算错误（需求标题与编号、AC 编号）；GWT 写法、占位词、页面、权限表、术语格式都只给警告。
export interface SpecFiles { requirements: string; screens: string; permissions: string; glossary: string }
export interface LintIssue { file: string; line?: number; rule: string; message: string }
export interface LintResult { errors: LintIssue[]; warnings: LintIssue[] }
export interface AcceptanceCriterion {
  id: string;
  manual: boolean;
  text: string;
  given?: string;
  when?: string;
  then?: string;
  line: number;
}
export interface Requirement {
  id: string;
  title: string;
  priority?: 'MVP' | 'LATER' | 'NO';
  roles: string[];
  acs: AcceptanceCriterion[];
  file: string;
  line: number;
}
export interface SpecScreen {
  name: string;
  route: string;
  reqs: string[];
  states: Record<string, string>;
  file: string;
  line: number;
  reqLine?: number;
  stateLines: Record<string, number>;
}
export interface SpecPermission {
  resource: string;
  grants: Record<string, string>;
  file: string;
  line: number;
}
export interface GlossaryTerm {
  name: string;
  english: string;
  definition: string;
  aliases: string[];
  file: string;
  line: number;
}
export interface EffectiveSpec {
  reqs: Requirement[];
  screens: SpecScreen[];
  permissions: SpecPermission[];
  glossary: GlossaryTerm[];
  issues: LintIssue[]; // 解析、叠加及引用错误。
  warnings: LintIssue[];
}
/** 单条 REQ 的 AC 数超过这个值时给警告：提示把通用规则写进「通用约定」（不阻断） */
export const MAX_AC_PER_REQ_HINT = 6;
export const UNTESTABLE_WORDS = ['快速', '友好', '合理'] as const;
export const REQUIRED_SCREEN_STATES = ['加载', '空', '错误', '无权限'] as const;
/** 只警告、不拦提交的规则 */
export const WARNING_RULES: ReadonlySet<string> = new Set(['ac-gwt', 'placeholder', 'permissions-table', 'screen-format', 'screen-req', 'screen-state', 'screen-na', 'glossary-format']);
const SPEC_DIR = 'docs/spec/';
const splitLines = (md: string): string[] => md.replace(/\r\n?/g, '\n').split('\n');
const names = (text: string): string[] => text.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
function issue(file: string, line: number, rule: string, message: string): LintIssue {
  return { file, line, rule, message: `${file}:${line} [${rule}] ${message}` };
}

/** 不猜测缺失的字段；保留解析得出的对象，供检查结果定位原文。 */
export function parseRequirements(md: string, file = `${SPEC_DIR}requirements.md`): { reqs: Requirement[]; issues: LintIssue[] } {
  return parseRequirementLines(splitLines(md), file, 0);
}
function parseRequirementLines(lines: string[], file: string, offset: number): { reqs: Requirement[]; issues: LintIssue[] } {
  const reqs: Requirement[] = [];
  const issues: LintIssue[] = [];
  let current: Requirement | undefined;
  let ac: AcceptanceCriterion | undefined;
  lines.forEach((raw, index) => {
    const line = index + offset + 1;
    const text = raw.trim();
    if (/^#{1,6}\s/.test(text)) {
      current = undefined;
      ac = undefined;
      if (!/^#{1,6}\s+REQ\b/i.test(text)) return;
      const match = /^###\s+(REQ-\d{3,})\s*(.*)$/.exec(text);
      if (!match) {
        issues.push(issue(file, line, 'req-format', '需求标题应写成 ### REQ-001 标题 [MVP]。'));
        return;
      }
      const priorityMatch = /\[([^\]]*)\]\s*$/.exec(match[2]!);
      const priority = priorityMatch?.[1]?.trim();
      const title = match[2]!.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      current = { id: match[1]!, title, roles: [], acs: [], file, line };
      if (priority === 'MVP' || priority === 'LATER' || priority === 'NO') current.priority = priority;
      else issues.push(issue(file, line, 'priority', `${current.id} 的标题末尾必须写 [MVP]、[LATER] 或 [NO]。`));
      if (!title) issues.push(issue(file, line, 'req-format', `${current.id} 必须填写需求标题。`));
      reqs.push(current);
      return;
    }
    const role = /^角色\s*[：:]\s*(.*)$/.exec(text);
    if (role && current) { current.roles = names(role[1]!); ac = undefined; return; }
    const acMatch = /^(?:[-*+]\s+)?(AC\d+)\s*(?:[（(]\s*(manual)\s*[）)])?\s*[：:]\s*(.*)$/i.exec(text);
    if (acMatch) {
      if (!current) { issues.push(issue(file, line, 'ac-format', 'AC 必须放在 ### REQ-001 标题 [MVP] 需求小节内。')); return; }
      ac = { id: acMatch[1]!.toUpperCase(), manual: Boolean(acMatch[2]), text: acMatch[3]!.trim(), line };
      current.acs.push(ac);
      return;
    }
    if (/^(?:[-*+]\s+)?AC\b|^(?:[-*+]\s+)?AC\d/i.test(text)) {
      issues.push(issue(file, line, 'ac-format', '验收标准应写成 - AC1：Given 条件 When 操作 Then 结果；人工验收写 - AC1（manual）：说明。'));
      ac = undefined;
      return;
    }
    // 缩进续行与独立的 Given/When/Then 行归入前一条 AC。
    if (ac && text && (/^\s+\S/.test(raw) || /^(given|when|then)\b/i.test(text))) ac.text += `\n${text}`;
    else if (text) ac = undefined;
  });
  for (const req of reqs) {
    if (req.priority === 'MVP' && !req.acs.length) issues.push(issue(file, req.line, 'ac-required', `${req.id} 是 MVP，至少填写一条 - AC1：Given 条件 When 操作 Then 结果。`));
    const seen = new Set<string>();
    for (const criterion of req.acs) {
      if (seen.has(criterion.id)) issues.push(issue(file, criterion.line, 'ac-duplicate', `${req.id}.${criterion.id} 重复，请在同一需求内使用不同的 AC 编号。`));
      seen.add(criterion.id);
      if (!criterion.text) issues.push(issue(file, criterion.line, 'ac-format', `${req.id}.${criterion.id} 必须填写验收内容。`));
      if (!criterion.manual) {
        const parts = [...criterion.text.matchAll(/\b(given|when|then)\b\s*[：:]?\s*/gi)];
        if (parts.length !== 3 || parts.map((p) => p[1]!.toLowerCase()).join(',') !== 'given,when,then') {
          issues.push(issue(file, criterion.line, 'ac-gwt', `${req.id}.${criterion.id} 必须依次写 Given 条件 When 操作 Then 结果，三段都不能省略。`));
          continue;
        }
        const values = parts.map((part, i) => criterion.text.slice(part.index! + part[0].length, parts[i + 1]?.index).trim());
        if (values.some((value) => !value)) issues.push(issue(file, criterion.line, 'ac-gwt', `${req.id}.${criterion.id} 的 Given、When、Then 后都必须填写具体内容。`));
        [criterion.given, criterion.when, criterion.then] = values;
      }
    }
  }
  return { reqs, issues };
}

function cells(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.includes('|')) return undefined;
  // 支持转义竖线，首尾竖线可省略。
  const parts = trimmed.split(/(?<!\\)\|/);
  if (!parts[0]?.trim()) parts.shift();
  if (!parts.at(-1)?.trim()) parts.pop();
  return parts.map((part) => part.trim().replace(/\\\|/g, '|'));
}
const separator = (row: string[]): boolean => row.every((cell) => /^:?-{3,}:?$/.test(cell));

function parseScreens(lines: string[], file: string, offset: number, issues: LintIssue[]): SpecScreen[] {
  const screens: SpecScreen[] = [];
  let current: SpecScreen | undefined;
  lines.forEach((raw, index) => {
    const text = raw.trim();
    const line = offset + index + 1;
    if (/^##\s+/.test(text)) {
      current = undefined;
      const heading = /^##\s+(.+?)\s+(\/\S*)\s*$/.exec(text);
      if (!heading) { issues.push(issue(file, line, 'screen-format', '页面标题应写成 ## 页面名称 /route。')); return; }
      current = { name: heading[1]!, route: heading[2]!, reqs: [], states: {}, stateLines: {}, file, line };
      screens.push(current);
      return;
    }
    if (!current) return;
    const refs = /^REQ\s*[：:]\s*(.*)$/i.exec(text);
    if (refs) {
      current.reqLine = line;
      const tokens = names(refs[1]!);
      current.reqs = tokens.filter((token) => /^REQ-\d{3,}$/.test(token));
      if (tokens.some((token) => !/^REQ-\d{3,}$/.test(token))) issues.push(issue(file, line, 'screen-req', 'REQ 行只能填写需求编号，格式为 REQ：REQ-001、REQ-002。'));
    }
    const row = cells(text);
    if (row && !separator(row) && row[0] !== '状态') {
      if (row.length !== 2 || !row[0] || !row[1]) issues.push(issue(file, line, 'screen-state', '状态表每行应有两列，例如 | 加载 | 骨架屏 |。'));
      else {
        if (current.states[row[0]] !== undefined) issues.push(issue(file, line, 'screen-state', `页面 ${current.name} 的 ${row[0]} 状态重复，请只保留一行。`));
        current.states[row[0]] = row[1];
        current.stateLines[row[0]] = line;
      }
    }
  });
  for (const screen of screens) {
    if (!screen.reqs.length) issues.push(issue(file, screen.reqLine ?? screen.line, 'screen-req', `页面 ${screen.name} 必须填写 REQ：REQ-001，引用已存在的需求。`));
    for (const state of REQUIRED_SCREEN_STATES) {
      const value = screen.states[state];
      if (!value) issues.push(issue(file, screen.line, 'screen-state', `页面 ${screen.name} 缺少 ${state} 状态，请在状态表填写表现，或写 N/A：具体理由。`));
    }
    for (const [state, value] of Object.entries(screen.states)) {
      if (/^N\s*\/\s*A\b/i.test(value) && !/^N\s*\/\s*A\s*[：:]\s*\S/i.test(value)) {
        issues.push(issue(file, screen.stateLines[state]!, 'screen-na', `页面 ${screen.name} 的 ${state} 写了 N/A，必须补充理由，例如 N/A：所有角色都可访问。`));
      }
    }
  }
  return screens;
}

function parsePermissions(lines: string[], file: string, offset: number, issues: LintIssue[]): SpecPermission[] {
  const permissions: SpecPermission[] = [];
  let header: string[] | undefined;
  let found = false;
  lines.forEach((raw, index) => {
    const line = offset + index + 1;
    const row = cells(raw);
    if (!row) {
      if (header && raw.trim() && !/^#/.test(raw.trim())) issues.push(issue(file, line, 'permissions-table', '权限表的数据行无法解析，请使用竖线分列并与表头保持相同列数。'));
      header = undefined;
      return;
    }
    found = true;
    if (separator(row)) {
      if (!header || row.length !== header.length) issues.push(issue(file, line, 'permissions-table', '权限表分隔行必须位于表头后，并与表头列数相同。'));
      return;
    }
    if (!header) {
      if (row.length < 2 || row.some((cell) => !cell) || new Set(row.slice(1)).size !== row.length - 1) {
        issues.push(issue(file, line, 'permissions-table', '权限表头应写 | 资源 · 操作 | 角色一 | 角色二 |，角色列不能为空或重复。'));
        return;
      }
      header = row;
      return;
    }
    if (row.length !== header.length || row.some((cell) => !cell)) {
      issues.push(issue(file, line, 'permissions-table', '权限表每行必须与表头列数相同，每个单元格填写 ✓、✗ 或明确条件。'));
      return;
    }
    permissions.push({ resource: row[0]!, grants: Object.fromEntries(header.slice(1).map((role, i) => [role, row[i + 1]!])), file, line });
  });
  if (!found && lines.some((l) => l.trim() && !/^#/.test(l.trim()))) issues.push(issue(file, offset + 1, 'permissions-table', '无法解析权限表，请填写 | 资源 · 操作 | 角色 | 表头及权限矩阵。'));
  return permissions;
}

function parseGlossary(md: string, file: string, issues: LintIssue[]): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  let current: GlossaryTerm | undefined;
  splitLines(md).forEach((raw, index) => {
    const text = raw.trim();
    if (/^\*\*/.test(text)) {
      current = undefined;
      const match = /^\*\*(.+?)[（(]\s*([^（）()]+)\s*[）)]\*\*\s*[：:]\s*(.*)$/.exec(text);
      if (!match) { issues.push(issue(file, index + 1, 'glossary-format', '术语应写成 **中文名（EnglishName）**：，下一行填写定义。')); return; }
      current = { name: match[1]!.trim(), english: match[2]!.trim(), definition: match[3]!.trim(), aliases: [], file, line: index + 1 };
      terms.push(current);
    } else if (current) {
      const aliases = /^_不要叫_\s*[：:]\s*(.*)$/.exec(text);
      if (aliases) current.aliases = names(aliases[1]!);
      else if (/^#/.test(text)) current = undefined;
      else if (text) current.definition += `${current.definition ? '\n' : ''}${text}`;
    }
  });
  for (const term of terms) if (!term.definition) issues.push(issue(file, term.line, 'glossary-format', `术语 ${term.name} 必须填写定义。`));
  return terms;
}

/** 解析四份规格并做交叉检查（页面引用的 REQ 是否存在）。screens.md 可以为空（没有界面的项目）。 */
export function effectiveSpec(base: SpecFiles): EffectiveSpec {
  const issues: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const reqs = new Map<string, Requirement>();
  const usedIds = new Set<string>();
  const screens = new Map<string, SpecScreen>();
  const permissions = new Map<string, SpecPermission>();
  let maxId = 0;
  const scanPlaceholders = (content: string, file: string): void => {
    splitLines(content).forEach((line, index) => {
      // 只认大写、独立成词的 TODO/TBD 与"待定"：不区分大小写会把 Todo、TodoList 这类合法术语当成占位（M9 冒烟发现）
      if (/(?<![A-Za-z])(TODO|TBD)(?![A-Za-z])|待定/.test(line)) issues.push(issue(file, index + 1, 'placeholder', '发现 TODO、TBD 或待定，请替换为确定、可验收的内容。'));
    });
  };
  const applyRequirements = (parsed: ReturnType<typeof parseRequirements>): void => {
    issues.push(...parsed.issues);
    for (const req of parsed.reqs) {
      if (usedIds.has(req.id)) { issues.push(issue(req.file, req.line, 'req-duplicate', `${req.id} 编号已使用，请换一个编号。`)); continue; }
      const number = Number(req.id.slice(4));
      if (number !== maxId + 1) warnings.push(issue(req.file, req.line, 'req-sequence', `${req.id} 未接续已有最大编号，请优先使用 REQ-${String(maxId + 1).padStart(3, '0')}。`));
      maxId = Math.max(maxId, number);
      usedIds.add(req.id);
      reqs.set(req.id, req);
      for (const ac of req.acs) {
        const words = UNTESTABLE_WORDS.filter((word) => ac.text.includes(word));
        if (words.length) warnings.push(issue(req.file, ac.line, 'ac-untestable', `${req.id}.${ac.id} 包含无法测试的词（${words.join('、')}），请改成具体数字或可观察行为。`));
      }
      if (req.acs.length > MAX_AC_PER_REQ_HINT) warnings.push(issue(req.file, req.line, 'ac-too-many', `${req.id} 有 ${req.acs.length} 条 AC（超过 ${MAX_AC_PER_REQ_HINT}）：检查是否把通用规则（输入校验、规范化、错误结构等）写成了 AC；这类细则请写进 requirements.md 的「通用约定」一节。`));
    }
  };
  const applyPermissions = (rows: SpecPermission[]): void => {
    for (const row of rows) permissions.set(row.resource, { ...row, grants: { ...permissions.get(row.resource)?.grants, ...row.grants } });
  };
  for (const [name, content] of Object.entries(base)) scanPlaceholders(content, `${SPEC_DIR}${name}.md`);
  const glossary = parseGlossary(base.glossary, `${SPEC_DIR}glossary.md`, issues);
  const baseReqs = parseRequirements(base.requirements);
  if (!baseReqs.reqs.length) issues.push(issue(`${SPEC_DIR}requirements.md`, 1, 'req-format', '基线至少填写一条 ### REQ-001 标题 [MVP] 需求。'));
  applyRequirements(baseReqs);
  parseScreens(splitLines(base.screens), `${SPEC_DIR}screens.md`, 0, issues).forEach((screen) => screens.set(screen.route, screen));
  applyPermissions(parsePermissions(splitLines(base.permissions), `${SPEC_DIR}permissions.md`, 0, issues));
  for (const screen of screens.values()) for (const id of screen.reqs) {
    if (!reqs.has(id)) issues.push(issue(screen.file, screen.reqLine ?? screen.line, 'screen-req', `页面 ${screen.name} 引用了不存在的 ${id}，请改为生效规格中的 REQ 编号。`));
  }
  return {
    reqs: [...reqs.values()], screens: [...screens.values()], permissions: [...permissions.values()], glossary,
    issues: issues.filter((i) => !WARNING_RULES.has(i.rule)), warnings: [...issues.filter((i) => WARNING_RULES.has(i.rule)), ...warnings],
  };
}

export function lintSpec(base: SpecFiles): LintResult {
  const spec = effectiveSpec(base);
  return { errors: spec.issues, warnings: spec.warnings };
}
function acMap(spec: EffectiveSpec): Map<string, AcceptanceCriterion> {
  return new Map(spec.reqs.flatMap((req) => req.acs.map((ac) => [`${req.id}.${ac.id}`, ac] as const)));
}
/** 缺失编号不猜测也不补空值，调用者可比较请求编号与返回键。 */
export function acTexts(spec: EffectiveSpec, ids: readonly string[]): Record<string, string> {
  const all = acMap(spec);
  return Object.fromEntries(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!.text]));
}

