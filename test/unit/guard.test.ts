// 改编自 pi-flow test/unit/guard.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
import { test, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkToolCall, downloadTargets, pipInstall, scriptOpensGui, type GuardContext, type GuardDecision } from '../../src/core/security/guard.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { TEST_YAML } from '../helpers/config.ts';

// 扩展 worker 的只读搜索工具，以验证路径归一化；权限仍由真实七角色与 task writes 约束。
const YAML = TEST_YAML.replace('tools: [read, write, edit, "@codegraph"', 'tools: [read, find, grep, ls, write, edit, "@codegraph"');
const config = parseConfig(YAML);

let base: string, main: string, wt: string;
before(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-forge-guard-')));
  main = path.join(base, 'proj');
  wt = path.join(base, 'proj.worktrees', 'B-001-T-001');
  for (const root of [main, wt]) {
    for (const d of ['.forge', 'src/server', 'src/web', 'docs/contracts', 'secrets', 'config']) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, '.env'), 'KEY=1');
    writeFileSync(path.join(root, 'src/server/a.ts'), '');
  }
  symlinkSync(path.join(wt, '.forge'), path.join(wt, 'src/server/evil'));
  symlinkSync(path.join(main, 'src'), path.join(wt, 'src/server/mainlink'));
});
after(() => rmSync(base, { recursive: true, force: true }));

const ctx = (role: string, over: Partial<GuardContext> = {}): GuardContext => {
  const inMain = role === 'orchestrator';
  return { config, role, cwd: inMain ? main : wt, workspaceRoot: inMain ? main : wt, mainRoot: main, ...over };
};
const call = (toolName: string, input: Record<string, unknown>) => ({ toolName, input });
const bash = (command: string) => call('bash', { command });

function blocked(d: GuardDecision, rule?: string, re?: RegExp) {
  assert.equal(d.allow, false, '应被阻断');
  if (d.allow) return;
  if (rule) assert.equal(d.rule, rule, d.reason);
  if (re) assert.match(d.reason, re);
}
function allowed(d: GuardDecision) {
  assert.equal(d.allow, true, d.allow ? '' : `${d.rule}: ${d.reason}`);
}

test('orchestrator：写、编辑、bash、审批全部被阻断，reason 含指引', () => {
  const c = ctx('orchestrator', { readyTaskId: 'T-003' });
  for (const d of [
    checkToolCall(call('write', { path: 'src/a.ts', content: 'x' }), c),
    checkToolCall(call('edit', { path: 'docs/PRD.md', edits: [] }), c),
    checkToolCall(bash('echo x > .forge/state.json'), c),
    checkToolCall(bash("sed -i 's/a/b/' src/a.ts"), c),
    checkToolCall(call('forge_approve', { decision: 'pass' }), c),
    checkToolCall(call('powershell', { command: 'ls' }), c),
  ]) blocked(d, 'tool_whitelist', /你是调度者，不能直接修改代码。请用户执行 \/forge next，或调用 forge_wait 等待结果。/);
});

test('orchestrator：有序 read_paths 仍可限制只读路径为 docs 与 .forge', () => {
  const scoped = parseConfig(YAML);
  scoped.role('orchestrator').readPaths = ['docs/**', '.forge/**'];
  const c = ctx('orchestrator', { config: scoped });
  allowed(checkToolCall(call('read', { path: 'docs/PRD.md' }), c));
  allowed(checkToolCall(call('read', { path: '.forge/state.json' }), c));
  allowed(checkToolCall(call('forge_status', {}), c));
  blocked(checkToolCall(call('read', { path: 'src/server/a.ts' }), c), 'read_paths', /orchestrator 只能读取/);
  blocked(checkToolCall(call('read', { path: '../proj/src/server/a.ts' }), c), 'read_paths');
});

const readCtx = (patterns: string[]): GuardContext => {
  const scoped = parseConfig(YAML);
  scoped.role('worker').readPaths = patterns;
  return ctx('worker', { config: scoped });
};

test('有序 read_paths：排除 .forge，目录本身与符号链接同样拒绝', () => {
  const c = readCtx(['**', '!.forge/**']);
  allowed(checkToolCall(call('read', { path: 'src/server/a.ts' }), c));
  blocked(checkToolCall(call('read', { path: '.forge/state.json' }), c), 'read_paths');
  blocked(checkToolCall(call('read', { path: 'src/server/evil/state.json' }), c), 'read_paths');
  blocked(checkToolCall(call('ls', { path: '.forge' }), c), 'read_paths');
  allowed(checkToolCall(call('ls', {}), c));
  blocked(checkToolCall(call('read', { path: path.join(main, 'src/server/a.ts') }), c), 'read_paths');
});

test('有序 read_paths：后面的允许和排除反复覆盖', () => {
  const c = readCtx(['**', '!a/**', 'a/b/**', '!a/b/private/**', 'a/b/private/public/**']);
  blocked(checkToolCall(call('read', { path: 'a/x.ts' }), c), 'read_paths');
  allowed(checkToolCall(call('read', { path: 'a/b/x.ts' }), c));
  blocked(checkToolCall(call('read', { path: 'a/b/private/x.ts' }), c), 'read_paths');
  allowed(checkToolCall(call('read', { path: 'a/b/private/public/x.ts' }), c));
});

test('有序 read_paths：只有排除项或空列表拒绝所有读取，null 保持不限制', () => {
  for (const patterns of [[], ['!a/**', '!.forge/**']]) {
    const c = readCtx(patterns);
    blocked(checkToolCall(call('read', { path: 'src/server/a.ts' }), c), 'read_paths');
    blocked(checkToolCall(call('ls', {}), c), 'read_paths');
    blocked(checkToolCall(call('grep', { pattern: 'x' }), c), 'read_paths');
  }
  const unrestricted = parseConfig(YAML);
  unrestricted.role('worker').readPaths = null;
  allowed(checkToolCall(call('read', { path: 'src/server/a.ts' }), ctx('worker', { config: unrestricted })));
});

test('reviewer：任何写入都被阻断', () => {
  const c = ctx('reviewer');
  blocked(checkToolCall(call('write', { path: 'src/server/a.ts', content: '' }), c), 'tool_whitelist', /只读/);
  blocked(checkToolCall(call('edit', { path: 'src/server/a.ts', edits: [] }), c), 'tool_whitelist');
  for (const cmd of ['echo x > a.txt', "sed -i 's/a/b/' src/server/a.ts", 'npm test', 'find . -name x -delete', 'git checkout main',
    'sort -o out.txt in.txt', 'rm src/server/a.ts', 'touch x', 'git stash', 'tee x', 'awk \'{print > "f"}\' a']) {
    blocked(checkToolCall(bash(cmd), c), 'bash', undefined);
  }
});

test('reviewer：只读命令放行', () => {
  const c = ctx('reviewer');
  for (const cmd of ['git diff -- src', 'git diff --cached', 'git log --oneline -5', 'git log --stat -3', 'cat src/server/a.ts | grep -n x', 'ls -la 2>/dev/null',
    'rg foo src', 'find src -name "*.ts"', 'wc -l src/server/a.ts && head -20 src/server/a.ts', 'cd src && ls']) {
    allowed(checkToolCall(bash(cmd), c));
  }
  allowed(checkToolCall(call('read', { path: 'src/server/a.ts' }), c));
  allowed(checkToolCall(call('codegraph_files', { path: 'src/server' }), c));
});

test('stage-qa：没有写工具或可写范围，服务与无界面测试可用，临时目录可存测试结果', () => {
  const scratch = path.join(base, 'scratch-qa');
  mkdirSync(scratch, { recursive: true });
  const c = ctx('stage-qa', { scratchDir: scratch });
  for (const tool of ['write', 'edit']) {
    blocked(checkToolCall(call(tool, { path: 'src/server/a.ts', content: '' }), c), 'tool_whitelist');
  }
  allowed(checkToolCall(call('read', { path: 'src/server/a.ts' }), c));
  allowed(checkToolCall(call('forge_service', { action: 'status' }), c));
  allowed(checkToolCall(bash('pnpm test'), c));
  assert.deepEqual(config.role('stage-qa').writes, []);
  blocked(checkToolCall(bash('echo changed > .forge/state.json'), c), 'protected');
  allowed(checkToolCall(bash(`echo result > ${scratch}/result.txt`), c));
});

test('stage-qa 在临时 worktree 里按隔离工作区约束：写不到主工作区（含 touch 与内联脚本里写死的路径），测试、服务、临时目录照常', () => {
  const scratch = path.join(base, 'scratch-qa-iso');
  mkdirSync(scratch, { recursive: true });
  const c = ctx('stage-qa', { scratchDir: scratch, isolatedWorkspace: true });
  for (const cmd of [`touch ${main}/src/server/new.ts`, `node -e "require('fs').writeFileSync('${main}/src/server/a.ts','x')"`,
    `python3 -c 'open("${main}/src/server/a.ts","w")'`, `cp src/server/a.ts ${main}/src/server/b.ts`, `echo x > ${main}/src/server/a.ts`, `cat ../../proj/src/server/a.ts`]) {
    blocked(checkToolCall(bash(cmd), c));
  }
  for (const cmd of ['pnpm test', 'curl -s http://localhost:41000/api/health', `echo result > ${scratch}/result.txt`, 'cat src/server/a.ts', `ls ${wt}/src/server`]) {
    allowed(checkToolCall(bash(cmd), c));
  }
  // 主工作区路径是工作区路径的前缀（<项目>.worktrees/…）时不误伤
  assert.ok(wt.startsWith(main));
});

test('architect（P1 的 doc task，writes 取 plan scope）：只能写规划产物，不能写实现代码或规格需求', () => {
  const c = ctx('architect', { writes: config.scopeWrites()['plan']! });
  for (const file of ['docs/contracts/openapi.yaml', 'docs/arch/overview.md', 'docs/plan/plan.yaml', 'docs/rules-draft/backend.md', 'docs/spec/glossary.md', 'AGENTS.md']) {
    allowed(checkToolCall(call('write', { path: file, content: '' }), c));
  }
  for (const file of ['src/server/a.ts', 'docs/spec/requirements.md', 'docs/review/x.md']) {
    blocked(checkToolCall(call('write', { path: file, content: '' }), c), 'write_paths');
  }
  blocked(checkToolCall(call('read', { path: '.forge/state.json' }), c), 'read_paths');
  // bash 为 full 档，但 rm / mv 仍只能作用于 task writes 内的文件
  blocked(checkToolCall(bash('rm src/server/a.ts'), c), 'bash', /writes/);
  blocked(checkToolCall(bash('rm x'), ctx('reviewer')), 'bash', /只读角色不能执行该命令（rm）/);
});

test('实施角色：writes 白名单', () => {
  const c = ctx('worker', { writes: ['src/server/**'] });
  allowed(checkToolCall(call('write', { path: 'src/server/new.ts', content: '' }), c));
  allowed(checkToolCall(call('write', { path: '@src/server/new.ts', content: '' }), c));
  allowed(checkToolCall(call('edit', { path: path.join(wt, 'src/server/a.ts'), edits: [] }), c));
  blocked(checkToolCall(call('write', { path: 'src/web/x.ts', content: '' }), c), 'write_paths', /src\/server\/\*\*/);
  blocked(checkToolCall(call('write', { path: 'src/server/../web/x.ts', content: '' }), c), 'write_paths');
  blocked(checkToolCall(call('write', { path: '/tmp/x.ts', content: '' }), c), 'write_paths', /worktree/);
  blocked(checkToolCall(call('write', { path: path.join(main, 'src/server/a.ts'), content: '' }), c), 'write_paths', /主工作区/);
  blocked(checkToolCall(call('write', { path: 'src/server/mainlink/x.ts', content: '' }), c), 'write_paths', /主工作区/);
  blocked(checkToolCall(call('write', { content: 'x' }), c), 'write_paths', /无法确定/);
  // 任务 writes 比角色 writes 窄时以任务为准
  const narrow = ctx('worker', { writes: ['src/server/export/**'] });
  blocked(checkToolCall(call('write', { path: 'src/server/a.ts', content: '' }), narrow), 'write_paths');
  // merge-fix 以冲突文件为准
  const mf = ctx('worker', { writes: ['src/server/a.ts'] });
  allowed(checkToolCall(call('edit', { path: 'src/server/a.ts', edits: [] }), mf));
  blocked(checkToolCall(call('edit', { path: 'src/server/b.ts', edits: [] }), mf), 'write_paths');
});

test('受保护路径对所有角色只读（即使 writes 覆盖）', () => {
  const c = ctx('worker');
  for (const p of ['.forge/state.json', '.git/config', 'workflow.yaml', 'rules/backend.md', '.pi/settings.json',
    '.FORGE/state.json', 'src/server/evil/state.json', '@.forge/x', `file://${wt}/.forge/x`]) {
    blocked(checkToolCall(call('write', { path: p, content: '' }), c), 'protected', /只读/);
  }
  allowed(checkToolCall(call('write', { path: 'docs/contracts/api.ts', content: '' }), c));
  allowed(checkToolCall(call('write', { path: 'anything/else.ts', content: '' }), c));
});

test('S0 的 architect：task writes 含 rules/** 且 guard 打开 rulesWritable 时可写 rules/，其余受保护路径仍拒；没有开关时 rules/ 被拒', () => {
  const writes = ['src/**', 'rules/**', '.forge/**', '.git/**', '.pi/**', 'workflow.yaml'];
  const on = ctx('architect', { writes, rulesWritable: true });
  const off = ctx('architect', { writes });
  for (const c of [on, off]) allowed(checkToolCall(call('write', { path: 'src/server/new.ts', content: '' }), c));
  for (const p of ['rules/x.md', 'rules/backend.md', '@rules/x.md']) {
    allowed(checkToolCall(call('write', { path: p, content: '' }), on));
    blocked(checkToolCall(call('write', { path: p, content: '' }), off), 'protected', /只读/);
  }
  allowed(checkToolCall(bash('echo x > rules/x.md'), on));
  blocked(checkToolCall(bash('echo x > rules/x.md'), off), 'protected');
  allowed(checkToolCall(bash('rm rules/x.md'), on));
  for (const p of ['.forge/x', '.git/config', 'workflow.yaml', '.pi/settings.json']) blocked(checkToolCall(call('write', { path: p, content: '' }), on), 'protected', /只读/);
  blocked(checkToolCall(bash('echo x > .forge/x'), on), 'protected');
  // 开关不改变 writes：rules/ 不在 task writes 里时仍是 write_paths 拒绝
  blocked(checkToolCall(call('write', { path: 'rules/x.md', content: '' }), ctx('architect', { writes: ['src/**'], rulesWritable: true })), 'write_paths');
});

const IMPL_BLOCKED = [
  'echo x > .forge/state.json',
  'echo x >> .forge/events.jsonl',
  'cd .forge && echo x > state.json',
  'F=.forge; echo x > $F/state.json',
  'tee .forge/x < /dev/null',
  'cp a b',
  'rm -rf src',
  'rm -rf .scratchtest',
  'mv src/server/a.ts docs/a.ts',
  'rm -rf src/*',
  'rm -rf .*',
  'sed -i s/a/b/ .forge/state.json',
  'tee ../../proj/src/a.ts',
  'cd /tmp && ls',
  'git reset --hard HEAD~1',
  'git rebase main',
  'git push --force',
  'git push origin HEAD',
  'git checkout main',
  'git checkout -b x -- a',
  'git checkout main dev -- a',
  'git switch -c x',
  'git filter-branch --tree-filter x',
  'git commit --amend -m x',
  'git -C ../.. commit -am x',
  'git config core.hooksPath /tmp',
  'cd /tmp',
  'cd ..',
  'cd',
  'curl -o .forge/x https://example.com',
  'wget -P ../../proj/src https://example.com/a',
  'ssh host',
  'bash -c "rm x"',
  'sh -c \'echo > .forge/x\'',
  'eval "rm x"',
  'echo $(rm x)',
  'echo `mv a b`',
  'find . -name "*.ts" -delete',
  'find . -exec rm {} \;',
  'ls | xargs rm',
  'env FOO=1 rm x',
  'sudo rm x',
  'nohup rm x &',
  'cat <<EOF > .forge/x\nhi\nEOF',
  'echo x > ../../proj/src/a.ts',
  'echo "unterminated',
];

test('实施角色：bash 约束（对抗用例）', () => {
  const c = ctx('worker', { writes: ['src/server/**'] });
  for (const cmd of IMPL_BLOCKED) {
    const d = checkToolCall(bash(cmd), c);
    assert.equal(d.allow, false, `应阻断：${cmd}`);
  }
});

test('实施角色：正常命令放行；禁止列表之外判断不了的（命令名、sh -c、eval、重定向目标含变量）也放行', () => {
  const c = ctx('worker', { writes: ['src/server/**'] });
  for (const cmd of ["sed -i 's/a/b/' src/server/a.ts", "sed -Ei 's/a/b/' src/server/a.ts", "perl -pi -e 's/a/b/' src/server/a.ts", 'rm src/server/*.ts',
    '$CMD src', 'bash -c "$SCRIPT"', 'eval "$X"', 'eval echo hi', 'echo x > "$OUT"', 'node build.js | tee src/server/build.log', 'curl -o $OUT https://example.com']) {
    allowed(checkToolCall(bash(cmd), c));
  }
  blocked(checkToolCall(bash('eval "git push"'), c), 'bash', /git push/);
  blocked(checkToolCall(bash('$CMD .env'), c), 'sensitive');
  for (const cmd of ['pnpm test', 'pnpm typecheck > /tmp/tc.log 2>&1', 'git status && git diff', 'git add -A && git commit -m "feat: x"',
    'git checkout -- src/server/a.ts', 'git checkout abc123 -- src/server/a.ts', 'git rm -q src/server/a.ts', 'cd src/server && ls', 'echo x > src/server/out.txt', 'node -e "console.log(1)"',
    'ls *', 'grep -rn TODO src', 'FOO=1 pnpm test', 'cat <<EOF\nhello\nEOF']) {
    allowed(checkToolCall(bash(cmd), c));
  }
});

test('临时目录：实施角色可以 cd、写入、rm、mv；worktree 中只能对 writes 内的文件 rm、mv；只读角色不能进临时目录', () => {
  const scratch = path.join(base, 'scratch-r1');
  mkdirSync(scratch, { recursive: true });
  const c = ctx('worker', { writes: ['src/server/**'], scratchDir: scratch });
  for (const cmd of [`cd ${scratch} && mkdir -p a && echo x > a/b.js && node a/b.js`, `rm -rf ${scratch}/a`, `mv ${scratch}/x ${scratch}/y`,
    `cp src/server/a.ts ${scratch}/a.ts`, 'mv src/server/a.ts src/server/b.ts', 'rm src/server/a.ts', 'rm -f src/server/x.ts']) {
    allowed(checkToolCall(bash(cmd), c));
  }
  allowed(checkToolCall(call('write', { path: path.join(scratch, 'n.js'), content: 'x' }), c));
  blocked(checkToolCall(bash('rm -rf .scratchtest'), c), 'bash', /临时目录/);
  blocked(checkToolCall(bash('cd /tmp'), c), 'bash', /临时目录/);
  const r = ctx('reviewer', { scratchDir: scratch });
  blocked(checkToolCall(bash(`cd ${scratch}`), r), 'bash');
});

test('敏感读取对所有角色阻断', () => {
  for (const role of ['worker', 'reviewer', 'architect', 'stage-qa', 'orchestrator']) {
    const c = ctx(role, { writes: undefined });
    for (const p of ['.env', 'config/.env.local', 'key.pem', 'secrets/db.json', '.ENV']) {
      blocked(checkToolCall(call('read', { path: p }), c), 'sensitive', /敏感/);
    }
  }
  const ch = ctx('worker');
  blocked(checkToolCall(call('find', { pattern: '.env*' }), ch), 'sensitive');
  blocked(checkToolCall(call('grep', { pattern: 'KEY', glob: '*.pem' }), ch), 'sensitive');
  blocked(checkToolCall(call('grep', { pattern: 'KEY', path: 'secrets' }), ch), 'sensitive');
  allowed(checkToolCall(call('find', { pattern: '*.ts' }), ch));
  allowed(checkToolCall(call('grep', { pattern: 'KEY', path: 'src' }), ch));
  const be = ctx('worker');
  for (const cmd of ['cat .env', 'cat .e*', 'cat < .env', 'grep KEY config/.env.local', 'printenv', 'env', 'head secrets/x', 'source .env']) {
    blocked(checkToolCall(bash(cmd), be), 'sensitive');
  }
  blocked(checkToolCall(bash('cat .env'), ctx('reviewer')), 'sensitive');
  blocked(checkToolCall(call('codegraph_files', { path: '.env' }), ctx('reviewer')), 'sensitive');
});

test('不在白名单的工具被阻断，reason 带角色提示', () => {
  blocked(checkToolCall(call('forge_propose_tasks', { tasks: [] }), ctx('worker')), 'tool_whitelist', /worker/);
  blocked(checkToolCall(call('web_search', { query: 'x' }), ctx('worker')), 'tool_whitelist');
  // web 工具组默认不分配；加给角色后才能用
  const withWeb = parseConfig(YAML.replace('tools: [read, "@codegraph", forge_review_report', 'tools: [read, "@web", "@codegraph", forge_review_report'));
  allowed(checkToolCall(call('web_search', { query: 'x' }), ctx('reviewer', { config: withWeb })));
  blocked(checkToolCall(call('unknown_tool', {}), ctx('architect')), 'tool_whitelist');
});

test('worktree 中未被 git 跟踪的临时文件可以删除；被跟踪的 writes 之外的文件不能删', () => {
  const repo = mkdtempSync(path.join(base, 'repo-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs/a.md'), 'x');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'init');
  mkdirSync(path.join(repo, '.tmpcheck'), { recursive: true });
  writeFileSync(path.join(repo, '.tmpcheck/x.js'), 'x');
  const c = { ...ctx('worker', { writes: ['src/server/**'] }), cwd: realpathSync(repo), workspaceRoot: realpathSync(repo) };
  allowed(checkToolCall(bash('rm -rf .tmpcheck'), c));
  blocked(checkToolCall(bash('rm docs/a.md'), c), 'bash');
  blocked(checkToolCall(bash('mv .tmpcheck/x.js .tmpcheck/y.js'), c), 'bash');
});

test('同一命令中字面量赋值的变量会被代入后校验；含命令替换或未知变量的仍阻断', () => {
  const scratch = path.join(base, 'scratch-r2');
  mkdirSync(scratch, { recursive: true });
  const c = ctx('worker', { writes: ['src/server/**'], scratchDir: scratch });
  allowed(checkToolCall(bash(`S=${scratch}; mkdir -p $S/a && cp src/server/a.ts $S/a/ && rm -rf "\${S}/a"`), c));
  blocked(checkToolCall(bash('S=/etc; rm -rf $S/x'), c), 'bash');
  blocked(checkToolCall(bash('F=.forge; echo x > $F/state.json'), c));
  blocked(checkToolCall(bash('S=$(pwd); rm -rf $S/x'), c), 'bash');
  blocked(checkToolCall(bash('rm -rf $UNKNOWN/x'), c), 'bash');
  // 命令替换里的 curl 也能用外层赋值的变量（真实实验：stage-qa 的 P=59670; B=http://localhost:$P; ID=$(curl $B/boards) 被拦）
  allowed(checkToolCall(bash(`P=59670; B=http://localhost:$P; ID=$(curl -s -X POST $B/boards -d '{"name":"x"}' | sed -E 's/.*"id":"([^"]+)".*/\\1/'); echo $ID`), c));
  allowed(checkToolCall(bash('H=http://example.com; ID=$(curl -s $H/boards)'), c));
});

test('实现类任务可以在接口文档里追加（不受任务可写范围限制），其他路径照旧；没有该标记时不可写', () => {
  const impl = ctx('worker', { interfaceAdditions: true, writes: ['src/server/a.ts'] });
  allowed(checkToolCall(call('write', { path: 'docs/contracts/web.md', content: '' }), impl));
  allowed(checkToolCall(call('write', { path: 'src/server/a.ts', content: '' }), impl));
  blocked(checkToolCall(call('write', { path: 'docs/requirements.md', content: '' }), impl), 'write_paths');
  blocked(checkToolCall(call('write', { path: 'workflow.yaml', content: '' }), impl));
  blocked(checkToolCall(call('write', { path: 'docs/contracts/web.md', content: '' }), ctx('worker', { writes: ['src/server/a.ts'] })), 'write_paths');
});

test('禁止后台运行：单独的 & 被拦下，&& 与 2>&1 不受影响；setsid、disown 被拦下', () => {
  const c = ctx('worker');
  blocked(checkToolCall(bash('node --test tests/a.test.js &'), c), 'bash', /后台运行/);
  blocked(checkToolCall(bash('sleep 1 & echo done'), c), 'bash', /后台运行/);
  blocked(checkToolCall(bash('setsid node x.js'), c), 'bash');
  allowed(checkToolCall(bash('node --test 2>&1 | tail -5'), c));
  allowed(checkToolCall(bash('ls && echo ok'), c));
});

test('merge-fix：冲突文件里的测试可改（extraWritable），冲突文件之外的测试仍拒绝', () => {
  const c = ctx('worker', { writes: ['src/server/a.ts'], extraWritable: ['tests/server/api.test.js'] });
  allowed(checkToolCall(call('write', { path: 'tests/server/api.test.js', content: '' }), c));
  allowed(checkToolCall(call('edit', { path: 'tests/server/api.test.js', edits: [] }), c));
  blocked(checkToolCall(call('write', { path: 'tests/server/new.test.js', content: '' }), c), 'write_paths');
  blocked(checkToolCall(bash('rm tests/server/api.test.js'), c), 'bash');
  blocked(checkToolCall(call('write', { path: 'tests/server/api.test.js', content: '' }), ctx('worker', { writes: ['src/server/a.ts'] })), 'write_paths');
});

test('不能打开桌面应用或浏览器窗口：内置的界面命令与 gui_commands 都被拦下；无界面的测试照常运行', () => {
  const gui = parseConfig(YAML.replace(/^limits:/m, 'gui_commands: ["pnpm dev:desktop", "node scripts/dev-desktop-env.mjs"]\nlimits:'));
  const c = { ...ctx('worker'), config: gui };
  for (const cmd of [
    'open http://localhost:3000',
    'open -a Safari index.html',
    'xdg-open index.html',
    'npx electron .',
    'pnpm exec electron dist/main.js',
    'npx playwright open http://localhost:3000',
    'npx playwright test --headed',
    'npx vitest --ui',
    'npx cypress open',
    'osascript -e "tell app \\"ZCode\\" to activate"',
    'pnpm dev:desktop',
    'pnpm run dev:desktop:test',
    'pnpm dev:desktop:test --inspect',
    'cd packages && node scripts/dev-desktop-env.mjs test',
    'bash -c "pnpm dev:desktop"',
  ]) blocked(checkToolCall(bash(cmd), c), 'bash', /不能启动桌面应用或打开浏览器窗口/);
  for (const cmd of ['npx playwright test', 'pnpm test', 'pnpm dev:desktopx', 'node -e "1"', 'npm run build']) allowed(checkToolCall(bash(cmd), c));
});

test('所有角色都可以联网：curl、wget 不限主机；实施角色的下载按写路径检查，只读角色不能写文件，stage-qa 不另加限制', () => {
  const w = ctx('worker');
  for (const cmd of [
    'curl -s https://example.com/docs',
    'curl -sS -XPOST -H "Content-Type: application/json" -d \'{"a":1}\' http://127.0.0.1:8080/x',
    'curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/',
    'curl -x http://proxy:8080 https://example.com',
    'curl -o out.html https://example.com',
    'curl -sO https://example.com/a.tgz',
    'wget https://example.com/a.tgz',
    'wget -qO- https://example.com',
    'B=http://localhost:42330; ID=$(curl -s --request POST $B/boards); curl -s --request POST $B/boards/$ID/cards',
  ]) allowed(checkToolCall(bash(cmd), w));
  blocked(checkToolCall(bash('curl -o .forge/state.json https://example.com'), w), 'protected');
  blocked(checkToolCall(bash(`curl -o ${main}/src/a.ts https://example.com`), w), 'bash', /主工作区/);
  blocked(checkToolCall(bash(`wget -P ${main} https://example.com/a`), w), 'bash', /主工作区/);

  const rv = ctx('reviewer');
  for (const cmd of ['curl -s https://example.com', 'curl -s -XPOST -o /dev/null http://localhost:3000/x', 'wget -qO- https://example.com', 'wget --spider https://example.com']) {
    allowed(checkToolCall(bash(cmd), rv));
  }
  blocked(checkToolCall(bash('curl -o x.html https://example.com'), rv), 'bash', /只读角色的 curl 不能把内容写进文件/);
  blocked(checkToolCall(bash('curl -sO https://example.com/a'), rv), 'bash', /不能把内容写进文件/);
  blocked(checkToolCall(bash('wget https://example.com/a'), rv), 'bash', /wget -qO-/);

  const qa = ctx('stage-qa', { isolatedWorkspace: true });
  for (const cmd of ['curl -s -o out.json -XPOST http://localhost:3000/x', 'curl -s -o /dev/null -w "%{http_code}" --request POST "http://localhost:42330/boards" --data-raw \'not json\'', 'wget https://example.com/a']) {
    allowed(checkToolCall(bash(cmd), qa));
  }
  blocked(checkToolCall(bash(`curl -o ${main}/x http://localhost:3000/`), qa), 'read_paths');
});

test('uv 管理的 Python 项目：pip 装包被拦下并提示 uv add；uv add、uv sync、uv run 放行；没有 uv.lock 的项目不拦 pip', () => {
  assert.deepEqual(['pip install x', 'pip3 install -r r.txt', 'python3 -m pip install x', 'uv pip install x', 'uv pip sync r.txt', 'pip list', 'uv add x', 'python -m pytest']
    .map((c) => pipInstall(c.split(' '))), [true, true, true, true, true, false, false, false]);
  const dir = realpathSync(mkdtempSync(path.join(base, 'uv-')));
  writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n');
  const c = { ...ctx('worker'), cwd: dir, workspaceRoot: dir };
  for (const cmd of ['pip install requests', 'uv pip install requests', '.venv/bin/python -m pip install x']) blocked(checkToolCall(bash(cmd), c), 'bash', /uv add/);
  for (const cmd of ['uv add requests', 'uv sync --frozen', 'uv run --frozen pytest -q']) allowed(checkToolCall(bash(cmd), c));
  allowed(checkToolCall(bash('pip install requests'), ctx('worker')));
});

test('downloadTargets：curl、wget 会写的文件与目录（带值的短选项簇不误判）', () => {
  assert.deepEqual(downloadTargets('curl', ['-sS', '-XPOST', 'http://x']), { files: [], dirs: [] });
  assert.deepEqual(downloadTargets('curl', ['-so', 'a.html', 'http://x']), { files: ['a.html'], dirs: [] });
  assert.deepEqual(downloadTargets('curl', ['-oa.html', '-D', '/dev/null', 'http://x']), { files: ['a.html'], dirs: [] });
  assert.deepEqual(downloadTargets('curl', ['-O', '--output-dir', 'dl', 'http://x/a']), { files: [], dirs: ['dl'] });
  assert.deepEqual(downloadTargets('curl', ['-sO', 'http://x/a']), { files: [], dirs: ['.'] });
  assert.deepEqual(downloadTargets('curl', ['--output=-', 'http://x']), { files: [], dirs: [] });
  assert.deepEqual(downloadTargets('wget', ['http://x/a']), { files: [], dirs: ['.'] });
  assert.deepEqual(downloadTargets('wget', ['-qO-', 'http://x']), { files: [], dirs: [] });
  assert.deepEqual(downloadTargets('wget', ['-O', 'a', '-o', 'log.txt', 'http://x']), { files: ['a', 'log.txt'], dirs: [] });
  assert.deepEqual(downloadTargets('wget', ['-P', 'dl', 'http://x']), { files: [], dirs: ['dl'] });
});

test('package.json 脚本会打开界面时也拦下：看脚本本身、调用的同包脚本、node 运行的文件', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-gui-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {
      'dev:app': 'electron .', desktop: 'npm run dev:app', start: 'node scripts/launch.mjs', 'tauri:dev': 'tauri dev',
      web: 'vite --open', serve: 'vite', build: 'electron-builder --mac', test: 'vitest run', e2e: 'playwright test',
    } }));
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'scripts/launch.mjs'), "import { spawn } from 'node:child_process';\nspawn('electron', ['.']);\n");
    for (const c of ['npm run dev:app', 'pnpm desktop', 'npm start', 'yarn tauri:dev', 'pnpm run web']) assert.equal(scriptOpensGui(c.split(' '), dir, dir), true, c);
    for (const c of ['pnpm serve', 'pnpm build', 'pnpm test', 'npm run e2e', 'pnpm install', 'pnpm nope']) assert.equal(scriptOpensGui(c.split(' '), dir, dir), false, c);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('allowlist（reviewer）：bash_allow 引用的命令按前缀放行，其余只读；重定向与写操作被拦', () => {
  const c = ctx('reviewer');
  for (const cmd of ['pnpm test:acceptance -- T-001', 'pnpm test:acceptance --list -- T-001', 'pnpm test:acceptance', 'pnpm test tests/unit/a.test.ts', 'ls tests/acceptance && cat package.json',
    'cd tests && pnpm test:acceptance -- T-001']) allowed(checkToolCall(bash(cmd), c));
  for (const cmd of ['pnpm install', 'pnpm build', 'node tests/x.js', 'npx playwright test', 'pnpm test:acceptance -- T-001 > out.txt',
    'pnpm test:acceptance; rm -rf src', 'sh -c "pnpm build"']) blocked(checkToolCall(bash(cmd), c), 'bash');
});

test('allowlistPrefixes / allowedByList：{files} 占位与之后的词去掉；多段命令拆开；逐词前缀匹配', async () => {
  const { allowlistPrefixes, allowedByList } = await import('../../src/core/security/guard.ts');
  const { parseShell } = await import('../../src/core/security/shell.ts');
  const p = allowlistPrefixes(['pnpm vitest run {files} --reporter dot', 'cd web && npm run e2e --', 'CI=1 pnpm acc']);
  assert.deepEqual(p, [['pnpm', 'vitest', 'run'], ['cd', 'web'], ['npm', 'run', 'e2e', '--'], ['CI=1', 'pnpm', 'acc']]);
  const words = (s: string) => parseShell(s).commands[0]!.words;
  assert.equal(allowedByList(words('pnpm vitest run a.test.ts'), p), true);
  assert.equal(allowedByList(words('pnpm vitest'), p), false);
  assert.equal(allowedByList(words('npm run e2e -- --grep x'), p), true);
  assert.equal(allowedByList(words('npm run e2e'), p), false);
});

test('只读与白名单档位：能读出其他提交内容的 git 用法被拦，工作区内的 diff、log、blame 放行', async () => {
  const { gitReadsOtherCommits } = await import('../../src/core/security/guard.ts');
  for (const role of ['reviewer']) { // architect 现为 full 档（S0 搭骨架），不再属于只读档位
    const c = ctx(role);
    for (const cmd of ['git show HEAD~1:src/a.ts', 'git show abc123', 'git cat-file -p HEAD:src/a.ts', 'git log -p', 'git log --patch -1 -- src',
      'git log -L 1,5:src/a.ts', 'git diff HEAD~1', 'git diff main...HEAD -- src', 'git diff src/a.ts', 'git grep foo HEAD~2', 'git grep -e foo main',
      'git blame HEAD~1 -- src/a.ts', 'git archive HEAD', 'git remote -v', 'git fetch', 'git clone ../x', 'git worktree list']) {
      blocked(checkToolCall(bash(cmd), c), 'bash');
    }
    for (const cmd of ['git diff', 'git diff -- src', 'git diff --stat', 'git diff --cached', 'git log --oneline -5', 'git log --stat', 'git grep foo', 'git grep -e foo -- src',
      'git blame src/a.ts', 'git status', 'git ls-files']) allowed(checkToolCall(bash(cmd), c));
  }
  assert.equal(gitReadsOtherCommits('log', ['--oneline', '--pretty=%h']), null);
  assert.match(gitReadsOtherCommits('show', [])!, /git show/);
  // 实施档位不受影响（worker 自己的 worktree）
  allowed(checkToolCall(bash('git show HEAD:src/server/a.ts'), ctx('worker', { writes: ['src/server/**'] })));
});

test('隔离工作区（stage-qa 的临时 worktree）：读写与 bash 参数不能越出工作区，不能碰 .forge/', () => {
  const c = ctx('stage-qa', { isolatedWorkspace: true });
  for (const d of [
    checkToolCall(call('read', { path: path.join(main, 'src/server/a.ts') }), c),
    checkToolCall(call('read', { path: '../proj/src/server/a.ts' }), c),
    checkToolCall(call('read', { path: '.forge/state.json' }), c),
    checkToolCall(call('read', { path: '~/x' }), c),
    checkToolCall(bash(`cat ${main}/src/server/a.ts`), c),
    checkToolCall(bash('cat ../../proj/src/server/a.ts'), c),
    checkToolCall(bash('ls .forge'), c),
    checkToolCall(bash(`pnpm test:acceptance --config=${main}/x.ts`), c),
    checkToolCall(bash('grep -r foo /etc'), c),
  ]) blocked(d, 'read_paths');
  allowed(checkToolCall(call('read', { path: 'src/server/a.ts' }), c));
  allowed(checkToolCall(call('read', { path: path.join(wt, 'src/server/a.ts') }), c));
  allowed(checkToolCall(bash('cat src/server/../server/a.ts && ls tests'), c));
  allowed(checkToolCall(bash('pnpm test:acceptance -- T-001'), c));
  allowed(checkToolCall(bash('curl http://localhost:3000/x'), ctx('worker', { writes: ['src/**'], isolatedWorkspace: true })));
});
