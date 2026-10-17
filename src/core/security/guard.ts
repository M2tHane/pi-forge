// guard：工具调用拦截与角色策略。纯判断，不做写入；违规记录由调用方交给 StateStore。
// 判定顺序：1 工具白名单 → 2 写路径白名单 → 3 受保护路径 → 4 bash 约束 → 5 敏感读取。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { BUILTIN_READ_TOOLS, BUILTIN_WRITE_TOOLS, type FlowConfig, type ResolvedRole } from '../state/config.ts';
import { INTERFACES_PATH, globsOverlap, isProtected, matchesAny, openWriteAllowed, protectedGlobs } from '../state/paths.ts';
import { linkedDeps } from '../workspace/shared-env.ts';
import { worktreesRoot } from '../workspace/worktree.ts';
import { parseShell, type SimpleCommand, type Word } from './shell.ts';

export type GuardRule = 'tool_whitelist' | 'read_paths' | 'write_paths' | 'protected' | 'bash' | 'sensitive';
/** warning：放行，但把提醒追加到工具结果后面给模型看 */
export type GuardDecision = { allow: true; warning?: string } | { allow: false; rule: GuardRule; reason: string };

export interface ToolCall { toolName: string; input: Record<string, unknown> }

export interface GuardContext {
  config: FlowConfig;
  role: string;
  /** 子进程工作目录 */
  cwd: string;
  /** 可写根目录：实施类为任务 worktree，主工作区角色为项目根 */
  workspaceRoot: string;
  /** 主工作区（项目根）。与 workspaceRoot 不同时，主工作区整体不可写 */
  mainRoot: string;
  /** 任务 writes（merge-fix 为冲突文件列表）；与角色 writes 同时生效 */
  writes?: string[];
  /** S0 的 architect 写 rules/：task 的 writes 显式包含 rules/** 时，rules/** 不再算受保护路径（.forge、.git、workflow.yaml、.pi 不变） */
  rulesWritable?: true;
  /** impl / fix：writes 只用于调度互斥与合并冲突归属，PRD、原型与受保护路径之外的文件都可以改（state/paths.ts 的 openWriteAllowed） */
  openWrites?: boolean;
  /** 实现类任务（第五轮）：可以在契约文档（docs/contracts/）里追加（只能新增，提交时由程序检查），不受任务可写范围限制 */
  interfaceAdditions?: boolean;
  /** merge-fix：冲突文件里不在角色可写范围内、但仍要能改的文件（测试、契约） */
  extraWritable?: readonly string[];
  /** 本 run 的临时目录（项目与 worktree 之外）：可以 cd、写入、删除、移动 */
  scratchDir?: string;
  /** 给 orchestrator 的指引中填入的 ready 任务 */
  readyTaskId?: string;
  /**
   * stage-qa 的隔离工作区（集成分支 HEAD 的临时 worktree）：读写与 bash 参数不能越出 workspaceRoot，不能碰 .forge/；
   * 系统临时目录（/tmp、os.tmpdir()）算临时目录，不查敏感文件（新检出的 worktree 里没有密钥文件；
   * club 与 m9 的 6 次运行里 stage-qa 被拦 33 次，全是 rg 的排除通配、printenv PORT 之类与 mktemp -d /tmp/…）
   */
  isolatedWorkspace?: boolean;
  /** 隔离工作区里也可以读、运行的技能目录（playwright-browser：stage-qa 的角色提示让它读这里的说明、运行这里的脚本） */
  toolDirs?: readonly string[];
  homeDir?: string;
}

/** 扩展工具（codegraph 等）中被视为路径的参数名 */
export const DEFAULT_PATH_KEYS = ['path', 'paths', 'relative_path', 'file', 'files', 'file_path', 'filepath', 'filename', 'dir', 'directory', 'target'];

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const DEV_FILES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const OUTPUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);
const INPUT_OPS = new Set(['<', '<>', '<&']);

/**
 * 实施类角色（bash: full）的 bash 按禁止列表检查，列表之外的一律放行；写进工作区里的东西由提交时的 diff 检查兜底。禁止的是：
 *  1. 写到工作区之外：重定向、下载、tee、sed -i、rm/mv/cp 的目标在主工作区或受保护路径（rm/mv/cp 另限于临时目录与本任务可改的文件）；
 *  2. 读敏感文件、打印全部环境变量（点名的 printenv PORT 放行）；
 *  3. 改写 git 历史与引用、推送、拉取、切换分支、改 git 配置（GIT_IMPL_FORBIDDEN 与 checkGitImpl）；
 *  4. 后台运行或脱离超时管理（&、setsid、disown）；
 *  5. 打开桌面应用或浏览器窗口；
 *  6. 远程连接、提权（下表）。
 * 判断不了的（解析不了的命令、命令名或参数含变量、sh -c 或 eval 的内容含变量）放行。
 * 只提醒、不拦：依赖目录链接到共享构建环境时直接用包管理器改依赖；uv 管理的 Python 项目里用 pip 装包。
 */
const IMPL_FORBIDDEN: Record<string, string> = {
  ssh: '禁止远程连接', scp: '禁止远程连接', sftp: '禁止远程连接', sudo: '禁止提权', su: '禁止提权', doas: '禁止提权',
  setsid: '新会话中的进程不受超时管理，请前台运行；要一直运行的服务用 forge_service', disown: '后台进程不受超时管理，请前台运行；要一直运行的服务用 forge_service',
};
/**
 * 会打开桌面应用或浏览器窗口的命令：agent 只写代码、跑测试，看效果交给用户（ZCode 实测：验收者反复拉起用户的桌面端）。
 * 无界面（headless）的浏览器测试照常由测试命令运行；项目自己的启动命令写在 commands.yaml 的 gui_commands。
 */
const GUI_BINARIES = new Set(['open', 'xdg-open', 'osascript', 'electron', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'firefox', 'msedge']);
const GUI_SUBCOMMANDS: Record<string, readonly string[]> = { playwright: ['open', 'codegen', 'show-report', 'show-trace'], cypress: ['open'], gio: ['open'] };
export const GUI_REASON = '不能启动桌面应用或打开浏览器窗口：你只写代码、跑测试（无界面的测试照常运行；要调接口就用 forge_service 启动 serve 命令后 curl http://localhost:<端口>/…）。页面由 stage-qa 在无界面浏览器里检查；只能靠人眼判断的写进 handoff（验收时用 manual 标给用户）。';

/** 命令（已剥离 sudo、env 等包装）是否会打开图形界面 */
export function opensGui(words: readonly string[], projectCommands: readonly string[] = []): boolean {
  const base = (w: string) => path.basename(w);
  if (!words.length) return false;
  if (GUI_BINARIES.has(base(words[0]!))) return true;
  if (words.includes('--headed') || words.some((w) => w === '--ui' || w.startsWith('--ui='))) return true;
  // npx electron、pnpm exec playwright open 等：在参数里找界面程序
  for (let i = 0; i < words.length; i++) {
    const w = base(words[i]!);
    if (i > 0 && w === 'electron') return true;
    const subs = GUI_SUBCOMMANDS[w];
    if (subs && subs.includes(words[i + 1] ?? '')) return true;
  }
  const line = scriptLine(words);
  return projectCommands.some((c) => { const p = scriptLine(c.trim().split(/\s+/)); return !!p && (line === p || line.startsWith(`${p} `) || line.startsWith(`${p}:`)); });
}

/** package.json 脚本里会打开界面的写法（electron-builder 等打包命令不算） */
const GUI_SCRIPT = /(^|[\s"'&|;(])(electron(?![-\w])|electron-vite\s+(dev|preview)|electron-forge\s+start|tauri\s+dev|expo\s+start|react-native\s+run-|cypress\s+open|playwright\s+(open|codegen)|xdg-open|open\s+(-a\s|https?:)|--headed|--open\b)/;
/** 脚本调用的 node 文件里拉起界面的写法 */
const GUI_FILE = /(spawn\w*|exec\w*)\(\s*['"`]electron['"`]|require\(\s*['"]electron['"]\s*\)|from\s+['"]electron['"]|new\s+BrowserWindow\b|headless:\s*false/;
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_CHANGES = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'ci', 'dedupe', 'prune', 'link', 'unlink', 'sync']);
/** 会改依赖目录的包管理器命令（npm install、pnpm add、yarn remove、pip install、uv add 等）；只认简单写法 */
/** pip install、python -m pip install、uv pip install（含 pip3、uv pip sync） */
export function pipInstall(words: readonly string[]): boolean {
  const w = words.map((x) => path.basename(x));
  const at = (i: number) => w[i] ?? '';
  if (/^pip3?(\.\d+)?$/.test(at(0))) return at(1) === 'install';
  if (/^python3?(\.\d+)?$/.test(at(0)) && at(1) === '-m' && /^pip3?$/.test(at(2))) return at(3) === 'install';
  if (at(0) === 'uv' && at(1) === 'pip') return at(2) === 'install' || at(2) === 'sync';
  return false;
}

export function changesDeps(words: readonly string[]): boolean {
  const bin = path.basename(words[0] ?? '');
  const sub = words.slice(1).find((w) => !w.startsWith('-'));
  if (RUNNERS.has(bin)) return !!sub && PM_CHANGES.has(sub);
  if (bin === 'pip' || bin === 'pip3' || bin === 'uv' || bin === 'poetry') return !!sub && PM_CHANGES.has(sub);
  return false;
}
const RUNNER_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'exec', 'dlx', 'x', 'ci', 'why', 'list', 'ls', 'outdated', 'update', 'link', 'publish', 'pack']);

/**
 * npm、pnpm、yarn、bun 运行的 package.json 脚本是否会打开界面：看脚本本身、它调用的同包脚本、以及 node 运行的文件（最多 4 层）。
 * 只认简单写法（runner [run] <脚本>）；pnpm --filter 等跨包写法交给 commands.yaml 的 gui_commands。
 */
export function scriptOpensGui(words: readonly string[], cwd: string, stopAt: string): boolean {
  if (!RUNNERS.has(path.basename(words[0] ?? ''))) return false;
  const rest = words.slice(1);
  const name = rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0];
  if (!name || name.startsWith('-') || RUNNER_BUILTINS.has(name)) return false;
  let dir = path.resolve(cwd);
  let pkgFile = '';
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json'))) { pkgFile = path.join(dir, 'package.json'); break; }
    if (dir === stopAt || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  if (!pkgFile) return false;
  let scripts: Record<string, string>;
  try { scripts = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { return false; }
  const seen = new Set<string>();
  const visit = (script: string, depth: number): boolean => {
    const body = scripts[script];
    if (!body || seen.has(script) || depth > 4) return false;
    seen.add(script);
    if (GUI_SCRIPT.test(body)) return true;
    for (const m of body.matchAll(/(?:^|[\s"'&|;(])node\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:m?js|cjs|ts|mts))/g)) {
      try { if (GUI_FILE.test(readFileSync(path.resolve(dir, m[1]!), 'utf8'))) return true; } catch { /* 文件不存在：不算 */ }
    }
    for (const m of body.matchAll(/(?:^|[\s"'&|;(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.@/-]+)/g)) if (visit(m[1]!, depth + 1)) return true;
    return false;
  };
  return visit(name, 0);
}

/** pnpm run dev 与 pnpm dev 视为同一条命令 */
function scriptLine(words: readonly string[]): string {
  const w = words.filter(Boolean);
  if (w.length > 2 && ['npm', 'pnpm', 'yarn', 'bun'].includes(path.basename(w[0]!)) && w[1] === 'run') return [w[0], ...w.slice(2)].join(' ');
  return w.join(' ');
}

/**
 * curl、wget 会写到哪些本地文件（所有角色都可以联网，只管写文件）。纯函数。
 * 返回写入的目标（选项的值）；dirs 为下载目录（curl -O 或 wget 不指定 -O 时写进当前目录，值为 '.'）。
 * 值为 - 或 /dev/null 的不算写文件。
 */
const CURL_WRITE_LONG = new Set(['--output', '--dump-header', '--cookie-jar', '--trace', '--trace-ascii', '--libcurl', '--stderr']);
const CURL_DIR_LONG = new Set(['--output-dir']);
const CURL_REMOTE_NAME = new Set(['--remote-name', '--remote-name-all']);
/** curl 带参数的短选项：簇里遇到它，后面的字符（或下一个参数）是它的值 */
const CURL_ARG_SHORT = new Set([...'AbcCdDeEFHKmoPQrTtuUwxXyYz']);
const CURL_WRITE_SHORT = new Set([...'oDc']);
const WGET_WRITE_LONG = new Set(['--output-document', '--output-file', '--append-output']);
const WGET_DIR_LONG = new Set(['--directory-prefix']);
const WGET_ARG_SHORT = new Set([...'OoaPeiBtTwQUlARDIX']);
const WGET_WRITE_SHORT = new Set([...'Ooa']);
const NOT_A_FILE = (v: string) => v === '-' || DEV_FILES.has(v);

export function downloadTargets(name: 'curl' | 'wget', args: readonly string[]): { files: string[]; dirs: string[] } {
  const curl = name === 'curl';
  const [writeLong, dirLong, argShort, writeShort] = curl
    ? [CURL_WRITE_LONG, CURL_DIR_LONG, CURL_ARG_SHORT, CURL_WRITE_SHORT]
    : [WGET_WRITE_LONG, WGET_DIR_LONG, WGET_ARG_SHORT, WGET_WRITE_SHORT];
  const files: string[] = [];
  const dirs: string[] = [];
  let remoteName = false;
  let document = false;
  let dirSet = false;
  let spider = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if (a.startsWith('--')) {
      const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      if (CURL_REMOTE_NAME.has(flag!) && curl) { remoteName = true; continue; }
      if (flag === '--spider' && !curl) { spider = true; continue; }
      if (writeLong.has(flag!) || dirLong.has(flag!)) {
        const v = inline ?? args[++i] ?? '';
        if (dirLong.has(flag!)) { dirs.push(v); dirSet = true; } else if (!NOT_A_FILE(v)) files.push(v);
        if (flag === '--output-document') document = true;
      }
      continue;
    }
    if (!a.startsWith('-') || a === '-') continue;
    for (let j = 1; j < a.length; j++) {
      const ch = a[j]!;
      if (curl && ch === 'O') { remoteName = true; continue; }
      if (!argShort.has(ch)) continue;
      const v = j + 1 < a.length ? a.slice(j + 1) : args[++i] ?? '';
      if (ch === 'P' && !curl) { dirs.push(v); dirSet = true; }
      else if (writeShort.has(ch)) { if (!NOT_A_FILE(v)) files.push(v); if (ch === 'O') document = true; }
      break;
    }
  }
  if (curl ? remoteName && !dirSet : !document && !spider && !dirSet) dirs.push('.');
  return { files, dirs };
}

/** 实施类角色可以对临时目录与任务 writes 内的文件使用的文件操作 */
const FILE_OPS = new Set(['rm', 'mv', 'cp', 'rmdir']);
const READONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'git', 'pwd', 'echo', 'printf', 'tree', 'file',
  'stat', 'du', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'jq', 'which', 'basename', 'dirname', 'realpath', 'true', 'false',
  'test', '[', 'nl', 'column', 'comm', 'shasum', 'sha256sum', 'md5', 'md5sum', 'xxd', 'hexdump', 'od', 'date', 'cd',
]);
const GIT_READONLY = new Set([
  'log', 'show', 'diff', 'status', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'cat-file', 'grep', 'shortlog', 'describe',
  'merge-base', 'name-rev', 'rev-list', 'show-ref', 'branch',
]);
const GIT_IMPL_FORBIDDEN: Record<string, string> = {
  rebase: '改写历史', 'filter-branch': '改写历史', 'filter-repo': '改写历史', 'update-ref': '改写引用', replace: '改写历史',
  switch: '切换分支', worktree: '操作 worktree', clean: '删除未跟踪文件', push: '推送由引擎在合并时完成',
  fetch: '远程分支由引擎同步', pull: '远程分支由引擎同步', remote: '修改远程配置', tag: '修改共享标签',
};
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'builtin', 'exec', 'nice', 'timeout', 'stdbuf', 'xargs']);

const SYSTEM_TMP = [...new Set(['/tmp', tmpdir()].map((d) => realpathSafe(d)))];

const ok: GuardDecision = { allow: true };
// stock run-04：stage-qa 用 env | grep PORT 找端口被拦 3 次
const ENV_DENIED = '禁止打印全部环境变量（可能含密钥）。查看某个变量用 printenv 加变量名，例如 printenv PORT。';
const deny = (rule: GuardRule, reason: string): GuardDecision => ({ allow: false, rule, reason });

type Area = { area: 'workspace' | 'main' | 'scratch' | 'outside'; abs: string; rel: string };

class Evaluator {
  readonly ctx: GuardContext;
  readonly role: ResolvedRole;
  readonly ws: string;
  readonly main: string;
  readonly home: string;
  readonly scratch: string | null;

  constructor(ctx: GuardContext) {
    this.ctx = ctx;
    this.role = ctx.config.role(ctx.role);
    this.ws = realpathSafe(ctx.workspaceRoot);
    this.main = realpathSafe(ctx.mainRoot);
    this.home = ctx.homeDir ?? homedir();
    this.scratch = ctx.scratchDir ? realpathDeep(path.resolve(ctx.scratchDir)) : null;
  }

  /** 受保护路径判断（不区分大小写，目录本身也算，如 worktree 里的 .git 文件）；rulesWritable 时 rules/** 除外 */
  isProtectedRel(rel: string): boolean {
    if (!isProtectedNocase(rel) && !isProtectedNocase(`${rel}/_`)) return false;
    return !(this.ctx.rulesWritable && matchesAny(rel.toLowerCase(), ['rules/**']));
  }

  get isOrchestrator() { return this.role.name === 'orchestrator'; }

  /** 命令文本里出现主工作区绝对路径（后面是路径分隔、引号、空白或结尾，不误伤 <项目>.worktrees/ 下的工作区）；与工作区相同时为 null */
  mainPathPattern(): RegExp | null {
    const roots = [...new Set([this.main, path.resolve(this.ctx.mainRoot)])].filter((r) => r !== this.ws && r !== path.resolve(this.ctx.workspaceRoot));
    if (!roots.length) return null;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(${roots.map(esc).join('|')})(?=$|[/'"\\s;)&|])`);
  }
  get isReadonlyRole() { return !this.isOrchestrator && this.role.writes.length === 0; }

  /** 角色能用 write 工具写文件（只读档位 bash 的 architect 属于这种） */
  canWriteFiles(): boolean { return !this.isOrchestrator && !this.isReadonlyRole && this.role.tools.has('write'); }

  hint(): string {
    if (this.isOrchestrator) {
      return this.ctx.readyTaskId
        ? `你是调度者，不能直接修改代码。请用户执行 /forge next，或调用 forge_wait 等待结果。`
        : '你是调度者，不能直接修改代码。任务由程序派发给对应 subagent，用 forge_wait 等待结果。';
    }
    if (this.isReadonlyRole) return `你是只读角色（${this.role.name}），不能修改任何文件；结论请写进 forge_note 并 forge_submit。`;
    if (this.ctx.openWrites) return '实现与修复任务可以改工作区内任何文件，只有受保护路径（.forge/、.git/、workflow.yaml、rules/、.pi/）与用户的需求输入（docs/PRD.md、docs/prototype/）不能改。确需改动时用 forge_block 说明原因。';
    return `你是 ${this.role.name}，只能修改本任务 writes 内的文件；确需越界时调用 forge_block 说明原因，不要换一种方式再试。`;
  }

  /** 与 Pi 的 resolveToCwd 一致：Unicode 空格、去掉 @ 前缀、~、file://；再解析符号链接。 */
  resolveToolPath(input: string, cwd = this.ctx.cwd): string {
    let p = input.replace(UNICODE_SPACES, ' ');
    if (p.startsWith('@')) p = p.slice(1);
    if (p === '~') p = this.home;
    else if (p.startsWith('~/')) p = path.join(this.home, p.slice(2));
    if (/^file:\/\//.test(p)) p = fileURLToPath(p);
    return realpathDeep(path.resolve(cwd, p));
  }

  classify(abs: string): Area {
    const inScratch = this.scratch ? within(this.scratch, abs) : null;
    if (inScratch !== null) return { area: 'scratch', abs, rel: inScratch };
    const inWs = within(this.ws, abs);
    if (inWs !== null) return { area: 'workspace', abs, rel: inWs };
    const inMain = within(this.main, abs);
    if (inMain !== null) return { area: 'main', abs, rel: inMain };
    // 隔离工作区：系统临时目录算临时目录，别的任务的 worktree 除外（测试里项目本身也在系统临时目录下）；技能目录也可以用
    if (this.ctx.isolatedWorkspace && within(realpathSafe(worktreesRoot(this.ctx.mainRoot)), abs) === null) {
      for (const t of [...SYSTEM_TMP, ...(this.ctx.toolDirs ?? []).map((d) => realpathSafe(d))]) { const rel = within(t, abs); if (rel !== null) return { area: 'scratch', abs, rel }; }
    }
    return { area: 'outside', abs, rel: abs };
  }

  effectiveWrites(): string[] {
    return this.ctx.writes ?? this.role.writes;
  }

  /** 在本任务可写范围内（不含契约追加、merge-fix 的额外文件等例外） */
  inWrites(rel: string): boolean {
    return (this.ctx.openWrites ? openWriteAllowed(rel) : matchesAny(rel, this.effectiveWrites())) && matchesAny(rel, this.role.writes);
  }

  checkWrite(rawPath: string, tool: string, cwd?: string): GuardDecision {
    const a = this.classify(this.resolveToolPath(rawPath, cwd));
    if (a.area === 'scratch') return this.isReadonlyRole || this.isOrchestrator ? deny('write_paths', `只读角色不能写文件。${this.hint()}`) : ok;
    if (a.area === 'main') return deny('write_paths', `不能写主工作区（${a.rel}），只能修改当前 worktree 内的文件。${this.hint()}`);
    if (a.area === 'outside') return deny('write_paths', `只能写当前 worktree 内的文件，${a.abs} 在其外。${this.hint()}`);
    const writes = this.effectiveWrites();
    const inTask = this.inWrites(a.rel)
      || (!!this.ctx.interfaceAdditions && matchesAny(a.rel.toLowerCase(), [INTERFACES_PATH]))
      || (this.ctx.extraWritable?.includes(a.rel) ?? false);
    if (!inTask) {
      if (this.ctx.openWrites) return deny('write_paths', `${a.rel} 不能改，${tool} 被阻断。${this.hint()}`);
      return deny('write_paths', `${a.rel} 不在本任务可写范围内（${writes.join(', ') || '无'}）。${tool} 被阻断。${this.hint()}`);
    }
    if (this.isProtectedRel(a.rel)) {
      return deny('protected', `${a.rel} 是受保护路径，对所有 agent 只读（${protectedGlobs().filter((g) => !(this.ctx.rulesWritable && g === 'rules/**')).join('、')}）。`);
    }
    return ok;
  }

  checkSensitive(rawPath: string, cwd?: string): GuardDecision {
    if (this.ctx.isolatedWorkspace) return ok;
    const a = this.classify(this.resolveToolPath(rawPath, cwd));
    if (isSensitiveRel(a.rel)) return deny('sensitive', `禁止读取敏感文件 ${a.rel}（.env*、*.pem、secrets/**）。`);
    return ok;
  }

  /** 隔离工作区：绝对路径、~、含 .. 的路径必须仍在工作区（或临时目录）内；任何位置的 .forge/ 都不允许 */
  checkIsolatedPath(text: string, cwd = this.ctx.cwd): GuardDecision {
    if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !text.startsWith('file://')) return ok;
    const pathLike = text.startsWith('/') || text.startsWith('~') || text.startsWith('file://') || /(^|\/)\.\.(\/|$)/.test(text) || /(^|\/)\.forge(\/|$)/.test(text);
    if (!pathLike || DEV_FILES.has(text) || /^\/dev\/fd\/\d+$/.test(text)) return ok;
    const a = this.classify(this.resolveToolPath(text, cwd));
    if (a.area !== 'workspace' && a.area !== 'scratch') return deny('read_paths', `隔离工作区之外的路径不能访问：${text}。只在当前工作区与临时目录里工作。`);
    if (a.area === 'workspace' && /(^|\/)\.forge(\/|$)/.test(a.rel)) return deny('read_paths', `不能访问 .forge/：${text}`);
    return ok;
  }

  run(call: ToolCall): GuardDecision {
    const { toolName: tool, input } = call;
    // 1. 工具白名单
    if (!this.role.tools.has(tool)) {
      return deny('tool_whitelist', this.isOrchestrator ? this.hint() : `角色 ${this.role.name} 无权使用工具 ${tool}。${this.hint()}`);
    }
    // forge_service 直接给出的命令与 bash 命令同样检查（后台运行由 forge_service 自己管，不算）
    if (tool === 'forge_service' && typeof input['command'] === 'string') return new BashChecker(this).check(input['command'], this.ctx.cwd);
    const kind = this.ctx.config.toolKind(tool);
    const builtin = (BUILTIN_READ_TOOLS as readonly string[]).includes(tool) || (BUILTIN_WRITE_TOOLS as readonly string[]).includes(tool);
    const paths = extractPaths(input, builtin ? ['path'] : DEFAULT_PATH_KEYS);

    if (this.ctx.isolatedWorkspace) {
      for (const p of paths) {
        const d = this.checkIsolatedPath(p.startsWith('/') || p.startsWith('~') || p.startsWith('file://') ? p : `./${p}`);
        if (!d.allow) return d;
      }
    }
    if (kind === 'read' || kind === 'ext-read') {
      for (const p of paths) {
        const s = this.checkSensitive(p);
        if (!s.allow) return s;
      }
      // find 的 pattern、grep 的 glob 是文件名模式
      for (const key of ['pattern', 'glob'] as const) {
        const v = input[key];
        if (!this.ctx.isolatedWorkspace && ((tool === 'find' && key === 'pattern') || (tool === 'grep' && key === 'glob'))) {
          if (typeof v === 'string' && sensitiveGlob(v)) return deny('sensitive', `禁止搜索敏感文件（${v}）。`);
        }
      }
      return ok;
    }
    if (kind === 'write') {
      // 2 + 3. 写路径白名单与受保护路径
      for (const p of paths) {
        const d = this.checkWrite(p, tool);
        if (!d.allow) return d;
      }
      return ok;
    }
    if (kind === 'bash') {
      const command = input['command'];
      if (typeof command !== 'string') return deny('bash', 'bash 调用缺少 command 参数');
      return new BashChecker(this).check(command, this.ctx.cwd);
    }
    return ok;
  }
}

class BashChecker {
  private readonly ev: Evaluator;
  private readonly readonly: boolean;

  constructor(ev: Evaluator) {
    this.ev = ev;
    this.readonly = ev.role.bash === 'readonly' || ev.role.bash === 'allowlist';
  }

  private allowedCache: string[][] | null = null;
  /** bash_allow 引用的命令拆成的简单命令（词序列，{files} 占位及之后的部分去掉） */
  private allowed(): string[][] {
    if (!this.allowedCache) this.allowedCache = allowlistPrefixes(this.ev.role.bashAllow.map((n) => this.ev.ctx.config.commands[n] ?? '').filter(Boolean));
    return this.allowedCache;
  }

  check(command: string, startCwd: string, depth = 0): GuardDecision {
    // 只读角色判断不了就拦；实施角色判断不了的放行（写进工作区的东西由提交时的 diff 检查兜底）
    if (depth > 4) return this.readonly ? deny('bash', '嵌套的 shell 层数过多，无法校验') : ok;
    const parsed = parseShell(command);
    if (parsed.errors.length) return this.readonly ? deny('bash', `无法解析的命令（${parsed.errors[0]}），已阻断。请改写为简单命令。`) : ok;
    // 后台运行的进程脱离 bash 超时的管理，结束外层后会留下孤儿进程（真实冒烟：死循环的测试在后台堆积，占满 CPU）
    if (parsed.background) return deny('bash', `禁止把命令放到后台运行（&）：后台进程不受超时管理，容易留下一直运行的孤儿进程。请前台运行；需要限时就给 bash 调用设置 timeout。${this.ev.role.tools.has('forge_service') ? '要一直运行的服务（开发服务器、数据库）用 forge_service start 启动 commands 里的 serve 命令（ready 参数可以等端口就绪），运行结束时程序会结束它。' : ''}`);
    let cwd = startCwd;
    // 同一条命令中先用字面量赋值的变量（例如 D=/tmp/x; cp a $D/b），在校验时代入；其余变量仍按无法校验处理
    const vars = new Map<string, string>();
    const warnings: string[] = [];
    for (const raw of parsed.commands) {
      // 命令替换里的命令（nested）也能看到外层已赋值的变量：ID=$(curl $B/boards ...)
      const cmd = substituteVars(raw, vars);
      if (!cmd.nested && !cmd.words.length) {
        for (const a of cmd.assignments) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a.text);
          if (m) { if (a.dynamic) vars.delete(m[1]!); else vars.set(m[1]!, m[2]!); }
        }
      }
      const r = this.checkCommand(cmd, cmd.nested ? startCwd : cwd, depth);
      if (!r.decision.allow) return r.decision;
      if (r.decision.warning && !warnings.includes(r.decision.warning)) warnings.push(r.decision.warning);
      if (r.cwd && !cmd.nested) cwd = r.cwd;
    }
    return warnings.length ? { allow: true, warning: warnings.join('\n') } : ok;
  }

  private checkCommand(cmd: SimpleCommand, cwd: string, depth: number): { decision: GuardDecision; cwd?: string } {
    const red = this.checkRedirects(cmd, cwd);
    if (!red.allow) return { decision: red };

    let words = cmd.words;
    // 剥离包装命令
    for (;;) {
      const name = words[0];
      if (!name) return { decision: ok };
      if (name.dynamic || name.glob) {
        if (this.readonly) return { decision: deny('bash', `命令名 ${name.text} 含变量或通配，无法校验，已阻断`) };
        // 实施角色：不在禁止列表里，只查参数里的敏感文件
        for (const w of words.slice(1)) { const s = this.sensitiveWord(w, cwd); if (!s.allow) return { decision: s }; }
        return { decision: ok };
      }
      const base = path.basename(name.text);
      if (!WRAPPERS.has(base)) break;
      if (this.readonly && !['xargs', 'command', 'time'].includes(base)) {
        return { decision: deny('bash', `只读角色不能使用 ${base}。${this.ev.hint()}`) };
      }
      if (base === 'sudo') return { decision: deny('bash', `禁止使用 sudo：${IMPL_FORBIDDEN['sudo']}。`) };
      const rest = stripWrapper(base, words.slice(1));
      if (!rest.length && base === 'env') return { decision: deny('sensitive', ENV_DENIED) };
      words = rest;
    }
    const name = path.basename(words[0]!.text);
    const args = words.slice(1);

    // 嵌套 shell：递归校验 -c 内容
    if (SHELLS.has(name)) {
      const ci = args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text));
      if (ci >= 0) {
        const inner = args[ci + 1];
        if (!inner) return { decision: this.readonly ? deny('bash', `${name} -c 缺少内容`) : ok };
        if (inner.dynamic) return { decision: this.readonly ? deny('bash', `${name} -c 的内容含变量，无法校验`) : ok };
        return { decision: this.check(inner.text, cwd, depth + 1) };
      }
      if (this.readonly) return { decision: deny('bash', `只读角色不能执行脚本。${this.ev.hint()}`) };
    }

    // 点名查看（printenv PORT）放行，只拦打印全部：stage-qa 反复用 printenv PORT FORGE_DB_NAME 查端口与库名
    if (['printenv', 'set', 'export', 'declare'].includes(name) && (name === 'printenv' ? args.every((w) => w.text.startsWith('-')) : args.length === 0 || args[0]?.text === '-p')) {
      return { decision: deny('sensitive', ENV_DENIED) };
    }

    // 5. 敏感读取（参数）
    for (const w of args) {
      const s = this.sensitiveWord(w, cwd);
      if (!s.allow) return { decision: s };
    }

    // 隔离工作区：参数里的路径不能越出工作区，也不能碰 .forge/；
    // 内联脚本（node -e、python -c 等）里写死主工作区的绝对路径同样拦下
    if (this.ev.ctx.isolatedWorkspace) {
      const mainRef = this.ev.mainPathPattern();
      if (mainRef) for (const w of words) {
        if (mainRef.test(w.text)) return { decision: deny('read_paths', `不能在命令里引用主工作区的路径：${w.text.slice(0, 200)}。只在当前工作区与临时目录里工作。`) };
      }
      for (const w of args) {
        const d = this.ev.checkIsolatedPath(w.text.includes('=') && w.text.startsWith('-') ? w.text.slice(w.text.indexOf('=') + 1) : w.text, cwd);
        if (!d.allow) return { decision: d };
      }
    }

    if (name === 'cd' || name === 'pushd') return this.checkCd(args, cwd);

    const texts = words.map((w) => w.text);
    if (opensGui(texts, this.ev.ctx.config.guiCommands) || scriptOpensGui(texts, cwd, this.ev.ws)) return { decision: deny('bash', GUI_REASON) };

    // allowlist 档位：bash_allow 引用的项目命令按前缀匹配放行
    if (this.ev.role.bash === 'allowlist' && allowedByList(words, this.allowed())) return { decision: ok };
    if (this.readonly) return { decision: this.checkReadonly(name, args) };

    // 4. 实施类角色的 bash 约束；rm、mv、cp、rmdir 只能作用于临时目录与本任务 writes 内的文件
    if (FILE_OPS.has(name)) return { decision: this.checkFileOps(name, args, cwd) };
    // 联网不限；stage-qa 在用完即删的临时 worktree 里，curl、wget 不另加限制。实施角色下载写到哪里，与重定向同样检查
    if (name === 'curl' || name === 'wget') {
      if (this.ev.ctx.isolatedWorkspace) return { decision: ok };
      return { decision: this.checkDownload(name, args, cwd) };
    }
    if (changesDeps(texts) && linkedDeps(this.ev.ctx.mainRoot, this.ev.ctx.config, this.ev.ws).length) {
      return { decision: { allow: true, warning: '[pi-forge] 依赖目录是共享构建环境的链接，在这里安装、升级或删除依赖会影响别的任务。缺依赖用 forge_add_dependency(name, version?)；要升级、删除或改动已有依赖的版本，先改好依赖清单再调用 forge_private_deps。' } };
    }
    if (pipInstall(texts) && existsSync(path.join(this.ev.ws, 'uv.lock'))) {
      return { decision: { allow: true, warning: '[pi-forge] 这是用 uv 管理的项目：pip 装的包不会记进 pyproject.toml 与 uv.lock，别的任务和合并后都没有它。加依赖用 uv add <包>（开发依赖 uv add --dev <包>）。' } };
    }
    if (name in IMPL_FORBIDDEN) return { decision: deny('bash', `禁止使用 ${name}：${IMPL_FORBIDDEN[name]}。`) };
    // 会写文件的 tee、sed -i、perl -i：参数里的路径不能在主工作区或受保护路径（脚本表达式当作工作区内的路径，自然放行）
    const inPlace = ((name === 'sed' || name === 'gsed') && args.some((w) => /^-[^-]*i/.test(w.text) || w.text.startsWith('--in-place')))
      || (name === 'perl' && args.some((w) => /^-[^-]*i/.test(w.text)));
    if (name === 'tee' || inPlace) {
      for (const w of args) {
        if (w.dynamic || w.glob || w.text.startsWith('-')) continue;
        const d = this.checkOutputPath(w.tilde ? path.join(this.ev.home, w.text.slice(1)) : w.text, cwd);
        if (!d.allow) return { decision: d };
      }
      return { decision: ok };
    }
    if (name === 'eval') {
      if (args.some((w) => w.dynamic)) return { decision: ok };
      return { decision: this.check(args.map((w) => w.text).join(' '), cwd, depth + 1) };
    }
    if (name === 'git') return { decision: this.checkGitImpl(args) };
    if (name === 'find') return { decision: this.checkFind(args, cwd, depth) };
    return { decision: ok };
  }

  private checkRedirects(cmd: SimpleCommand, cwd: string): GuardDecision {
    for (const r of cmd.redirects) {
      if (r.fdDup || r.op === '<<' || r.op === '<<-' || r.op === '<<<') continue;
      const t = r.target;
      if (INPUT_OPS.has(r.op)) {
        const s = this.sensitiveWord(t, cwd);
        if (!s.allow) return s;
        if (r.op !== '<>') continue;
      }
      if (!OUTPUT_OPS.has(r.op)) continue;
      if (t.dynamic || t.glob) {
        if (this.readonly) return deny('bash', `重定向目标 ${t.text} 含变量或通配，无法校验，已阻断`);
        continue;
      }
      const target = t.tilde ? path.join(this.ev.home, t.text.slice(1)) : t.text;
      if (DEV_FILES.has(target) || /^\/dev\/fd\/\d+$/.test(target)) continue;
      if (this.readonly) return deny('bash', `只读角色不能重定向输出到文件（${t.text}）。${this.ev.hint()}`);
      const d = this.checkOutputPath(target, cwd);
      if (!d.allow) return d;
    }
    return ok;
  }

  /** 实施角色写到某个路径：不能写主工作区与受保护路径（重定向、下载共用） */
  private checkOutputPath(target: string, cwd: string): GuardDecision {
    const a = this.ev.classify(realpathDeep(path.resolve(cwd, target)));
    if (a.area === 'main') return deny('bash', `不能写主工作区（${a.rel}）。${this.ev.hint()}`);
    if (a.area === 'workspace' && this.ev.isProtectedRel(a.rel)) return deny('protected', `${a.rel} 是受保护路径，对所有 agent 只读。`);
    return ok;
  }

  /** curl、wget：只读角色不能写文件（输出到标准输出或 /dev/null）；实施角色的下载目标按写路径检查 */
  private checkDownload(name: 'curl' | 'wget', args: readonly Word[], cwd: string): GuardDecision {
    if (this.readonly && args.some((w) => w.dynamic && /^-/.test(w.text))) return deny('bash', `${name} 的选项含变量，无法确定会不会写文件，已阻断。`);
    const t = downloadTargets(name, args.map((w) => w.text));
    const outs = [...t.files, ...t.dirs.map((d) => path.join(d, 'x'))];
    if (this.readonly && outs.length) {
      return deny('bash', `只读角色的 ${name} 不能把内容写进文件（${[...t.files, ...t.dirs].join('、')}）：去掉 -o/-O，或输出到标准输出、/dev/null${name === 'wget' ? '（wget -qO- <URL>）' : ''}。`);
    }
    for (const o of outs) {
      if (/\$|`/.test(o)) continue;
      const d = this.checkOutputPath(o.startsWith('~') ? path.join(this.ev.home, o.slice(1)) : o, cwd);
      if (!d.allow) return d;
    }
    return ok;
  }

  private checkFileOps(name: string, args: Word[], cwd: string): GuardDecision {
    const targets = args.filter((w) => !w.text.startsWith('-') || w.dynamic);
    // cp 的源文件只读（已做敏感检查），只校验目标；其余命令校验全部路径
    const checked = name === 'cp' ? targets.slice(-1) : targets;
    const scratchHint = this.ev.scratch ? `临时文件请放在临时目录 ${this.ev.scratch}。` : '';
    for (const w of checked) {
      // 位置判断不了的（参数含变量、经 xargs 传入）放行；通配（rm -rf dist/*）按模式本身判断位置与可改范围
      if (w.dynamic) continue;
      // 会匹配隐藏文件的通配（.*）可能删到 .git 等受保护路径
      if (w.glob && /(^|\/)\.[^/]*[*?[]/.test(w.text) && protectedGlobs().some((g) => globsOverlap(w.text, g))) {
        return deny('protected', `${name} 的通配 ${w.text} 会匹配受保护路径（.git、.forge 等），已阻断。请写出具体路径。`);
      }
      const a = this.ev.classify(realpathDeep(path.resolve(cwd, w.tilde ? path.join(this.ev.home, w.text.slice(1)) : w.text)));
      if (a.area === 'scratch') continue;
      if (a.area !== 'workspace') return deny('bash', `${name} 只能作用于临时目录或本任务 writes 内的文件，${w.text} 不在其中。${scratchHint}`);
      const writes = this.ev.effectiveWrites();
      if (this.ev.isProtectedRel(a.rel)) return deny('protected', `${a.rel} 是受保护路径，对所有 agent 只读。`);
      // 未被 git 跟踪的文件（之前运行留下的临时文件）可以删除：删除它们不会改动仓库内容
      if ((name === 'rm' || name === 'rmdir') && a.rel !== '.' && untracked(this.ev.ws, a.rel)) continue;
      if (!this.ev.inWrites(a.rel)) {
        if (this.ev.ctx.openWrites) return deny('bash', `${name} 不能作用于 ${a.rel}。${this.ev.hint()}`);
        return deny('bash', `${name} 只能作用于本任务 writes 内的文件（${writes.join(', ') || '无'}），${a.rel} 不在其中。${scratchHint}`);
      }
    }
    return ok;
  }

  /** cd 不拦，只跟踪之后的相对路径按哪个目录解析；目标判断不了（cd -、含变量）时沿用原目录 */
  private checkCd(args: Word[], cwd: string): { decision: GuardDecision; cwd?: string } {
    const target = args.find((w) => !w.text.startsWith('-') || w.text === '-');
    if (!target || target.tilde && target.text === '~') return { decision: ok, cwd: this.ev.home };
    if (target.text === '-' || target.dynamic) return { decision: ok };
    return { decision: ok, cwd: realpathDeep(path.resolve(cwd, target.tilde ? path.join(this.ev.home, target.text.slice(1)) : target.text)) };
  }

  private checkReadonly(name: string, args: Word[]): GuardDecision {
    const no = (why: string) => deny('bash', `只读角色不能执行该命令（${why}）。${this.ev.hint()}`);
    // 有 write 工具的只读档位角色（architect）要删除或改名 writes 内的文件：给出可行的做法
    if ((name === 'rm' || name === 'mv' || name === 'git' && ['rm', 'mv'].includes(args.find((w) => !w.text.startsWith('-'))?.text ?? '')) && this.ev.canWriteFiles()) {
      return deny('bash', `只读档位不能执行 ${name === 'git' ? 'git rm / git mv' : name}。要删除或改名 writes 内的文件：用 write 在新路径写入内容，把不要的旧文件内容清空（写入空字符串）。空文件在契约检查与提交时视为不存在。`);
    }
    if (name === 'curl' || name === 'wget') return this.checkDownload(name, args, this.ev.ctx.cwd);
    // 按行号读文件片段与语法检查不写文件（stock run-04：reviewer 的 sed -n '1,60p' 被拦 22 次、node --check 3 次）
    if (name === 'sed' && sedPrintsLines(args)) return ok;
    if (name === 'node' && ['--check', '-c'].includes(args[0]?.text ?? '') && args.length > 1 && args.every((w, i) => i === 0 || !w.text.startsWith('-'))) return ok;
    if (!READONLY_COMMANDS.has(name)) return no(name);
    const flags = args.map((w) => w.text);
    const positional = flags.filter((f) => !f.startsWith('-'));
    if (name === 'find' && flags.some((f) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(f))) return no(`find ${flags.find((f) => /^-(exec|execdir|ok|okdir|delete|fp|fl)/.test(f))}`);
    if (name === 'sort' && flags.some((f) => f === '-o' || f.startsWith('--output') || /^-[a-z]*o/.test(f))) return no('sort -o');
    if (name === 'tree' && flags.some((f) => f === '-o')) return no('tree -o');
    if ((name === 'uniq' || name === 'xxd') && positional.length >= 2) return no(`${name} 输出到文件`);
    if (name === 'date' && flags.some((f) => f === '-s' || f.startsWith('--set'))) return no('date -s');
    if (name === 'git') {
      const g = parseGit(args);
      // -C 与 cd 等价（cd 不拦）；--git-dir、--work-tree 仍拦
      const globals = g.globals.filter((x) => x !== '-C');
      if (globals.length) return no(`git ${globals[0]}`);
      if (!g.sub || !GIT_READONLY.has(g.sub)) return no(`git ${g.sub ?? ''}`);
      if (g.rest.some((w) => w.text.startsWith('--output') || w.text === '-o' && g.sub !== 'log')) return no('git --output');
      if (g.sub === 'branch' && g.rest.some((w) => !['-a', '-r', '-v', '-vv', '--list', '-l', '--show-current', '--all', '--remotes'].includes(w.text))) {
        return no('git branch 只能列出分支');
      }
    }
    return ok;
  }

  private checkGitImpl(args: Word[]): GuardDecision {
    const g = parseGit(args);
    if (g.globals.length) return deny('bash', `禁止使用 git ${g.globals[0]} 操作其他仓库或工作区。`);
    if (!g.sub) return ok;
    const rest = g.rest.map((w) => w.text);
    const why = GIT_IMPL_FORBIDDEN[g.sub];
    if (why) return deny('bash', `禁止 git ${g.sub}（${why}）。`);
    const dd = rest.indexOf('--');
    const beforeDd = dd >= 0 ? rest.slice(0, dd) : rest;
    switch (g.sub) {
      // 只拦改写 reflog 的子命令；不带子命令与 show、exists 只读（stock run-03：worker 查 git reflog 找回改动被拦）
      case 'reflog':
        if (['expire', 'delete', 'drop'].includes(beforeDd[0] ?? '')) return deny('bash', `禁止 git reflog ${beforeDd[0]}（改写 reflog）。`);
        return ok;
      case 'reset': {
        const okArgs = beforeDd.every((a) => a === '-q' || a === '--quiet' || (dd >= 0 && a === 'HEAD'));
        if (!okArgs) return deny('bash', '禁止 git reset 改写历史；取消暂存请用 git reset -- <文件>。');
        return ok;
      }
      case 'commit':
        if (rest.some((a) => a === '--amend' || a.startsWith('--fixup') || a.startsWith('--squash'))) return deny('bash', '禁止 git commit --amend 等改写历史的操作。');
        return ok;
      case 'checkout': {
        // 只允许 git checkout [<提交>] -- <文件>：按提交恢复文件，不会切换分支
        const positional = beforeDd.filter((a) => a !== '-q' && a !== '--quiet');
        if (dd < 0 || positional.length > 1 || positional.some((a) => a.startsWith('-'))) {
          return deny('bash', '禁止 git checkout 切换分支；恢复文件请用 git checkout [<提交>] -- <文件>。');
        }
        return ok;
      }
      case 'branch':
        if (rest.some((a) => !['-a', '-r', '-v', '-vv', '--list', '-l', '--show-current', '--all', '--remotes'].includes(a))) {
          return deny('bash', '禁止创建、删除、重命名分支；任务分支由引擎管理。');
        }
        return ok;
      case 'config':
        if (!rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a.startsWith('--get'))) {
          return deny('bash', '禁止修改 git 配置（worktree 与主仓库共享配置）。');
        }
        return ok;
      default:
        return ok;
    }
  }

  private checkFind(args: Word[], cwd: string, depth: number): GuardDecision {
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!.text;
      if (/^-(fprint|fprint0|fprintf|fls)$/.test(a)) {
        const t = args[k + 1];
        if (!t) continue;
        const area = this.ev.classify(realpathDeep(path.resolve(cwd, t.text)));
        if (t.dynamic || area.area === 'main' || (area.area === 'workspace' && this.ev.isProtectedRel(area.rel))) {
          return deny('bash', `find ${a} 的目标不允许：${t.text}`);
        }
      }
      if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
        const end = args.findIndex((w, j) => j > k && (w.text === ';' || w.text === '+'));
        const inner = args.slice(k + 1, end < 0 ? undefined : end);
        const r = this.checkCommand({ assignments: [], words: inner, redirects: [], nested: true }, cwd, depth + 1);
        if (!r.decision.allow) return r.decision;
      }
    }
    return ok;
  }

  private sensitiveWord(w: Word, cwd: string): GuardDecision {
    if (w.dynamic || this.ev.ctx.isolatedWorkspace) return ok;
    let text = w.text;
    const eq = text.startsWith('-') ? text.indexOf('=') : -1;
    if (text.startsWith('-')) {
      if (eq < 0) return ok;
      text = text.slice(eq + 1);
    }
    if (!text) return ok;
    if (w.tilde) text = path.join(this.ev.home, text.slice(1));
    if (w.glob) {
      return sensitiveGlob(text) ? deny('sensitive', `禁止读取敏感文件（${w.text}）。`) : ok;
    }
    return this.ev.checkSensitive(text, cwd);
  }
}

function stripWrapper(name: string, rest: Word[]): Word[] {
  let k = 0;
  const skipOpts = (withArg: Set<string>) => {
    while (k < rest.length && rest[k]!.text.startsWith('-')) {
      const t = rest[k]!.text;
      k += withArg.has(t) ? 2 : 1;
      if (t === '--') break;
    }
  };
  switch (name) {
    case 'env':
      skipOpts(new Set(['-u', '-C', '-S']));
      while (k < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[k]!.text)) k++;
      break;
    case 'sudo': skipOpts(new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'])); break;
    case 'nice': skipOpts(new Set(['-n'])); break;
    case 'timeout': skipOpts(new Set(['-s', '-k', '--signal', '--kill-after'])); k++; break;
    case 'stdbuf': skipOpts(new Set(['-i', '-o', '-e'])); break;
    case 'xargs': skipOpts(new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-i'])); break;
    default: skipOpts(new Set());
  }
  return rest.slice(k);
}

/** bash_allow 的命令拆成简单命令的词序列；{files} 等占位与之后的词去掉（调用时由 agent 补参数） */
export function allowlistPrefixes(commands: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const c of commands) {
    const parsed = parseShell(c);
    if (parsed.errors.length) continue;
    for (const sc of parsed.commands) {
      if (sc.nested) continue;
      const words = sc.words.map((w) => w.text);
      const cut = words.findIndex((w) => /\{[a-z_]+\}/.test(w));
      const prefix = cut >= 0 ? words.slice(0, cut) : words;
      if (prefix.length) out.push([...sc.assignments.map((a) => a.text), ...prefix]);
    }
  }
  return out;
}

/** 调用的词序列以某个允许的前缀开头（逐词相等） */
export function allowedByList(words: readonly Word[], prefixes: readonly string[][]): boolean {
  const texts = words.map((w) => w.text);
  return prefixes.some((p) => p.length <= texts.length && p.every((w, i) => texts[i] === w));
}

/** sed 的脚本只有按行号打印（sed -n '10,40p;$p' 文件）：不写文件、不执行命令；-i、w、e 等别的写法都不算 */
function sedPrintsLines(args: readonly Word[]): boolean {
  const scripts: Word[] = [];
  const operands: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === '-e') { const s = args[++i]; if (!s) return false; scripts.push(s); }
    else if (t.startsWith('-')) { if (!['-n', '--quiet', '--silent'].includes(t)) return false; }
    else operands.push(args[i]!);
  }
  if (!scripts.length && operands[0]) scripts.push(operands[0]);
  return scripts.length > 0 && scripts.every((s) => !s.dynamic && s.text.split(';').every((c) => !c.trim() || /^\s*(\d+|\$)(\s*,\s*(\d+|\$))?\s*p\s*$/.test(c)));
}

function parseGit(args: Word[]): { globals: string[]; sub: string | null; rest: Word[] } {
  const globals: string[] = [];
  let k = 0;
  while (k < args.length && args[k]!.text.startsWith('-')) {
    const t = args[k]!.text;
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { globals.push(t); k += 2; continue; }
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) globals.push(t.split('=')[0]!);
    if (t === '-c') { k += 2; continue; }
    k++;
  }
  return { globals, sub: args[k]?.text ?? null, rest: args.slice(k + 1) };
}

function extractPaths(input: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x) out.push(x);
  }
  return out;
}

function isProtectedNocase(rel: string): boolean {
  return isProtected(rel.toLowerCase());
}

function isSensitiveRel(rel: string): boolean {
  const segs = rel.toLowerCase().split('/');
  const baseName = segs.at(-1) ?? '';
  return baseName.startsWith('.env') || baseName.endsWith('.pem') || segs.slice(0, -1).includes('secrets') || baseName === 'secrets';
}

/** 文件名模式是否可能匹配敏感文件。按 shell 语义，未以 . 开头的模式不匹配点文件。 */
function sensitiveGlob(pattern: string): boolean {
  const segs = pattern.toLowerCase().split('/').filter(Boolean);
  const last = segs.at(-1) ?? '';
  if (segs.some((s) => s.includes('secret'))) return true;
  if (last.startsWith('.') && globsOverlap(last, '.env*')) return true;
  if (last === '*' || last === '**') return false;
  // 如 *.pem、*.p?m：按非点文件语义匹配
  return minimatch('key.pem', last);
}

/** 把只引用了已知字面量变量的词代入为静态文本；含命令替换、算术展开或未知变量的保持动态 */
function substituteVars(cmd: SimpleCommand, vars: ReadonlyMap<string, string>): SimpleCommand {
  if (!vars.size) return cmd;
  const sub = (w: Word): Word => {
    if (!w.dynamic || /\$\(|`/.test(w.text)) return w;
    let unknown = false;
    const text = w.text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
      const v = vars.get((a ?? b)!);
      if (v === undefined) { unknown = true; return _m; }
      return v;
    });
    return unknown || text.includes('$') ? w : { ...w, text, dynamic: false };
  };
  return { ...cmd, words: cmd.words.map(sub), redirects: cmd.redirects.map((r) => ({ ...r, target: sub(r.target) })), assignments: cmd.assignments.map(sub) };
}

/** 路径（文件或目录）在 worktree 中没有任何被 git 跟踪的文件 */
function untracked(ws: string, rel: string): boolean {
  try {
    return execFileSync('git', ['ls-files', '--', rel], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '';
  } catch {
    return false;
  }
}

function within(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function realpathSafe(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** 解析最近的已存在祖先的真实路径（处理符号链接与大小写），再拼回不存在的部分。 */
function realpathDeep(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSafe(cur), ...tail);
}

export function checkToolCall(call: ToolCall, ctx: GuardContext): GuardDecision {
  return new Evaluator(ctx).run(call);
}

export interface ViolationSink {
  recordViolation(v: {
    flow: string | null; task: string | null; run: string; role: string; tool: string; rule: string; reason: string; detail?: string;
  }): Promise<unknown>;
}

export interface RunRef { flow: string | null; task: string | null; run: string }

/** 判定并在阻断时记录 violation（只记账，不因次数结束运行；原地打转由同样失败的计数管）。由 pi-adapter 的工具调用钩子调用。 */
export async function enforceToolCall(call: ToolCall, ctx: GuardContext, sink: ViolationSink, run: RunRef): Promise<GuardDecision> {
  const d = checkToolCall(call, ctx);
  if (d.allow) return d;
  const command = call.toolName === 'bash' && typeof call.input['command'] === 'string' ? call.input['command'] : undefined;
  const detail = command ? command.slice(0, 200) : typeof call.input['path'] === 'string' ? call.input['path'] : undefined;
  await sink.recordViolation({ ...run, role: ctx.role, tool: call.toolName, rule: d.rule, reason: d.reason, ...(detail ? { detail } : {}) });
  return d;
}
