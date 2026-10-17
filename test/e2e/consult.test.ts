// 架构师问答与签收打回：fake-subagent 经真实的引擎、SubagentRuntime 与工具操作。
// 子 agent 提问（answer / change）→ 咨询任务（architect）回答 → 提问的任务同步集成分支后接着原会话继续；
// 主会话提问 → forge_wait 返回回答；签收打回 → 能归属的交给负责任务（fix），归属不清的交给架构师。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { hard, mkTask } from '../helpers/tasks.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { sessionDirOf } from '../../src/core/engine/session-log.ts';
import { pendingDecisions } from '../../src/core/engine/decisions.ts';
import { nextStep } from '../../src/core/engine/context-injector.ts';
import { rejectStage } from '../../src/core/stage/stages.ts';
import { flowAskArchitectMain, flowDecide, flowWait } from '../../src/tools/orchestrator-tools.ts';

const YAML = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');

/** 模拟 pi 的会话留档：之后的运行才能接着这次的对话 */
function keepSession(p: Project, a: FakeAgent): void {
  const dir = sessionDirOf(p.dir, a.env.run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 's.jsonl'), '{"type":"session"}\n');
}

const launchesOf = (e: { launcher: { launched: { env: Record<string, string>; prompt: string; forkFrom?: string }[] } }, task: string) =>
  e.launcher.launched.filter((s) => s.env['PI_FORGE_TASK'] === task);

test('子 agent 提问（answer）：任务等架构师、不交给主会话 → 咨询任务回答并记 decisions.md → 回答写进 handoff，提问的任务接着原会话继续并完成', async () => {
  const p = await setupProject({ yaml: YAML, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', role: 'backend' })] });
  const seen: Record<string, unknown> = {};
  const e = engineEnv(p, async (role, nth, a) => {
    await a.call('forge_claim');
    if (role === 'backend' && nth === 1) {
      keepSession(p, a);
      await writeFiles(a, { 'src/server/t-001/a.ts': '// 列表接口，分页参数待定\n' });
      const r = await a.call('forge_ask_architect', { question: '列表接口的分页参数叫什么？我建议 page 与 size', kind: 'answer' });
      assert.ok(r.ok, r.text);
      assert.match(r.text, /已交给架构师（T-002）[\s\S]*接着这次的对话继续/);
      return;
    }
    if (role === 'architect') {
      const t1 = p.store.readTask(p.flowId, 'T-001');
      seen['waiting'] = [t1.status, t1.blocked_by, t1.blocked_owner ?? null];
      seen['decisions'] = pendingDecisions(p.store, p.flowId).length;
      assert.match(p.store.readHandoff(p.flowId, a.env.task), /提问方：T-001[\s\S]*类型：answer[\s\S]*分页参数叫什么/);
      await writeFiles(a, { 'docs/arch/decisions.md': '# 架构决定\n- T-001 问分页参数：用 page 与 size\n' });
      const r = await a.call('forge_answer', { text: '用 page（从 1 开始）与 size（默认 20）。' });
      assert.ok(r.ok, r.text);
      return;
    }
    if (role === 'backend') {
      seen['resumed'] = await a.call('read', { path: 'src/server/t-001/a.ts' });
      return submitWork(a, '分页按 page、size 实现', { 'src/server/t-001/a.ts': 'export const page = 1, size = 20;\n' });
    }
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.deepEqual(seen['waiting'], ['blocked', 'architect', null], '提问的任务在等架构师，不交给主会话');
    assert.equal(seen['decisions'], 0, '"等架构师"不出现在主会话的待决定事项里');
    const c = p.store.readTask(p.flowId, 'T-002');
    assert.deepEqual([c.kind, c.role, c.stage, c.for_task, c.status], ['consult', 'architect', 'S1', 'T-001', 'done']);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.id.startsWith('T-002.rv')), '咨询不审查');
    assert.match(p.git('show', `${p.store.readFlow(p.flowId).integration_branch}:docs/arch/decisions.md`), /page 与 size/, 'decisions.md 合入了集成分支');
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /架构师的回答（T-002）：\n用 page（从 1 开始）/);
    const runs = launchesOf(e, 'T-001');
    assert.equal(runs.length, 2);
    assert.ok(runs[1]!.forkFrom?.endsWith('s.jsonl'), '接着提问时的会话');
    assert.match(runs[1]!.prompt, /## 架构师的回答\n用 page（从 1 开始）/);
    assert.ok((seen['resumed'] as { ok: boolean }).ok, '工作区保留着提问前的改动');
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
  } finally { p.cleanup(); }
});

test('子 agent 提问（change）：架构师修改公共代码并随回答提交 → 经合并队列合入集成分支 → 提问的任务同步后看到修改并完成', async () => {
  const p = await setupProject({ yaml: YAML, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', role: 'backend' })], files: { 'src/shared/errors.ts': 'export const E1 = 1;\n' } });
  const seen: Record<string, string> = {};
  const e = engineEnv(p, async (role, nth, a) => {
    await a.call('forge_claim');
    if (role === 'backend' && nth === 1) {
      keepSession(p, a);
      await writeFiles(a, { 'src/server/t-001/a.ts': '// 用到 E1\n' });
      assert.ok((await a.call('forge_ask_architect', { question: '错误码 E1 的名字看不出含义，要改成 E_NOT_FOUND', kind: 'change' })).ok);
      return;
    }
    if (role === 'architect') {
      assert.match(p.store.readHandoff(p.flowId, a.env.task), /类型：change/);
      await writeFiles(a, { 'src/shared/errors.ts': 'export const E_NOT_FOUND = 1;\n', 'docs/arch/decisions.md': '- E1 改名为 E_NOT_FOUND\n' });
      const r = await a.call('forge_answer', { text: '已把 E1 改名为 E_NOT_FOUND（src/shared/errors.ts）。' });
      assert.match(r.text, /与 2 个文件的改动/);
      return;
    }
    if (role === 'backend') {
      seen['shared'] = (await a.call('read', { path: 'src/shared/errors.ts' })).text;
      seen['own'] = (await a.call('read', { path: 'src/server/t-001/a.ts' })).text;
      return submitWork(a, '改用 E_NOT_FOUND', { 'src/server/t-001/a.ts': 'import { E_NOT_FOUND } from "../../shared/errors";\n' });
    }
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    const integ = p.store.readFlow(p.flowId).integration_branch;
    assert.equal(p.git('show', `${integ}:src/shared/errors.ts`), 'export const E_NOT_FOUND = 1;');
    assert.ok(e.merges.some((m) => m.kind === 'merged' && m.task === 'T-002'), '咨询的修改经合并队列合入');
    assert.equal(seen['shared'], 'export const E_NOT_FOUND = 1;\n', '提问的任务同步了集成分支');
    assert.equal(seen['own'], '// 用到 E1\n', '自己提问前的改动还在');
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /已把 E1 改名为 E_NOT_FOUND[\s\S]*程序已把集成分支（含架构师的修改）同步进你的工作区/);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(p.git('show', `${integ}:src/server/t-001/a.ts`), /E_NOT_FOUND/);
  } finally { p.cleanup(); }
});

test('主会话提问：forge_wait 返回架构师的回答（只交一次）；第一次咨询带上 decisions.md，第二次接着上一次咨询的会话', async () => {
  // T-001 等着下一阶段的 T-009，本阶段不会结束，只有咨询在跑
  const p = await setupProject({ yaml: YAML, stages: ['S1', 'S2'], files: { 'docs/arch/decisions.md': '# 架构决定\n- 金额按分存整数\n' },
    tasks: [mkTask('T-001', { stage: 'S1', deps: [hard('T-009')] }), mkTask('T-009', { stage: 'S2' })] });
  let n = 0;
  const e = engineEnv(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    await a.call('forge_claim');
    keepSession(p, a);
    n++;
    await writeFiles(a, { 'docs/arch/decisions.md': `# 架构决定\n- 金额按分存整数\n- 第 ${n} 次咨询\n` });
    assert.ok((await a.call('forge_answer', { text: n === 1 ? '金额用整数分，前端显示时除以 100。' : '导出用 CSV。' })).ok);
  });
  try {
    const asked = await flowAskArchitectMain(p.store, p.config, e.engine, { question: '用户问：金额怎么存？', kind: 'answer' });
    assert.match(asked.text, /已交给架构师（T-010）[\s\S]*forge_wait/);
    assert.equal(nextStep(p.store, 3, 0, p.config).tool, 'forge_wait');
    const w = await flowWait(p.store, e.engine, { timeout_s: 30 }, p.config);
    assert.match(w.text, /架构师的回答（T-010）：\n金额用整数分/);
    await e.engine.idle();
    const again = await flowWait(p.store, e.engine, { timeout_s: 1 }, p.config);
    assert.doesNotMatch(again.text, /架构师的回答/, '同一个回答只交一次');

    await flowAskArchitectMain(p.store, p.config, e.engine, { question: '用户问：导出用什么格式？', kind: 'answer' });
    await e.engine.idle();
    const w2 = await flowWait(p.store, e.engine, { timeout_s: 30 }, p.config);
    assert.match(w2.text, /架构师的回答（T-011）：\n导出用 CSV/);
    assert.deepEqual(e.errors, []);
    const [first] = launchesOf(e, 'T-010');
    const [second] = launchesOf(e, 'T-011');
    assert.equal(first!.forkFrom, undefined);
    assert.match(first!.prompt, /之前的架构决定（docs\/arch\/decisions\.md）[\s\S]*金额按分存整数/, '开新会话时带上 decisions.md');
    assert.ok(second!.forkFrom?.endsWith('s.jsonl'), '接着上一次咨询的会话');
    assert.match(second!.prompt, /## 接着你之前的对话[\s\S]*T-010/);
    assert.doesNotMatch(second!.prompt, /之前的架构决定/);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'pending');
  } finally { p.cleanup(); }
});

test('签收打回：主会话把能归属的修改交给负责的任务（fix，接着它的会话），归属不清的交给架构师；都合入后重新验收、再等签收', async () => {
  const p = await setupProject({ yaml: YAML, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1' }), mkTask('T-002', { stage: 'S1' })] });
  const e = engineEnv(p, async (role, _nth, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (role === 'architect') {
      await writeFiles(a, { 'src/shared/sort.ts': 'export const byName = 1;\n', 'docs/arch/decisions.md': '- 列表统一按名称排序\n' });
      assert.ok((await a.call('forge_answer', { text: '加了公共的 byName 排序。' })).ok);
      return;
    }
    if (id === 'T-002.fx-1') {
      assert.match(p.store.readHandoff(p.flowId, id), /用户签收发现的问题[\s\S]*用户签收阶段 S1 时打回：列表要按名称排序[\s\S]*T-002 的列表接口按名称排序/);
      return submitWork(a, '按名称排序', { 'src/server/t-002/a.ts': 'sorted\n' });
    }
    return submitWork(a, id, { [`src/server/${id.toLowerCase()}/a.ts`]: `${id}\n` });
  });
  try {
    await drive(e, p.flowId);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    const decide = (target: string, note: string) => flowDecide(p.dir, p.store, p.config, e.engine, { target, decision: 'fix', note });
    await assert.rejects(decide('T-002', '还没打回'), /fix 只用于用户签收时打回之后/);
    await rejectStage({ root: p.dir, store: p.store, config: p.config }, p.flowId, '列表要按名称排序');
    assert.match(nextStep(p.store, 3, 0, p.config).next, /decision=fix[\s\S]*forge_ask_architect[\s\S]*T-001 任务 T-001；T-002 任务 T-002/);
    await assert.rejects(decide('T-002.rv', '审查任务不行'), /不是已完成的实现任务/);
    assert.match((await decide('T-002', 'T-002 的列表接口按名称排序')).text, /已为 T-002 建修复任务 T-002\.fx-1/);
    await flowAskArchitectMain(p.store, p.config, e.engine, { question: '用户要求所有列表按名称排序，需要一个公共排序', kind: 'change' });
    const fx = p.store.readTask(p.flowId, 'T-002.fx-1');
    assert.deepEqual([fx.kind, fx.role, fx.stage, fx.for_task, fx.fork_from_task], ['fix', 'worker', 'S1', 'T-002', 'T-002']);
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-002.fx-1').status, 'done', p.store.readTask(p.flowId, 'T-002.fx-1').blocked_reason ?? '');
    assert.equal(p.store.readTask(p.flowId, 'T-003').status, 'done');
    const integ = p.store.readFlow(p.flowId).integration_branch;
    assert.equal(p.git('show', `${integ}:src/server/t-002/a.ts`), 'sorted');
    assert.equal(p.git('show', `${integ}:src/shared/sort.ts`), 'export const byName = 1;');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human', '修改合入后重新验收，再等签收');
    await assert.rejects(decide('T-001', '已经重新验收过了'), /fix 只用于/);
  } finally { p.cleanup(); }
});
