import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { initProject, formatInit } from '../../src/core/ops/init.ts';
import { preflight } from '../../src/core/spec/preflight.ts';
import { codegraphInit } from '../../src/core/ops/codegraph.ts';
import { doctor } from '../../src/core/ops/doctor.ts';
import { StateStore } from '../../src/core/state/state-store.ts';
import { nextStep, turnContext, newDrift } from '../../src/core/engine/context-injector.ts';
import { dirtyFiles } from '../../src/core/state/git.ts';
import { acquireEngineLock, releaseEngineLock, readEngineLock } from '../../src/core/ops/engine-lock.ts';
import { worktreesRoot } from '../../src/core/workspace/worktree.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask, hard } from '../helpers/tasks.ts';
const PACKAGE_ROOT = new URL('../..', import.meta.url).pathname;

const PKG = PACKAGE_ROOT;

test('/forge init：生成骨架、.gitignore、.forge 与初始提交；重复执行不覆盖、只补缺并报告差异', async () => {
  const r = tmpRepo();
  try {
    writeFileSync(path.join(r.dir, '.gitignore'), 'node_modules/');
    const first = await initProject(r.dir, PKG);
    for (const f of ['workflow.yaml', 'AGENTS.md', 'rules/global.md', 'docs/contracts/.gitkeep', 'docs/PRD.md', 'docs/prototype/README.md', 'docs/arch/.gitkeep', 'tests/acceptance/.gitkeep', '.forge/state.json']) {
      assert.ok(existsSync(path.join(r.dir, f)), f);
    }
    assert.ok(!existsSync(path.join(r.dir, 'docs/interfaces')), '不再生成 docs/interfaces/');
    assert.match(readFileSync(path.join(r.dir, 'workflow.yaml'), 'utf8'), new RegExp(`^project: ${path.basename(r.dir)}$`, 'm'));
    assert.equal(readFileSync(path.join(r.dir, '.gitignore'), 'utf8'), 'node_modules/\n\n# pi-forge\n.codegraph/\ndocs/examples/\n');
    assert.equal(first.index, null, '没传建索引函数时不建索引');
    assert.ok(first.commit);
    assert.equal(r.git('status', '--porcelain', '--', '.', ':(exclude).gitignore'), '', '骨架已提交');
    assert.match(r.git('log', '--format=%s'), /pi-forge: 初始化项目骨架/);
    assert.match(formatInit(first), /新建/);

    assert.ok(!existsSync(path.join(r.dir, 'rules/backend.md')), '项目专属规则由规划阶段生成，不再预置分层规则');
    // 用户改了规则、删了 AGENTS.md
    writeFileSync(path.join(r.dir, 'rules/global.md'), '# 我自己的规则\n');
    rmSync(path.join(r.dir, 'AGENTS.md'));
    writeFileSync(path.join(r.dir, 'docs/PRD.md'), '# 用户写好的 PRD\n');
    const eventsBefore = readFileSync(path.join(r.dir, '.forge/events.jsonl'), 'utf8');
    const second = await initProject(r.dir, PKG);
    assert.deepEqual(second.created, ['AGENTS.md']);
    assert.ok(second.differs.includes('rules/global.md'));
    assert.ok(!second.differs.includes('docs/PRD.md'), '用户写的 PRD 与模板不同是正常的');
    assert.equal(readFileSync(path.join(r.dir, 'rules/global.md'), 'utf8'), '# 我自己的规则\n', '不覆盖');
    assert.equal(readFileSync(path.join(r.dir, '.forge/events.jsonl'), 'utf8'), eventsBefore, '.forge 不重复初始化');
    assert.equal((readFileSync(path.join(r.dir, '.gitignore'), 'utf8').match(/\.codegraph/g) ?? []).length, 1);
    const third = await initProject(r.dir, PKG);
    assert.deepEqual(third.created, []);
    assert.equal(third.commit, null);
  } finally { r.cleanup(); }
});

test('/forge init：示例放进 docs/examples/ 且不提交；.gitignore 缺哪行补哪行；没有 .codegraph/ 时建一次索引', async () => {
  const r = tmpRepo();
  try {
    writeFileSync(path.join(r.dir, '.gitignore'), 'node_modules/\n# pi-forge\n.codegraph/\n');
    let calls = 0;
    const fakeIndex = async (root: string) => { calls++; mkdirSync(path.join(root, '.codegraph')); return '代码索引：已建立（假）'; };
    const first = await initProject(r.dir, PKG, undefined, fakeIndex);
    for (const f of ['docs/examples/PRD.md', 'docs/examples/prototype/login.html', 'docs/examples/prototype/tasks.html']) {
      assert.ok(existsSync(path.join(r.dir, f)), f);
      assert.ok(first.created.includes(f), f);
    }
    assert.equal(r.git('ls-files', '--', 'docs/examples'), '', '示例不提交');
    assert.equal(r.git('status', '--porcelain', '--', 'docs/examples'), '', '示例被 .gitignore 忽略');
    assert.equal(readFileSync(path.join(r.dir, '.gitignore'), 'utf8'), 'node_modules/\n# pi-forge\n.codegraph/\ndocs/examples/\n', '只补缺的 docs/examples/');
    assert.ok(first.created.includes('.gitignore（追加 docs/examples/）'));
    assert.equal(calls, 1);
    assert.equal(first.index, '代码索引：已建立（假）');
    assert.match(formatInit(first), /docs\/examples\//);
    assert.match(formatInit(first), /代码索引：已建立（假）/);

    // 用户改了示例：不覆盖、不报告差异；已有 .codegraph/ 时不再建索引
    writeFileSync(path.join(r.dir, 'docs/examples/PRD.md'), '# 改过\n');
    const second = await initProject(r.dir, PKG, undefined, fakeIndex);
    assert.equal(calls, 1);
    assert.equal(second.index, null);
    assert.ok(!second.differs.some((d) => d.startsWith('docs/examples/')));
    assert.equal(readFileSync(path.join(r.dir, 'docs/examples/PRD.md'), 'utf8'), '# 改过\n');
  } finally { r.cleanup(); }
});

test('/forge init：没装 codegraph 时只在输出里提示', async () => {
  const r = tmpRepo();
  const prev = process.env['PI_FORGE_CODEGRAPH_BIN'];
  process.env['PI_FORGE_CODEGRAPH_BIN'] = path.join(r.dir, 'no-such-codegraph');
  try {
    const rep = await initProject(r.dir, PKG, undefined, codegraphInit);
    assert.match(rep.index ?? '', /没有找到 codegraph.*codegraph init -y/);
    assert.ok(!existsSync(path.join(r.dir, '.codegraph')));
    assert.match(formatInit(rep), /没有找到 codegraph/);
  } finally {
    if (prev === undefined) delete process.env['PI_FORGE_CODEGRAPH_BIN'];
    else process.env['PI_FORGE_CODEGRAPH_BIN'] = prev;
    r.cleanup();
  }
});

test('/forge init 在非 git 目录与子目录中报错', async () => {
  const r = tmpRepo();
  try {
    mkdirSync(path.join(r.dir, 'sub'));
    await assert.rejects(initProject(path.join(r.dir, 'sub'), PKG), /仓库根目录/);
    rmSync(path.join(r.dir, '.git'), { recursive: true });
    await assert.rejects(initProject(r.dir, PKG), /git init/);
  } finally { r.cleanup(); }
});

test('preflight：报告缺失的规则、未设置模型的角色与 workflow 错误', async () => {
  const p = await setupProject();
  try {
    // 七角色共享模板中的 global 规则；显式移除该文件制造缺失场景。
    rmSync(path.join(p.dir, 'rules/global.md'));
    const items = preflight({ root: p.dir, roleSettings: { version: 1, roles: { architect: { model: 'x/y' } } }, availableModels: ['a/b'] });
    const get = (k: string) => items.find((i) => i.item === k)!;
    assert.equal(get('git').level, 'ok');
    assert.equal(get('workflow.yaml').level, 'ok');
    assert.equal(get('主分支').level, 'ok');
    assert.equal(get('规则文件').level, 'warn');
    assert.match(get('规则文件').detail, /global\.md/);
    assert.match(get('角色模型').detail, /architect 的模型 x\/y 当前不可用/);
    writeFileSync(path.join(p.dir, 'workflow.yaml'), 'version: 2\n');
    assert.equal(preflight({ root: p.dir }).find((i) => i.item === 'workflow.yaml')!.level, 'error');
  } finally { p.cleanup(); }
});

test('/forge doctor：发现队列不一致、未引用的 worktree；--fix 只做安全清理', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const clean = await doctor(p.dir, p.store);
    assert.deepEqual(clean.errors, []);
    mkdirSync(worktreesRoot(p.dir), { recursive: true });
    p.git('worktree', 'add', '-q', '-b', 'stray', path.join(worktreesRoot(p.dir), 'stray'));
    mkdirSync(path.join(worktreesRoot(p.dir), '.runs', 'r-gone'), { recursive: true });
    const r = await doctor(p.dir, p.store);
    assert.ok(r.warnings.some((w) => w.includes('未被任何任务引用的 worktree')), r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => w.includes('提示文件可清理')));
    const fixed = await doctor(p.dir, p.store, { fix: true });
    assert.equal(fixed.fixed.length, 2);
    assert.ok(!existsSync(path.join(worktreesRoot(p.dir), 'stray')));
    // 篡改后报告完整性错误
    const f = path.join(p.dir, `.forge/flows/${p.flowId}/tasks/T-001.json`);
    writeFileSync(f, readFileSync(f, 'utf8').replace('"pending"', '"queued_merge"'));
    const bad = await doctor(p.dir, new StateStore(p.dir));
    assert.ok(bad.errors.some((e) => e.includes('完整性')));
    assert.ok(bad.errors.some((e) => e.includes('不在合并队列中')));
  } finally { p.cleanup(); }
});

test('唯一允许的下一步：dispatch → wait → 报告阻塞；闸门等待人工', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001'), mkTask('T-002', { deps: [hard('T-001')] })] });
  try {
    let s = nextStep(p.store, 2);
    assert.equal(s.tool, 'forge_wait');
    assert.equal(s.task, undefined);
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 's' });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'd', patch: {
      lease: { run_id: 'r', role: 'worker', token_hash: 'a'.repeat(64), acquired_at: 'x', expires_at: '2999-01-01T00:00:00Z' },
      worktree: '/w', branch: 'b', base_sha: 'c' } });
    s = nextStep(p.store, 2);
    assert.equal(s.tool, 'forge_wait');
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'blocked', trigger: 'block', actor: 'x', facts: { reason: '需求有歧义' } });
    // 程序或子进程造成的阻塞先交给主会话决定
    s = nextStep(p.store, 2);
    assert.equal(s.tool, 'forge_decide');
    assert.equal(s.task, 'T-001');
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'blocked', trigger: 'hand_to_user', actor: 'orchestrator', facts: { reason: '要用户决定' } });
    s = nextStep(p.store, 2);
    assert.equal(s.tool, 'none');
    assert.match(s.next, /T-001（需求有歧义\n主会话：要用户决定）.*\/forge unblock/s);
    assert.match(turnContext(p.store, 2), /^\[pi-forge 状态\][\s\S]*\[唯一允许的下一步\]/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    assert.match(nextStep(p.store, 2).next, /\/forge-approve/);
  } finally { p.cleanup(); }
});

test('主工作区越权检测：只报告本轮新出现的改动，忽略 .forge/', async () => {
  const p = await setupProject();
  try {
    writeFileSync(path.join(p.dir, 'user-edit.ts'), 'x');
    const before = dirtyFiles(p.dir);
    writeFileSync(path.join(p.dir, 'agent-edit.ts'), 'x');
    writeFileSync(path.join(p.dir, '.forge', 'scratch'), 'x');
    assert.deepEqual(newDrift(before, dirtyFiles(p.dir)), ['agent-edit.ts']);
  } finally { p.cleanup(); }
});

test('引擎锁：另一个存活进程持有时拒绝；持有者退出后可接管', async () => {
  const p = await setupProject();
  try {
    assert.equal(acquireEngineLock(p.dir, 999_999_1), null);
    assert.equal(acquireEngineLock(p.dir), null, '持有者进程不存在时接管');
    assert.equal(readEngineLock(p.dir)!.pid, process.pid);
    const holder = acquireEngineLock(p.dir, 1);
    assert.equal(holder?.pid, process.pid);
    releaseEngineLock(p.dir);
    assert.equal(readEngineLock(p.dir), null);
  } finally { p.cleanup(); }
});

test('/forge doctor：互相等待的任务列为问题（停滞）', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { deps: [hard('T-002')] }), mkTask('T-002', { deps: [hard('T-001')] })] });
  try {
    const r = await doctor(p.dir, p.store);
    assert.ok(r.errors.some((e) => /停滞：T-001、T-002 互相等待/.test(e)), r.errors.join('\n'));
  } finally { p.cleanup(); }
});
