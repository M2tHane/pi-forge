// forge-view：数据提取（阶段、角色、派生任务、度量）、打码、HTML 生成。只读，不依赖真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { hashToken } from '../../src/core/state/state-machine.ts';
import { buildViewData, renderViewHtml, ROLES } from '../../scripts/forge-view-data.ts';

const SECRET = 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx';

async function build() {
  const p = await setupProject({ stages: ['S0'] });
  const { store, flowId } = p;
  await store.setStages(flowId, [{ id: 'S1', goal: '做出登录', exit: ['登录可用'] }]);
  await store.addTasks(flowId, [
    mkTask('T-001', { stage: 'S1', role: 'backend', domain: 'auth', ac: ['REQ-001.AC1'], review: 'auto' }),
    mkTask('T-002', { stage: 'S1', kind: 'consult', role: 'architect', for_task: 'T-001' }),
    mkTask('T-001.rv', { stage: 'S1', kind: 'review', role: 'reviewer', for_task: 'T-001', writes: [] }),
    mkTask('T-001.fx-1', { stage: 'S1', kind: 'fix', role: 'worker', for_task: 'T-001' }),
    mkTask('S1.qa', { stage: 'S1', kind: 'qa', role: 'stage-qa', writes: [] }),
  ], 'architect');
  await store.appendHandoff(flowId, 'T-001', `完成登录。临时密钥 ${SECRET} 不要提交。`, 'backend');
  await store.createRun({ run_id: 'r-1', flow: flowId, task: 'T-001', role: 'backend', model: 'm/x', started_at: new Date().toISOString(), ended_at: null,
    tokens: { input: 10, output: 5, cache_read: null, cache_write: null }, outcome: null, token_hash: hashToken('t'), violations: 0 });
  return p;
}

test('buildViewData：阶段、角色、派生任务、度量都在，且已打码', async () => {
  const p = await build();
  try {
    const d = buildViewData(p.store, p.dir);
    assert.deepEqual(d.roles, [...ROLES]);
    assert.equal(d.roles.length, 7);
    const F = d.flows.find((f) => f.flow.id === p.flowId)!;
    assert.equal(F.kind, 'build');
    assert.deepEqual(F.stageRows.map((s) => s.id), ['S0', 'S1']);
    const s1 = F.stageRows.find((s) => s.id === 'S1')!;
    assert.equal(s1.goal, '做出登录');
    assert.deepEqual(s1.exit, ['登录可用']);
    assert.equal(s1.tasks, 5);
    const byId = new Map(F.tasks.map((t) => [t.id, t]));
    assert.equal(byId.get('T-001')!.domain, 'auth');
    assert.equal(byId.get('T-002')!.kind, 'consult');
    assert.deepEqual(byId.get('T-001')!.ac, ['REQ-001.AC1']);
    assert.equal(byId.get('T-001.rv')!.for_task, 'T-001');
    assert.equal(byId.get('T-001.rv')!.kind, 'review');
    assert.equal(byId.get('S1.qa')!.role, 'stage-qa');
    // 用到的角色都在角色表之内
    for (const t of F.tasks) assert.ok((d.roles as string[]).includes(t.role), t.role);
    assert.equal(d.runs[0]!.role, 'backend');
    assert.ok(F.metrics, '度量存在');
    assert.ok(Array.isArray((F.metrics as { stages: unknown[] }).stages));
    assert.ok(d.transitions.some((t) => t.trigger === 'review_changes' && t.to === 'in_progress' && t.counter === 'review_rounds'));
    assert.ok(d.stageTransitions.length > 0);
    // 打码：handoff 里的密钥不能出现在输出里
    const all = JSON.stringify(d);
    assert.ok(!all.includes(SECRET), '密钥必须被打码');
    assert.ok(F.handoffs['T-001']!.includes('完成登录'));
    assert.ok(all.includes('已打码'));
  } finally { p.cleanup(); }
});

test('renderViewHtml：自包含，内嵌 JSON 数据，不含密钥', async () => {
  const p = await build();
  const out = mkdtempSync(path.join(tmpdir(), 'forge-view-'));
  try {
    const d = buildViewData(p.store, p.dir);
    const html = renderViewHtml(d);
    const file = path.join(out, 'v.html');
    (await import('node:fs')).writeFileSync(file, html);
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('/*__DATA__*/null'), '占位符已替换');
    assert.ok(text.includes(JSON.stringify(d.flows[0]!.flow.id)), '含 JSON 数据');
    assert.ok(text.includes('"stage-qa"'));
    assert.ok(!text.includes(SECRET));
    assert.ok(!/https?:\/\//.test(text.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), '不联网');
    // 内嵌脚本语法可解析
    const script = /<script>([\s\S]*)<\/script>/.exec(text)![1]!;
    assert.doesNotThrow(() => new Function(script));
  } finally { rmSync(out, { recursive: true, force: true }); p.cleanup(); }
});
