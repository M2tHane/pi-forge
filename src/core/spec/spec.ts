// 规格 v3.2 的纯函数解析与检查；参考 pi-flow src/core/requirements.ts @ 31f3f15
// 的 AC 提取方式，REQ、页面、权限及叠加规则按新规格实现，不复用 IO。
export interface SpecFiles { requirements: string; screens: string; permissions: string; glossary: string }
export interface SpecFeature { name: string; content: string }
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
  priority?: 'MVP' | 'LATER' | 'NO'; // 删除标记不需要优先级。
  roles: string[];
  acs: AcceptanceCriterion[];
  kind: 'base' | 'revised' | 'deleted';
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
export const UNTESTABLE_WORDS = ['快速', '友好', '合理'] as const;
export const REQUIRED_SCREEN_STATES = ['加载', '空', '错误', '无权限'] as const;
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
      const match = /^###\s+(REQ-\d{3,})\s*(?:[（(]\s*(修订|删除)\s*[）)])?\s*(.*)$/.exec(text);
      if (!match) {
        issues.push(issue(file, line, 'req-format', '需求标题应写成 ### REQ-001 标题 [MVP]，修订或删除标记紧跟编号。'));
        return;
      }
      const kind = match[2] === '修订' ? 'revised' : match[2] === '删除' ? 'deleted' : 'base';
      const priorityMatch = /\[([^\]]*)\]\s*$/.exec(match[3]!);
      const priority = priorityMatch?.[1]?.trim();
      const title = match[3]!.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      current = { id: match[1]!, title, roles: [], acs: [], kind, file, line };
      if (priority === 'MVP' || priority === 'LATER' || priority === 'NO') current.priority = priority;
      else if (kind !== 'deleted' || priorityMatch) issues.push(issue(file, line, 'priority', `${current.id} 的标题末尾必须写 [MVP]、[LATER] 或 [NO]。`));
      if (!title && kind !== 'deleted') issues.push(issue(file, line, 'req-format', `${current.id} 必须填写需求标题。`));
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
    if (req.kind === 'deleted') {
      if (req.acs.length) issues.push(issue(file, req.acs[0]!.line, 'req-delete', `${req.id}（删除）只写删除标题，不填写 AC。`));
      continue;
    }
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

function parsePermissions(lines: string[], file: string, offset: number, issues: LintIssue[], roleRefs: { role: string; file: string; line: number }[]): SpecPermission[] {
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
      row.slice(1).forEach((role) => roleRefs.push({ role, file, line }));
      return;
    }
    if (row.length !== header.length || row.some((cell) => !cell)) {
      issues.push(issue(file, line, 'permissions-table', '权限表每行必须与表头列数相同，每个单元格填写 ✓、✗ 或明确条件。'));
      return;
    }
    permissions.push({ resource: row[0]!, grants: Object.fromEntries(header.slice(1).map((role, i) => [role, row[i + 1]!])), file, line });
  });
  if (!found) issues.push(issue(file, offset + 1, 'permissions-table', '无法解析权限表，请填写 | 资源 · 操作 | 角色 | 表头及权限矩阵。'));
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

interface FeatureSection { lines: string[]; offset: number }
function featureSections(content: string, file: string, issues: LintIssue[]): Partial<Record<'requirements' | 'screens' | 'permissions', FeatureSection>> {
  const sections: Partial<Record<'requirements' | 'screens' | 'permissions', FeatureSection>> = {};
  let current: FeatureSection | undefined;
  splitLines(content).forEach((raw, index) => {
    const match = /^##\s+(需求|需求清单|页面|权限)\s*$/.exec(raw.trim());
    if (match) {
      const key = match[1]!.startsWith('需求') ? 'requirements' : match[1] === '页面' ? 'screens' : 'permissions';
      if (sections[key]) issues.push(issue(file, index + 1, 'feature-section', `${match[1]} 节重复，请合并为一个小节。`));
      current = { lines: [], offset: index + 1 };
      sections[key] = current;
    } else if (current) current.lines.push(raw);
  });
  for (const [key, label] of [['requirements', '需求'], ['screens', '页面'], ['permissions', '权限']] as const) {
    if (!sections[key]) issues.push(issue(file, 1, 'feature-section', `feature 必须包含 ## ${label} 节，内容格式与基线文件相同。`));
  }
  return sections;
}

/** 按文件名排序叠加；需求整条替换或删除，页面按路由替换，权限按资源操作合并角色单元格。 */
export function effectiveSpec(base: SpecFiles, features: readonly SpecFeature[]): EffectiveSpec {
  const issues: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const reqs = new Map<string, Requirement>();
  const usedIds = new Set<string>();
  const screens = new Map<string, SpecScreen>();
  const permissions = new Map<string, SpecPermission>();
  const roleRefs: { role: string; file: string; line: number }[] = [];
  let maxId = 0;
  const scanPlaceholders = (content: string, file: string): void => {
    splitLines(content).forEach((line, index) => {
      // 只认大写、独立成词的 TODO/TBD 与"待定"：不区分大小写会把 Todo、TodoList 这类合法术语当成占位（偏离 88，M9 冒烟发现）
      if (/(?<![A-Za-z])(TODO|TBD)(?![A-Za-z])|待定/.test(line)) issues.push(issue(file, index + 1, 'placeholder', '发现 TODO、TBD 或待定，请替换为确定、可验收的内容。'));
    });
  };
  const applyRequirements = (parsed: ReturnType<typeof parseRequirements>): void => {
    issues.push(...parsed.issues);
    for (const req of parsed.reqs) {
      if (req.kind !== 'base') {
        if (!reqs.has(req.id)) { issues.push(issue(req.file, req.line, 'req-target', `${req.id} 尚不存在，不能${req.kind === 'deleted' ? '删除' : '修订'}；新增需求请去掉标记。`)); continue; }
        if (req.kind === 'deleted') reqs.delete(req.id);
        else reqs.set(req.id, req);
      } else {
        if (usedIds.has(req.id)) { issues.push(issue(req.file, req.line, 'req-duplicate', `${req.id} 编号已使用；替换请写 ### ${req.id}（修订）标题 [MVP]，删除请写 ### ${req.id}（删除）。`)); continue; }
        const number = Number(req.id.slice(4));
        if (number !== maxId + 1) warnings.push(issue(req.file, req.line, 'req-sequence', `${req.id} 未接续已有最大编号，请优先使用 REQ-${String(maxId + 1).padStart(3, '0')}。`));
        maxId = Math.max(maxId, number);
        usedIds.add(req.id);
        reqs.set(req.id, req);
      }
      for (const ac of req.acs) {
        const words = UNTESTABLE_WORDS.filter((word) => ac.text.includes(word));
        if (words.length) warnings.push(issue(req.file, ac.line, 'ac-untestable', `${req.id}.${ac.id} 包含无法测试的词（${words.join('、')}），请改成具体数字或可观察行为。`));
      }
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
  applyPermissions(parsePermissions(splitLines(base.permissions), `${SPEC_DIR}permissions.md`, 0, issues, roleRefs));
  const featureNames = new Set<string>();
  for (const feature of [...features].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = `${SPEC_DIR}features/${feature.name.endsWith('.md') ? feature.name : `${feature.name}.md`}`;
    if (featureNames.has(file)) issues.push(issue(file, 1, 'feature-duplicate', 'feature 文件名重复，请使用不同的文件名。'));
    featureNames.add(file);
    scanPlaceholders(feature.content, file);
    const sections = featureSections(feature.content, file, issues);
    if (sections.requirements) applyRequirements(parseRequirementLines(sections.requirements.lines, file, sections.requirements.offset));
    if (sections.screens) parseScreens(sections.screens.lines, file, sections.screens.offset, issues).forEach((screen) => screens.set(screen.route, screen));
    if (sections.permissions) applyPermissions(parsePermissions(sections.permissions.lines, file, sections.permissions.offset, issues, roleRefs));
  }
  for (const screen of screens.values()) for (const id of screen.reqs) {
    if (!reqs.has(id)) issues.push(issue(screen.file, screen.reqLine ?? screen.line, 'screen-req', `页面 ${screen.name} 引用了不存在的 ${id}，请改为生效规格中的 REQ 编号。`));
  }
  const roles = new Set(glossary.map((term) => term.name));
  for (const ref of roleRefs) if (!roles.has(ref.role)) issues.push(issue(ref.file, ref.line, 'permissions-role', `角色 ${ref.role} 不在术语表中，请添加 **${ref.role}（EnglishName）**：及定义，或改用术语表已有名字。`));
  return { reqs: [...reqs.values()], screens: [...screens.values()], permissions: [...permissions.values()], glossary, issues, warnings };
}

export function lintSpec(base: SpecFiles, features: readonly SpecFeature[] = []): LintResult {
  const spec = effectiveSpec(base, features);
  return { errors: spec.issues, warnings: spec.warnings };
}
function acMap(spec: EffectiveSpec): Map<string, AcceptanceCriterion> {
  return new Map(spec.reqs.flatMap((req) => req.acs.map((ac) => [`${req.id}.${ac.id}`, ac] as const)));
}
export function diffAcs(before: EffectiveSpec, after: EffectiveSpec): { added: string[]; changed: string[]; removed: string[] } {
  const previous = acMap(before);
  const next = acMap(after);
  return {
    added: [...next.keys()].filter((id) => !previous.has(id)).sort(),
    changed: [...next].filter(([id, ac]) => previous.has(id) && (previous.get(id)!.text !== ac.text || previous.get(id)!.manual !== ac.manual)).map(([id]) => id).sort(),
    removed: [...previous.keys()].filter((id) => !next.has(id)).sort(),
  };
}
/** 缺失编号不猜测也不补空值，调用者可比较请求编号与返回键。 */
export function acTexts(spec: EffectiveSpec, ids: readonly string[]): Record<string, string> {
  const all = acMap(spec);
  return Object.fromEntries(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!.text]));
}

/** 只解析术语表（P1 起 architect 只能追加条目，比较前后两版时用） */
export function glossaryTerms(md: string, file = `${SPEC_DIR}glossary.md`): GlossaryTerm[] {
  return parseGlossary(md, file, []);
}
