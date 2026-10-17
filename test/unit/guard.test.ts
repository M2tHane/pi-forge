import { test, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

test('读取不限范围：orchestrator 与 worker 都能读 .forge/ 与源码，敏感文件仍拦', () => {
  for (const c of [ctx('orchestrator'), ctx('worker', { writes: ['src/server/**'] }), ctx('reviewer')]) {
    allowed(checkToolCall(call('read', { path: '.forge/state.json' }), c));
    allowed(checkToolCall(call('read', { path: 'src/server/a.ts' }), c));
    blocked(checkToolCall(call('read', { path: '.env' }), c), 'sensitive');
  }
  allowed(checkToolCall(call('ls', { path: '.forge' }), ctx('orchestrator')));
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
  for (const file of ['docs/contracts/openapi.yaml', 'docs/arch/overview.md', 'docs/plan/plan.yaml', 'commands.yaml', 'docs/spec/glossary.md', 'AGENTS.md']) {
    allowed(checkToolCall(call('write', { path: file, content: '' }), c));
  }
  for (const file of ['src/server/a.ts', 'docs/spec/requirements.md', 'docs/review/x.md', 'docs/rules-draft/backend.md']) {
    blocked(checkToolCall(call('write', { path: file, content: '' }), c), 'write_paths');
  }
  allowed(checkToolCall(call('read', { path: '.forge/state.json' }), c));
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
  // 判断不了写到哪里的调用放行（工具自己会报缺参数）
  allowed(checkToolCall(call('write', { content: 'x' }), c));
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
  'git reflog expire --expire=now --all',
  'git reflog delete HEAD@{1}',
  'git -C ../.. commit -am x',
  'git config core.hooksPath /tmp',
  'curl -o .forge/x https://example.com',
  'wget -P ../../proj/src https://example.com/a',
  'ssh host',
  'bash -c "rm x"',
  'sh -c \'echo > .forge/x\'',
  'eval "rm x"',
  'echo $(rm x)',
  'echo `mv a b`',
  'find . -exec rm {} \;',
  'env FOO=1 rm x',
  'sudo rm x',
  'nohup rm x &',
  'cat <<EOF > .forge/x\nhi\nEOF',
  'echo x > ../../proj/src/a.ts',
];

test('实施角色：bash 约束（对抗用例）', () => {
  const c = ctx('worker', { writes: ['src/server/**'] });
  for (const cmd of IMPL_BLOCKED) {
    const d = checkToolCall(bash(cmd), c);
    assert.equal(d.allow, false, `应阻断：${cmd}`);
  }
});

test('实施角色：只读的 git reflog（不带子命令、show、exists）放行', () => {
  const c = ctx('worker', { writes: ['src/server/**'] });
  for (const cmd of ['git reflog', 'git reflog -n 20', 'git reflog show HEAD', 'git reflog exists refs/heads/x', 'git reflog --date=iso | head']) {
    assert.equal(checkToolCall(bash(cmd), c).allow, true, cmd);
  }
});

test('实施角色：正常命令放行；禁止列表之外判断不了的（命令名、sh -c、eval、重定向目标含变量）也放行', () => {
  const c = ctx('worker', { writes: ['src/server/**'] });
  for (const cmd of ["sed -i 's/a/b/' src/server/a.ts", "sed -Ei 's/a/b/' src/server/a.ts", "perl -pi -e 's/a/b/' src/server/a.ts", 'rm src/server/*.ts',
    'echo "unterminated', 'cd /tmp && ls', 'cd ..', 'cd', 'find . -name "*.ts" -delete', 'ls | xargs rm', 'rm -rf $DIST',
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
  // cd 不拦：之后的相对路径按新目录判断
  allowed(checkToolCall(bash('cd /tmp'), c));
  blocked(checkToolCall(bash(`cd ${main} && echo x > a.ts`), c), 'bash', /主工作区/);
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

test('同一命令中字面量赋值的变量会被代入后校验；含命令替换或未知变量的放行', () => {
  const scratch = path.join(base, 'scratch-r2');
  mkdirSync(scratch, { recursive: true });
  const c = ctx('worker', { writes: ['src/server/**'], scratchDir: scratch });
  allowed(checkToolCall(bash(`S=${scratch}; mkdir -p $S/a && cp src/server/a.ts $S/a/ && rm -rf "\${S}/a"`), c));
  blocked(checkToolCall(bash('S=/etc; rm -rf $S/x'), c), 'bash');
  blocked(checkToolCall(bash('F=.forge; echo x > $F/state.json'), c));
  // 位置判断不了的（命令替换、未知变量）放行
  allowed(checkToolCall(bash('S=$(pwd); rm -rf $S/x'), c));
  allowed(checkToolCall(bash('rm -rf $UNKNOWN/x'), c));
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

test('uv 管理的 Python 项目：pip 装包放行但提醒用 uv add；uv add、uv sync、uv run 不提醒；没有 uv.lock 的项目不提醒', () => {
  assert.deepEqual(['pip install x', 'pip3 install -r r.txt', 'python3 -m pip install x', 'uv pip install x', 'uv pip sync r.txt', 'pip list', 'uv add x', 'python -m pytest']
    .map((c) => pipInstall(c.split(' '))), [true, true, true, true, true, false, false, false]);
  const dir = realpathSync(mkdtempSync(path.join(base, 'uv-')));
  writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n');
  const c = { ...ctx('worker'), cwd: dir, workspaceRoot: dir };
  const warning = (cmd: string, cx: GuardContext) => { const d = checkToolCall(bash(cmd), cx); assert.ok(d.allow, cmd); return d.allow ? d.warning : undefined; };
  for (const cmd of ['pip install requests', 'uv pip install requests', '.venv/bin/python -m pip install x']) assert.match(warning(cmd, c) ?? '', /uv add/);
  for (const cmd of ['uv add requests', 'uv sync --frozen', 'uv run --frozen pytest -q']) assert.equal(warning(cmd, c), undefined);
  assert.equal(warning('pip install requests', ctx('worker')), undefined);
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

test('只读档位：可以读其他提交（git show、log -p、diff <版本>），不能操作远程与 worktree', () => {
  const c = ctx('reviewer');
  for (const cmd of ['git remote -v', 'git fetch', 'git clone ../x', 'git worktree list', 'git archive HEAD']) blocked(checkToolCall(bash(cmd), c), 'bash');
  for (const cmd of ['git show HEAD~1:src/a.ts', 'git cat-file -p HEAD:src/a.ts', 'git log -p', 'git diff HEAD~1', 'git diff main...HEAD -- src', 'git grep foo HEAD~2',
    'git blame HEAD~1 -- src/a.ts', 'git diff', 'git log --oneline -5', 'git status', 'git ls-files']) allowed(checkToolCall(bash(cmd), c));
});

test('只读档位：按行号打印的 sed、node --check、git -C 放行；sed 改文件、写文件、执行命令的写法仍拦', () => {
  const c = ctx('reviewer');
  for (const cmd of ['sed -n 1,60p docs/spec/requirements.md', "sed -n '212,216p' src/a.js", "cat -A src/a.js | sed -n '8,16p'", "sed -n -e '1,5p' -e '$p' src/a.js",
    "sed -n '10p;20,30p' src/a.js", 'node --check src/a.js', 'node -c src/a.js && echo ok', 'git -C . diff --stat', `git -C ${wt} diff HEAD~1 --stat`]) allowed(checkToolCall(bash(cmd), c));
  for (const cmd of ["sed -i '' 1d src/a.js", "sed -n '1,5w out.txt' src/a.js", "sed 's/a/b/' src/a.js", "sed -n '1e rm x' src/a.js", 'sed -n "$S" src/a.js',
    'node src/a.js', 'node --check', 'node --check --eval x', 'node -e 1', 'git --git-dir=/tmp/x log', 'git -C . commit -m x']) blocked(checkToolCall(bash(cmd), c), 'bash');
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

test('隔离工作区：系统临时目录可用、别的 worktree 仍拦；不查敏感文件；点名的 printenv 放行（所有角色）、打印全部仍拦', () => {
  const c = ctx('stage-qa', { isolatedWorkspace: true });
  const sysTmp = realpathSync(tmpdir());
  for (const cmd of ['mktemp -d /tmp/club-s1-qa.XXXXXX', `rm -rf ${sysTmp}/tmp.6q1K3wfy7K`, 'ls /tmp',
    "rg --files -g '!package-lock.json' -g '!.env*' -g '!*.pem'", 'cat .env', 'printenv PORT FORGE_DB_NAME']) {
    allowed(checkToolCall(bash(cmd), c));
  }
  allowed(checkToolCall(call('read', { path: '/tmp/x.json' }), c));
  // 技能目录（程序按 Pi 的用户目录找到后传入，路径用正斜杠）：读说明、运行脚本；没传入时、同一用户目录下别的文件仍拦
  const pw = `${homedir().replace(/\\/g, '/')}/.pi-forge-test/npm/node_modules/pi-playwright/skills/playwright-browser`;
  const cs = ctx('stage-qa', { isolatedWorkspace: true, toolDirs: [pw] });
  allowed(checkToolCall(call('read', { path: `${pw}/SKILL.md` }), cs));
  allowed(checkToolCall(bash(`node "${pw}/scripts/pw.js" open http://localhost:3000/products.html`), cs));
  allowed(checkToolCall(bash(`node ${pw}/scripts/pw.js screenshot --filename /tmp/pw/a.png`), cs));
  allowed(checkToolCall(bash(`node ${pw}/scripts/pw.js open http://localhost:3000`), ctx('worker', { writes: ['src/**'] })));
  blocked(checkToolCall(call('read', { path: `${pw}/SKILL.md` }), c), 'read_paths');
  blocked(checkToolCall(call('read', { path: `${homedir()}/.pi-forge-test/settings.json` }), cs), 'read_paths');
  blocked(checkToolCall(bash(`node ${pw}/scripts/pw.js open http://localhost:3000 --headed`), cs), 'bash');
  blocked(checkToolCall(bash(`cat ${path.join(base, 'proj.worktrees', 'B-001-T-002', 'src/a.ts')}`), c), 'read_paths');
  blocked(checkToolCall(bash(`cat ${main}/src/server/a.ts`), c), 'read_paths');
  for (const cmd of ['printenv', 'printenv -0', 'env', 'export']) blocked(checkToolCall(bash(cmd), c), 'sensitive');
  allowed(checkToolCall(bash('printenv PORT'), ctx('worker')));
  blocked(checkToolCall(bash('env | grep -i port'), ctx('worker')), 'sensitive', /printenv PORT/);
});

test('受保护路径的目录本身（worktree 里的 .git 文件）与会匹配到它的隐藏文件通配都拦；forge_service 直接给的命令同样检查', () => {
  const c = ctx('worker', { openWrites: true, writes: ['src/server/**'] });
  for (const cmd of ['rm .git', 'mv .git x', 'rm -rf .g*']) blocked(checkToolCall(bash(cmd), c), 'protected');
  assert.equal(checkToolCall(bash('rm -rf .*'), c).allow, false);
  allowed(checkToolCall(bash('rm -rf src/server/.cache*'), c));
  blocked(checkToolCall(call('forge_service', { action: 'start', name: 'dev', command: 'git push' }), c), 'bash', /git push/);
  allowed(checkToolCall(call('forge_service', { action: 'start', name: 'dev', command: 'npm run dev' }), c));
});
