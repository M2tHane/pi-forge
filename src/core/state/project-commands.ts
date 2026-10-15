// 项目命令（仓库根目录的 commands.yaml）：怎么装依赖、跑测试、启动服务。architect 在 P1 写、S0 修正，worker 加工具时补充，
// 随代码一起合并。主要给 agent 参考；程序只执行其中几个必需的（PROGRAM_COMMANDS）。
// 程序读集成分支上最新的一份（合入即生效）；workflow.yaml 只放流程配置。老项目 workflow.yaml 里的 commands 仍然认，作为后备。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { git, gitOk } from './git.ts';

export const COMMANDS_FILE = 'commands.yaml';

/**
 * 程序自己执行的命令：准备环境（install、env_up、env_down、db_create、db_drop、add_dep）、阶段门禁与合并后回归（test、acceptance，
 * 门禁跑哪些由 workflow.yaml 的 implementation_gate.auto 决定）、forge_service（serve 与 serve_*）。
 * 其余（typecheck、lint、e2e、codegen……）只给 agent 参考，由 worker 与审查者自己决定要不要跑。
 */
export const PROGRAM_COMMANDS = ['install', 'test', 'acceptance', 'serve', 'env_up', 'env_down', 'db_create', 'db_drop', 'add_dep'] as const;
export const isProgramCommand = (name: string) => (PROGRAM_COMMANDS as readonly string[]).includes(name) || /^serve_[a-z0-9_]+$/.test(name);

export interface SharedEnvSetting { enabled?: boolean; deps?: string[] }
export interface ProjectCommands {
  commands: Record<string, string>;
  /** 会打开桌面应用或浏览器窗口的项目命令（前缀匹配）：agent 不能运行，要看效果时交给用户 */
  gui_commands: string[];
  /** 共享构建环境：S0 之后一次性装好依赖，worktree 链接共享依赖目录 */
  shared_env: SharedEnvSetting | null;
}

/** 解析 commands.yaml；格式不对时抛出带文件名的错误 */
export function parseProjectCommands(text: string, file = COMMANDS_FILE): ProjectCommands {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (e) { throw new Error(`${file} 不是合法 YAML：${(e as Error).message}`); }
  if (raw === null || raw === undefined) return { commands: {}, gui_commands: [], shared_env: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} 应为 commands: { 名称: "命令" } 的映射`);
  const obj = raw as { commands?: unknown; gui_commands?: unknown; shared_env?: unknown };
  const extra = Object.keys(obj).filter((k) => !['commands', 'gui_commands', 'shared_env'].includes(k));
  if (extra.length) throw new Error(`${file} 只能有 commands、gui_commands、shared_env，多了 ${extra.join('、')}`);
  const cmds = obj.commands ?? {};
  if (!cmds || typeof cmds !== 'object' || Array.isArray(cmds)) throw new Error(`${file} 中 commands 应为 { 名称: "命令" } 的映射`);
  const commands: Record<string, string> = {};
  for (const [k, v] of Object.entries(cmds)) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${file} 中 ${k} 的命令必须是非空字符串`);
    commands[k] = v;
  }
  const g = obj.gui_commands ?? [];
  if (!Array.isArray(g) || g.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`${file} 中 gui_commands 应为非空字符串的列表`);
  const se = obj.shared_env;
  const list = (v: unknown) => v === undefined || Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());
  if (se !== undefined && se !== null && (typeof se !== 'object' || Array.isArray(se) || Object.keys(se).some((k) => k !== 'enabled' && k !== 'deps')
    || ('enabled' in se && typeof (se as SharedEnvSetting).enabled !== 'boolean') || !list((se as SharedEnvSetting).deps))) {
    throw new Error(`${file} 中 shared_env 应为 { enabled: true|false, deps: [依赖目录] }`);
  }
  return { commands, gui_commands: (g as string[]).map((x) => x.trim()), shared_env: (se as SharedEnvSetting | null | undefined) ?? null };
}

/** 读某个分支上的 commands.yaml；分支或文件不存在时为 null */
export function commandsTextAt(root: string, ref: string): string | null {
  const full = `refs/heads/${ref}`;
  if (!gitOk(root, ['rev-parse', '--verify', '-q', full])) return null;
  if (!gitOk(root, ['cat-file', '-e', `${full}:${COMMANDS_FILE}`])) return null;
  return git(root, ['show', `${full}:${COMMANDS_FILE}`]);
}

/** 读目录（主工作区或 worktree）里的 commands.yaml；不存在时为 null */
export function commandsTextIn(dir: string): string | null {
  const f = path.join(dir, COMMANDS_FILE);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

/** commands.yaml 的问题（P1 闸门用）：缺文件、格式不对、没有 test */
export function commandsProblems(text: string | null, where: string): string[] {
  if (text === null) return [`${where}缺少 ${COMMANDS_FILE}：至少写 test（全量测试）；按技术栈写 install、serve 等`];
  try {
    const p = parseProjectCommands(text);
    return p.commands['test']?.trim() ? [] : [`${COMMANDS_FILE} 缺少 test 命令（阶段门禁与合并后回归要跑全量测试）`];
  } catch (e) { return [(e as Error).message]; }
}

/** 给 agent 看的命令清单：标出程序会执行的，其余是参考 */
export function commandsReference(commands: Record<string, string>): string {
  const names = Object.keys(commands);
  if (!names.length) return '';
  const line = (n: string) => `- ${n}：\`${commands[n]}\`${isProgramCommand(n) ? '' : '（参考）'}`;
  return [`项目命令（${COMMANDS_FILE}，程序只执行 install、test、acceptance、serve 等；标"参考"的按需自己运行，跑不了时在 ${COMMANDS_FILE} 里修正）：`, ...names.map(line)].join('\n');
}
