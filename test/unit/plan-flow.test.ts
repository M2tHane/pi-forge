// 架构阶段 S0：程序派的 architect task、提交时的检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject } from '../helpers/project.ts';
import { checkArchitecture, ensureArchitectTask } from '../../src/core/plan/plan-flow.ts';
import { ARCH_FILES } from '../helpers/arch.ts';

test('ensureArchitectTask：S0 active 时建一个 architect 的 impl task；有了就不再建；打回后新建一个接着上一个的会话', async () => {
  const p = await setupProject({ stages: ['S0'] });
  try {
    const t = await ensureArchitectTask(p.store, p.config, p.flowId);
    assert.ok(t, '新建了 architect task');
    assert.deepEqual([t.id, t.kind, t.role, t.stage], ['T-001', 'impl', 'architect', 'S0']);
    for (const w of ['**', 'rules/**', 'tests/acceptance/S0-smoke/**', 'tests/acceptance/_support/**', 'tests/acceptance/T-001/**']) assert.ok(t.writes.includes(w), w);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /# S0 架构[\s\S]*docs\/plan\.md/);
    assert.equal(await ensureArchitectTask(p.store, p.config, p.flowId), null, '还在进行中');
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'cancelled', trigger: 'cancel', actor: 'human', facts: { reason: '测试' } });
    assert.equal(await ensureArchitectTask(p.store, p.config, p.flowId), null, '已有 architect task 且没要求返工');
    await p.store.setPlanRework(p.flowId, '用户打回：domain 拆得太细', 'human');
    const rework = (await ensureArchitectTask(p.store, p.config, p.flowId))!;
    assert.equal(rework.id, 'T-002');
    assert.match(rework.title, /返工/);
    assert.match(p.store.readHandoff(p.flowId, 'T-002'), /需要返工[\s\S]*domain 拆得太细/);
    assert.equal(p.store.readFlow(p.flowId).plan_rework, undefined);
  } finally { p.cleanup(); }
});

test('ensureArchitectTask：不在 S0、或计划已经落地时不建', async () => {
  const p = await setupProject({ stages: ['S1'] });
  try {
    assert.equal(await ensureArchitectTask(p.store, p.config, p.flowId), null);
  } finally { p.cleanup(); }
});

test('checkArchitecture：缺必需文件、commands.yaml 没有 test、plan.md 解析不过是错误；PRD 与计划的问题只提醒', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-arch-'));
  const write = (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
  };
  try {
    assert.equal(checkArchitecture({ dir }).errors.length, 7, '七个必需文件都缺（commands.yaml 报缺 test）');
    write(ARCH_FILES);
    const ok = checkArchitecture({ dir });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.plan?.batches.length, 2);
    assert.deepEqual(ok.warnings, ['PRD 里这些需求没有出现在任何批次：REQ-004']);
    write({ 'commands.yaml': 'commands:\n  serve: "node a.js"\n', 'docs/plan.md': ARCH_FILES['docs/plan.md']!.replace('after: [catalog]', 'after: [ghost]') });
    assert.deepEqual(checkArchitecture({ dir }).errors, ['commands.yaml 缺少 test 命令（阶段门禁与合并后回归要跑全量测试）', 'domain inventory 的 after 指向不存在的 domain ghost']);
    rmSync(path.join(dir, 'docs/prototype/products.html'));
    assert.ok(checkArchitecture({ dir }).warnings.some((w) => /PRD：页面「products」的原型文件 docs\/prototype\/products\.html 不存在/.test(w)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
