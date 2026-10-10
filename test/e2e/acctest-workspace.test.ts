// M4：test-author 的隔离工作区（第 9.2 节）。fake-subagent 经真实的 SubagentRuntime（guard + forge_* 工具）操作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setupProject } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { accBranch } from '../../src/core/acctest.ts';

const AT = mkTask('T-001.at', {
  kind: 'acctest', role: 'test-author', scopes: ['acctest'], for_task: 'T-001', verify: [], ac: ['REQ-001.AC1', 'REQ-001.AC2'],
  writes: ['tests/acceptance/T-001/**', 'tests/acceptance/_support/T-001/**'],
});

test('隔离工作区：读不到实现提交与工作区外的绝对路径，_support/ 公共文件改不了；缺 AC 的提交被拒；通过后测试进入 acc 分支并清理工作区', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { ac: ['REQ-001.AC1', 'REQ-001.AC2'] }), AT],
    files: { 'src/server/secret.ts': 'export const impl = 1;\n', 'tests/acceptance/_support/env.ts': 'export const port = 1;\n', 'docs/spec/requirements.md': '# 需求\n' } });
  const implSha = p.git('rev-parse', 'main');
  const seen: Record<string, { ok: boolean; text: string }> = {};
  let workspace = '';
  const e = makeEngine(p, async (role, _nth, a) => {
    if (role === 'worker') { await a.call('forge_claim'); await a.call('forge_block', { reason: '本测试只看 test-author' }); return; }
    assert.equal(role, 'test-author');
    const claim = await a.call('forge_claim');
    workspace = /工作目录：(\S+)/.exec(claim.text)![1]!;
    seen['abs'] = await a.call('read', { path: path.join(p.dir, 'src/server/secret.ts') });
    seen['up'] = await a.call('read', { path: '../../' + path.basename(p.dir) + '/src/server/secret.ts' });
    seen['gitshow'] = await a.call('bash', { command: `git show ${implSha}:src/server/secret.ts` });
    seen['support'] = await a.call('write', { path: 'tests/acceptance/_support/env.ts', content: 'export const port = 2;\n' });
    seen['spec'] = await a.call('read', { path: 'docs/spec/requirements.md' });
    seen['list'] = await a.call('bash', { command: 'true -- T-001' });
    await a.call('write', { path: 'tests/acceptance/T-001/ds.test.ts', content: "test('[REQ-001.AC1] 创建成功', () => {});\n" });
    await a.call('forge_note', { text: '覆盖 AC1、AC2' });
    seen['missing'] = await a.call('forge_submit', { summary: '验收测试' });
    await a.call('write', { path: 'tests/acceptance/T-001/ds.test.ts', content: "test('[REQ-001.AC1] 创建成功', () => {});\ntest('[REQ-001.AC2] 同名失败', () => {});\n" });
    seen['submit'] = await a.call('forge_submit', { summary: '验收测试' });
  });
  try {
    await e.engine.next(p.flowId);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    assert.ok(workspace.endsWith('-at') && !workspace.startsWith(`${p.dir}/`), `隔离工作区在项目之外：${workspace}`);
    assert.equal(seen['abs']!.ok, false);
    assert.match(seen['abs']!.text, /隔离工作区之外/);
    assert.equal(seen['up']!.ok, false);
    assert.equal(seen['gitshow']!.ok, false);
    assert.match(seen['gitshow']!.text, /不能读取其他提交的内容/);
    assert.equal(seen['support']!.ok, false, '_support/ 下的公共文件不能改');
    assert.equal(seen['spec']!.ok, true);
    assert.equal(seen['list']!.ok, true, 'bash_allow 里的命令可以运行');
    assert.equal(seen['missing']!.ok, false);
    assert.match(seen['missing']!.text, /REQ-001\.AC2/);
    assert.equal(seen['submit']!.ok, true, seen['submit']!.text);
    const at = p.store.readTask(p.flowId, 'T-001.at');
    assert.equal(at.status, 'done', 'impl 未 done：以结论结束，测试随 impl 预检合入');
    const branch = accBranch(p.flowId, 'T-001');
    assert.deepEqual(p.git('diff', '--name-only', p.store.readFlow(p.flowId).integration_branch, branch).split('\n'), ['tests/acceptance/T-001/ds.test.ts']);
    assert.ok(!existsSync(workspace), '工作区已清理');
    assert.ok(p.store.readEvents().some((ev) => ev.type === 'note' && /隔离工作区：export/.test(ev.reason ?? '')));
  } finally { p.cleanup(); }
});
