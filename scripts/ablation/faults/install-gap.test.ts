// 故障注入 F1：依赖安装只发生在 test-author 的隔离工作区（第 9.2 节第 3 条）。
// worker 在自己的 worktree 里装好依赖（真实项目里是 pnpm install，产物被 .gitignore 忽略），预检与合并验证都在这个 worktree 里跑，能通过；
// 阶段门禁在集成分支 HEAD 的新临时 worktree 里跑，没有人运行 commands.install，依赖不在 → 门禁失败。
// 这个用例断言的是"现状"：它通过，说明缺口存在。修复后应改为断言门禁通过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../../../test/helpers/project.ts';
import { mkTask } from '../../../test/helpers/tasks.ts';
import { P0_SPEC } from '../../../test/helpers/spec.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../../../test/helpers/commands.ts';

const yaml = PROJECT_YAML
  .replace('install:   "true"', 'install:   "touch .deps-installed"')
  .replace(/  test:      "[^\n]*"/, '  test:      "test -f .deps-installed"');
const FILES = { ...Object.fromEntries(Object.entries(P0_SPEC).map(([k, v]) => [`docs/spec/${k}.md`, v])), '.gitignore': '.deps-installed\n' };

test('F1 现状：worker 装过依赖的 worktree 里预检、合并都通过，门禁的新 worktree 没装依赖 → 门禁失败', async () => {
  const p = await setupProject({ yaml, files: FILES, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', ac: ['REQ-001.AC1'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  const e = engineEnv(p, async (_role, _n, a) => {
    await a.call('forge_claim');
    const r = await a.call('bash', { command: 'touch .deps-installed' });
    assert.ok(r.ok, r.text);
    await writeFiles(a, { 'src/server/t-001/a.ts': 'ok\n' });
    return submitWork(a, '实现');
  });
  try {
    await drive(e, p.flowId);
    const t = p.store.readTask(p.flowId, 'T-001');
    const events = p.store.readEvents();
    const precheckOk = events.some((x) => x.task === 'T-001' && x.trigger === 'precheck_pass_skip');
    const merged = events.some((x) => x.task === 'T-001' && x.type === 'merge');
    const gateFail = events.filter((x) => x.type === 'gate_result' || x.trigger === 'gate_failed' || x.trigger === 'gate_exhausted').map((x) => `${x.trigger}:${(x.reason ?? '').split('\n')[0]}`);
    console.log(JSON.stringify({ task: t.status, precheckOk, merged, stage: p.store.readFlow(p.flowId).stage_status, gate: gateFail, tasks: p.store.listTasks(p.flowId).map((x) => `${x.id}:${x.status}`) }));
    assert.equal(t.status, 'done');
    assert.ok(precheckOk && merged, '预检与合并在 worker 的 worktree 里通过');
    assert.ok(gateFail.some((g) => /test/.test(g)), '门禁的 test 在新 worktree 里失败');
    assert.notEqual(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
});
