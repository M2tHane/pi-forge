// 第六轮 7.3–7.5：commands.yaml 无效时规划闸门不通过；自动检查点；外部通知。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo } from '../helpers/repo.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { commandsProblems, commandsTextAt } from '../../src/core/state/project-commands.ts';
import { createCheckpoint, dropCheckpoint, listCheckpoints, restoreCheckpoint } from '../../src/core/state/checkpoints.ts';
import { notifyEvents, runNotify } from '../../src/core/ops/notify.ts';

function repoWithWorkflow() {
  const r = tmpRepo();
  writeFileSync(path.join(r.dir, 'workflow.yaml'), TEST_YAML);
  writeFileSync(path.join(r.dir, 'README.md'), 'x\n');
  r.git('add', '.');
  r.git('commit', '-q', '-m', 'init');
  return r;
}

test('commands.yaml：缺文件、不是合法 YAML、命令为空、缺 test 都算问题；合法的没有问题；运行中的配置换成分支上的', () => {
  const r = repoWithWorkflow();
  try {
    const at = (text: string) => {
      r.git('checkout', '-q', '-B', 'flow/B-001');
      writeFileSync(path.join(r.dir, 'commands.yaml'), text);
      r.git('add', '.');
      r.git('commit', '-q', '-m', 'commands');
      r.git('checkout', '-q', 'main');
      return commandsProblems(commandsTextAt(r.dir, 'flow/B-001'), '');
    };
    assert.equal(commandsTextAt(r.dir, 'flow/none'), null, '没有分支');
    assert.match(commandsProblems(null, '集成分支上').join(), /集成分支上缺少 commands\.yaml/);
    assert.match(at('commands: [a, b').join(), /不是合法 YAML/);
    assert.match(at('commands:\n  lint: ""\n').join(), /lint 的命令必须是非空字符串/);
    assert.match(at('commands:\n  lint: "eslint ."\n').join(), /缺少 test 命令/);
    assert.match(at('commands:\n  test: "npm test"\nroles: {}\n').join(), /只能有 commands、gui_commands、shared_env/);
    assert.deepEqual(at('commands:\n  test: "npm test"\n  serve: "npm run dev"\n'), []);
    const config = parseConfig(TEST_YAML);
    assert.equal(config.syncCommands(r.dir, 'flow/B-001'), null);
    assert.deepEqual(config.commands, { test: 'npm test', serve: 'npm run dev' }, '换成分支上的命令表，workflow.yaml 里旧的不再用');
    at('commands: [broken');
    assert.match(config.syncCommands(r.dir, 'flow/B-001') ?? '', /不是合法 YAML/);
    assert.equal(config.commands['test'], 'npm test', '写坏时保留原来的命令');
  } finally { r.cleanup(); }
});

test('检查点：包含未跟踪的新文件、不动索引；内容没变不新建；工作区被改坏后恢复；删除', () => {
  const r = repoWithWorkflow();
  try {
    const wt = path.join(r.dir, '..', `${path.basename(r.dir)}-wt`);
    r.git('worktree', 'add', '-q', '-b', 'flow/B-001/T-001', wt);
    writeFileSync(path.join(wt, 'README.md'), 'changed\n');
    writeFileSync(path.join(wt, 'new.ts'), 'export const a = 1;\n');
    const indexBefore = execGit(wt, ['diff', '--cached', '--name-only']);
    const sha = createCheckpoint(r.dir, wt, 'B-001', 'T-001');
    assert.ok(sha);
    assert.equal(execGit(wt, ['diff', '--cached', '--name-only']), indexBefore, '不动 agent 的索引');
    assert.equal(execGit(wt, ['status', '--porcelain']).includes('?? new.ts'), true, '新文件仍是未跟踪');
    assert.equal(createCheckpoint(r.dir, wt, 'B-001', 'T-001'), null, '内容没变不新建');
    assert.deepEqual(listCheckpoints(r.dir).map((c) => [c.flow, c.task, c.sha]), [['B-001', 'T-001', sha]]);
    // agent 把工作区改坏了
    writeFileSync(path.join(wt, 'README.md'), 'broken\n');
    execGit(wt, ['rm', '-q', '-f', '--cached', 'README.md']);
    writeFileSync(path.join(wt, 'new.ts'), 'garbage');
    assert.equal(restoreCheckpoint(r.dir, wt, 'B-001', 'T-001'), 2);
    assert.equal(readFileSync(path.join(wt, 'README.md'), 'utf8'), 'changed\n');
    assert.equal(readFileSync(path.join(wt, 'new.ts'), 'utf8'), 'export const a = 1;\n');
    dropCheckpoint(r.dir, 'B-001', 'T-001');
    assert.deepEqual(listCheckpoints(r.dir), []);
    assert.throws(() => restoreCheckpoint(r.dir, wt, 'B-001', 'T-001'), /没有检查点/);
  } finally { r.cleanup(); rmSync(path.join(r.dir, '..', `${path.basename(r.dir)}-wt`), { recursive: true, force: true }); }
});

test('通知：新出现的事项与完成的流程各运行一次命令，事件 JSON 从标准输入传入', async () => {
  const r = tmpRepo();
  try {
    const prev = { phases: { 'B-001': 'dev' as const }, actions: { 'B-001:blocked:T-001:3': '旧事项' }, attempts: {} };
    const next = { phases: { 'B-001': 'done' as const }, actions: { 'B-001:blocked:T-001:3': '旧事项', 'B-001:stuck:T-002@1': '流程卡住' }, attempts: {} };
    const events = notifyEvents(prev, next);
    assert.deepEqual(events.map((e) => [e.type, e.flow, e.text]), [['action', 'B-001', '流程卡住'], ['done', 'B-001', 'B-001 已完成']]);
    // pi-forge M0：每个事件写到单独的文件。原来两个通知进程同时追加同一个文件，负载高时内容会交错（偶发失败）
    const out = path.join(r.dir, 'events');
    mkdirSync(out);
    const config = parseConfig(`${TEST_YAML}\nnotify:\n  command: "cat > $(mktemp ${out}/ev.XXXXXX)"\n`);
    runNotify(config, r.dir, events);
    const done = () => readdirSync(out).map((f) => readFileSync(path.join(out, f), 'utf8')).filter((s) => s.trim().endsWith('}')).length === 2;
    for (let i = 0; i < 100 && !done(); i++) await new Promise((x) => setTimeout(x, 20));
    const lines = readdirSync(out).map((f) => JSON.parse(readFileSync(path.join(out, f), 'utf8')) as { type: string; text: string });
    assert.deepEqual(lines.map((l) => l.type).sort(), ['action', 'done']);
    runNotify(parseConfig(TEST_YAML), r.dir, events); // 没配置时什么也不做
  } finally { r.cleanup(); }
});

function execGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
