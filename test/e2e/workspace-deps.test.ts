// F1（docs/ADVERSARIAL-REVIEW.md 4.1）：依赖安装不再只发生在 test-author 的隔离工作区。
// 用 install: "touch .deps-installed" 加 .gitignore 忽略标记文件来模拟 node_modules（被 git 忽略、新 worktree 里没有）。
// 覆盖三条路径：(a) 阶段门禁的临时 worktree；(b) stage-qa 的临时 worktree；(c) 批量合并的临时 worktree。
// 任务 worktree 在派发时由程序 install，worker 不需要自己装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML, DIRECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { hard, mkTask } from '../helpers/tasks.ts';
import { P0_SPEC } from '../helpers/spec.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';
import { flowMetrics, renderMetrics } from '../../src/core/stage/signoff.ts';

const withDeps = (yaml: string, test: string) => yaml
  .replace('install:   "true"', 'install:   "touch .deps-installed"')
  .replace(/  test:      "[^\n]*"/, `  test:      "${test}"`)
  .replace('\nlimits:', '\nacctest_workspace:\n  cache: [.deps-installed]\nlimits:');
// 有包清单与锁文件才会 install（S0 还没有清单时跳过）
const DEPS = { 'package.json': '{"name":"app"}\n', 'pnpm-lock.yaml': 'lockfileVersion: 1\n', '.gitignore': '.deps-installed\n' };
const SPEC = Object.fromEntries(Object.entries(P0_SPEC).map(([k, v]) => [`docs/spec/${k}.md`, v]));

const prepared = (p: { store: { readEvents: () => { type: string; data?: Record<string, unknown> | undefined; actor: string }[] } }) =>
  p.store.readEvents().filter((e) => e.type === 'note' && e.data?.['kind'] === 'workspace_prepare');

test('(a) 门禁：任务 worktree 在派发时装好依赖（worker 不用自己装），门禁的新 worktree 也有依赖 → 门禁通过、不转 needs_human 的失败分支', async () => {
  // 关掉覆盖率矩阵：这里只看门禁命令（没有验收测试 task 时矩阵必然有缺口）
  const yaml = withDeps(PROJECT_YAML, 'test -f .deps-installed').replace(/^  coverage: true/m, '  coverage: false');
  const p = await setupProject({ yaml, files: { ...SPEC, ...DEPS }, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    const r = await a.call('bash', { command: 'test -f .deps-installed && echo HAS || echo MISSING' });
    assert.match(r.text, /HAS/, '任务 worktree 在派发时已经装好依赖');
    await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' });
    return submitWork(a, '实现');
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    const events = p.store.readEvents();
    assert.ok(!events.some((x) => x.trigger === 'gate_failed' || x.trigger === 'gate_exhausted'), `门禁没有失败：${JSON.stringify(events.filter((x) => x.trigger?.startsWith('gate')).map((x) => x.reason))}`);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human', '门禁通过，等签收');
    // 观测：任务 worktree 可写（装了一次）、门禁的 worktree 只读；/forge-status --metrics 能汇总
    const modes = prepared(p).map((x) => x.data!['mode']);
    assert.ok(modes.includes('writable'), modes.join());
    const m = flowMetrics(p.store, p.flowId, new Date(), p.dir);
    assert.ok(m.workspace.count >= 1 && m.workspace.failed === 0, JSON.stringify(m.workspace));
    assert.match(renderMetrics(m), /工作区准备 \d+ 次.*缓存命中 \d+ 次/);
  } finally { p.cleanup(); }
});

test('(a0) 还没有依赖清单（S0 之前）：不 install，任务说明提示 worker 建好清单后自己运行 install', async () => {
  const yaml = withDeps(PROJECT_YAML, 'true').replace(/^  coverage: true/m, '  coverage: false');
  const p = await setupProject({ yaml, files: { ...SPEC }, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  let prompt = '';
  const e = engineEnv(p, async (_role, _n, a) => {
    if (!prompt) prompt = a.spec.prompt;
    await a.call('forge_claim');
    const r = await a.call('bash', { command: 'test -f .deps-installed && echo HAS || echo MISSING' });
    assert.match(r.text, /MISSING/, '没有清单时程序不 install');
    await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' });
    return submitWork(a, '实现');
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.match(prompt, /项目还没有依赖清单[\s\S]*自己运行 install（`touch \.deps-installed`），再跑测试/);
    assert.ok(prepared(p).some((x) => x.data!['skipped'] === true));
  } finally { p.cleanup(); }
});

test('(a2) 门禁的工作区准备失败 → 不生成 fix，直接 needs_human 并带着原因', async () => {
  // 任务 worktree 的 install 能过，门禁的 install 失败（标记文件存在于主分支提交里则跳过失败：用"第二次起失败"模拟）
  const yaml = withDeps(PROJECT_YAML, 'true').replace('install:   "touch .deps-installed"', 'install:   "test ! -f ../install-ran-once && touch ../install-ran-once && touch .deps-installed"')
    .replace('\nlimits:', '\nshared_env:\n  enabled: false   # 共享构建环境会让门禁直接链接依赖，这里要验证的是门禁自己 install 失败的分支\nlimits:');
  const p = await setupProject({ yaml, files: { ...SPEC, ...DEPS }, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' });
    return submitWork(a, '实现');
  });
  try {
    await drive(e, p.flowId);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'needs_human');
    const events = p.store.readEvents();
    assert.ok(events.some((x) => /工作区准备失败/.test(x.reason ?? '')), '原因里写了工作区准备失败');
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'fix'), '没有生成 fix');
  } finally { p.cleanup(); }
});

test('(b) stage-qa：临时 worktree 里有依赖（readonly，走缓存）', async () => {
  const yaml = withDeps(PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true'), 'test -f .deps-installed');
  const REQS = P0_SPEC.requirements;
  const impl = mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1'] });
  const at = mkTask('T-001.at', { stage: 'S1', kind: 'acctest', role: 'test-author', scopes: ['acctest'], for_task: 'T-001', verify: [], ac: ['REQ-001.AC1'],
    depends_on: [], writes: ['tests/acceptance/T-001/**', 'tests/acceptance/_support/T-001/**'] });
  const p = await setupProject({ yaml, files: { ...SPEC, 'docs/spec/requirements.md': REQS, ...DEPS }, stages: ['S1'], tasks: [impl, at] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  const qaSeen: string[] = [];
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') { await writeFiles(a, { 'src/server/t-001/a.ts': 'v1\n' }); return submitWork(a, '实现'); }
    if (id === 'T-001.at') { await writeFiles(a, { 'tests/acceptance/T-001/a.test.ts': "test('[REQ-001.AC1] 返回编号', () => {});\n" }); return submitWork(a, 'AC1'); }
    assert.equal(role, 'stage-qa');
    const r = await a.call('bash', { command: 'test -f .deps-installed && echo HAS || echo MISSING' });
    qaSeen.push(r.text.trim());
    const q = await a.call('forge_qa_report', { verdict: 'pass', issues: [] });
    assert.ok(q.ok, q.text);
  });
  try {
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    assert.deepEqual(qaSeen, ['HAS'], 'stage-qa 的临时 worktree 里有依赖');
    assert.equal(p.store.readTask(p.flowId, 'S1.qa').status, 'done');
    assert.ok(prepared(p).some((x) => x.data!['mode'] === 'readonly' && x.data!['ok'] === true && x.data!['skipped'] === false), '只读准备记了事件');
  } finally { p.cleanup(); }
});

test('(c) 批量合并：临时 worktree 里有依赖 → 整批一次合并成功（有 batch evidence），不退回逐个合并', async () => {
  // merge_check（偏离 117：合并只跑它）依赖标记文件：批量合并的临时 worktree 没装依赖时会失败并退回逐个合并
  const yaml = withDeps(DIRECT_YAML.replace(/^  max_parallel: 2$/m, '  max_parallel: 3'), 'test -f .deps-installed').replace(/(  acceptance_list: .*\n)/, '$1  merge_check: "test -f .deps-installed"\n');
  const p = await setupProject({ yaml, files: DEPS, tasks: ['T-001', 'T-002', 'T-003'].map((id) => mkTask(id, { verify: ['test'] })) });
  try {
    let waited = false;
    const beforeMerge = async () => {
      if (waited) return;
      waited = true;
      const end = Date.now() + 60_000;
      while (p.store.readMergeQueue().queue.length < 3) { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); }
    };
    const { engine, merges, errors } = makeEngine(p, async (_role, _n, a) => {
      const id = a.env.task.toLowerCase();
      await a.call('forge_claim');
      await writeFiles(a, { [`src/server/${id}/a.ts`]: id });
      await a.call('forge_note', { text: '完成' });
      assert.ok((await a.call('forge_submit', { summary: id })).ok);
    }, undefined, { beforeMerge });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    for (const id of ['T-001', 'T-002', 'T-003']) assert.equal(p.store.readTask(p.flowId, id).status, 'done', id);
    assert.deepEqual(merges.map((m) => (m.kind === 'merged' ? [...m.finished].sort() : m.kind)), [['T-001', 'T-002', 'T-003']], '整批一次合并');
    const batch = p.store.readEvents().filter((x) => x.type === 'merge');
    assert.ok(batch.length === 3 && batch.every((x) => Array.isArray(x.data?.['batch']) && (x.data['batch'] as string[]).length === 3), 'merge 事件带 batch');
    assert.ok(!p.store.readEvents().some((x) => /批量合并 .* 失败，改为逐个合并/.test(x.reason ?? '')));
    assert.ok(prepared(p).some((x) => x.actor === 'merge-queue' && x.data!['mode'] === 'readonly'), '批量合并的临时 worktree 记了只读准备');
  } finally { p.cleanup(); }
});
