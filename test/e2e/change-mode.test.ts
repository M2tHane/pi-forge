// /forge-change（小改动模式）：fake-subagent 经真实的引擎、SubagentRuntime 与工具操作。
// 迷你计划两个 task（T-002 硬依赖 T-001）→ worker 实现 → 审查 → 逐个合入主分支 → 程序建 architect 的“更新架构图与契约”doc 任务
// （没改文档又没写「无需更新」被拒，写了说明后提交成功）→ X1.qa 变更确认通过 → 变更日志。
// 注意：e2e 在开发期间只做类型检查，最后统一跑一次。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { runFlowChange, runFlowCommand } from '../../src/commands/forge.ts';
import { engineEnv, submitWork } from '../helpers/commands.ts';
import { isFinished } from '../../src/core/state/state-store.ts';
import { readFixLog } from '../../src/modes/fix.ts';

const YAML = PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true');
const PLAN = [
  'title: 看板支持导出',
  'description: 在看板页加导出按钮，导出当前列表。',
  'tasks:',
  '  - title: 导出接口',
  '    writes: [src/server/t-001/**]',
  '    ac: [GET /api/export 返回 CSV]',
  '  - title: 页面按钮',
  '    writes: [src/server/t-002/**]',
  '    ac: [点击按钮下载文件]',
  '    depends_on:',
  '      - { task: T-001, type: hard }',
  '',
].join('\n');

async function settle(e: ReturnType<typeof engineEnv>, flowId: string) {
  for (let i = 0; i < 25; i++) { await e.engine.pump(flowId); await e.engine.idle(); }
}
const planFile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-plan-'));
  const file = path.join(dir, 'change.yaml');
  writeFileSync(file, PLAN);
  return file;
};

test('/forge-change：两个 task 依次合入 → doc 任务（只改术语表也能提交）→ X1.qa 通过 → 变更日志', async () => {
  const p = await setupProject({ yaml: YAML });
  const docAttempts: { ok: boolean; text: string }[] = [];
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') return submitWork(a, '导出接口', { 'src/server/t-001/a.ts': 'ok\n' });
    if (id === 'T-002') return submitWork(a, '页面按钮', { 'src/server/t-002/b.ts': 'ok\n' });
    if (id === 'T-003') {
      assert.equal(role, 'architect');
      // 只改了术语表，没改 docs/arch 或 docs/contracts：照样可以提交
      assert.ok((await a.call('write', { path: 'docs/spec/glossary.md', content: '# 术语\n- 导出：把列表保存为 CSV\n' })).ok);
      const accepted = await a.call('forge_submit', { summary: '只更新术语表' });
      docAttempts.push({ ok: accepted.ok, text: accepted.text });
      return;
    }
    assert.equal(role, 'stage-qa');
    const r = await a.call('forge_qa_report', { verdict: 'pass', issues: [] });
    assert.ok(r.ok, r.text);
  });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const msg = await runFlowChange(`--from ${planFile()}`, e.cmd);
    assert.match(msg, /已创建小改动 C-\d+/);
    const flow = p.store.readFlow(msg.match(/C-\d+/)![0]);
    assert.equal(flow.mode, 'change');
    await settle(e, flow.id);
    assert.deepEqual(e.errors, []);

    assert.equal(p.git('show', 'main:src/server/t-001/a.ts'), 'ok', '直接合入主分支');
    assert.equal(p.git('show', 'main:src/server/t-002/b.ts'), 'ok');
    const log = p.git('log', '--format=%s', 'main');
    assert.ok(log.indexOf('T-002') < log.indexOf('T-001'), 'T-002 依赖 T-001，后合入');

    assert.equal(docAttempts.length, 1);
    assert.equal(docAttempts[0]!.ok, true, docAttempts[0]!.text);
    const doc = p.store.readTask(flow.id, 'T-003');
    assert.deepEqual([doc.kind, doc.role, doc.status], ['doc', 'architect', 'done']);
    assert.equal(p.git('show', 'main:docs/spec/glossary.md').includes('导出'), true);

    assert.equal(p.store.readTask(flow.id, 'X1.qa').status, 'done');
    assert.ok(isFinished(p.store.readFlow(flow.id)));
    const fixLog = readFixLog(p.store, flow.id)!;
    assert.match(fixLog, /# 变更 C-\d+：看板支持导出/);
    assert.match(fixLog, /## 变更内容/);
    assert.match(await runFlowCommand('status', e.cmd), /变更日志|小改动/);
  } finally { p.cleanup(); }
});

test('/forge-change：确认无需更新且没有任何改动时，doc 任务直接完成，不走合并', async () => {
  const p = await setupProject({ yaml: YAML });
  const e = engineEnv(p, async (role, _n, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (id === 'T-001') return submitWork(a, '导出接口', { 'src/server/t-001/a.ts': 'ok\n' });
    if (id === 'T-002') return submitWork(a, '页面按钮', { 'src/server/t-002/b.ts': 'ok\n' });
    if (id === 'T-003') {
      const early = await a.call('forge_submit', { summary: '没有改动' });
      assert.equal(early.ok, false, '没有改动又没写说明');
      await a.call('forge_note', { text: '无需更新：架构与契约不受影响' });
      const r = await a.call('forge_submit', { summary: '无需更新' });
      assert.ok(r.ok, r.text);
      return;
    }
    assert.equal(role, 'stage-qa');
    assert.ok((await a.call('forge_qa_report', { verdict: 'pass', issues: [] })).ok);
  });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const msg = await runFlowChange(`--from ${planFile()}`, e.cmd);
    const flow = p.store.readFlow(msg.match(/C-\d+/)![0]);
    await settle(e, flow.id);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(flow.id, 'T-003').status, 'done');
    assert.ok(isFinished(p.store.readFlow(flow.id)));
  } finally { p.cleanup(); }
});
