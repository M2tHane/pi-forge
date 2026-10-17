// scripts/real-build.ts 的纯函数：实验配置、交付判断、模拟用户的规则表、会话用量去重、返工与冲突计数、隐藏测试计分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { applyExperimentConfig, delivered, parseArgs } from '../../scripts/real-build.ts';
import { parseHidden, reworkStats, roleUsage, scoreHidden, type SessionEntry } from '../../scripts/real-build/common.ts';
import { apply, decide, initialState, CONFIRM_MERGE_OPTION, type Snapshot } from '../../scripts/real-build/user.ts';

const ROOT = path.join(import.meta.dirname, '../..');

test('实验配置：按角色写模型档位与思考级别，模板里没有的角色跳过，关闭升级，兜底用写代码的模型', () => {
  const o = parseArgs(['--max-parallel-backend', '1']);
  const y = parse(applyExperimentConfig(readFileSync(path.join(ROOT, 'templates/workflow.yaml'), 'utf8'), o));
  assert.equal(y.roles.architect.model, 'planner');
  assert.equal(y.roles.architect.thinking, 'medium');
  assert.equal(y.roles.reviewer.model, 'reviewer');
  assert.equal(y.roles['stage-qa'].thinking, 'high');
  assert.equal(y.roles.worker.model, 'coder');
  assert.equal(y.roles.worker.thinking, 'low');
  assert.equal(y.models.coder, 'magpie/workbuddy/glm-5.3-flash');
  assert.equal(y.models.fallback, y.models.coder);
  assert.equal(y.escalation.enabled, false);
  assert.equal(y.limits.max_parallel_backend, 1);
  for (const r of ['backend', 'frontend']) if (y.roles[r]) assert.equal(y.roles[r].model, 'coder', r);
  assert.throws(() => parseArgs(['--prd', 'x.md']), /不再支持/);
});

test('交付：最后一个批次阶段 done 才算；架构阶段批准前 S0 是最后一个阶段，它的 done 不算', () => {
  assert.equal(delivered({ stage: 'S0', stage_status: 'done', stages: ['S0'] }), false);
  assert.equal(delivered({ stage: 'S1', stage_status: 'done', stages: ['S0', 'S1', 'S2'] }), false);
  assert.equal(delivered({ stage: 'S2', stage_status: 'done', stages: ['S0', 'S1', 'S2'] }), true);
});

test('模拟用户：架构批准与批次签收都发 /forge-approve；交付确认选确认合入且不重复计闸门；等架构师的阻塞不处理', () => {
  const flow = { id: 'B-001', stage: 'S0', stageStatus: 'awaiting_human', version: 3 };
  const snap: Snapshot = { nowMs: 1000, flow, tasks: [] };
  const a = decide(snap, initialState());
  assert.equal(a?.kind, 'prompt');
  assert.equal(a?.kind === 'prompt' && a.message, '/forge-approve');
  let s = apply(initialState(), a!, 1000);
  assert.equal(s.counts.gate, 1);
  const confirm = decide({ nowMs: 2000, ui: { id: 'u1', method: 'select', options: [CONFIRM_MERGE_OPTION, '取消'] }, flow: null, tasks: [] }, s);
  assert.equal(confirm?.kind === 'ui_response' && confirm.summary, CONFIRM_MERGE_OPTION);
  s = apply(s, confirm!, 2000);
  assert.equal(s.counts.gate, 1);
  const waiting = decide({ nowMs: 3000, flow: { ...flow, stage: 'S1', stageStatus: 'active' }, tasks: [{ id: 'T-002', status: 'blocked', blockedBy: 'architect', blockedReason: '等架构师', version: 1 }] }, s);
  assert.equal(waiting, null);
});

test('会话用量：同一角色里条目 id 与时间相同的只算一次（续做的 run 复制了之前的会话），命中率 = 命中 /（输入 + 命中）', () => {
  const call = (id: string, cost: number, tools: { name: string; command?: string }[] = []): SessionEntry => ({
    id, timestamp: `t-${id}`,
    message: { role: 'assistant', usage: { input: 10, cacheRead: 90, output: 5, cost: { total: cost } }, content: tools.map((t) => ({ type: 'toolCall', name: t.name, arguments: { command: t.command } })) },
  });
  const first = [call('a', 0.1, [{ name: 'bash', command: 'npm test' }]), { message: { role: 'user' } }];
  const forked = [...first, call('b', 0.2, [{ name: 'bash', command: 'node pw.js open' }])];
  const u = roleUsage([{ role: 'backend', entries: first }, { role: 'backend', entries: forked }, { role: 'reviewer', entries: first }]);
  assert.equal(u['backend']!.calls, 2);
  assert.equal(u['backend']!.cost, 0.3);
  assert.equal(u['backend']!.tool_calls, 2);
  assert.equal(u['backend']!.browser_cmds, 1);
  assert.equal(u['backend']!.hit_pct, 90);
  assert.equal(u['reviewer']!.calls, 1);
});

test('返工：写代码角色同一任务第一个 run 之后的都算返工，修复任务单列；冲突按事件计；审查轮数按 .rv 任务计', () => {
  const tasks = [
    { id: 'T-001', kind: 'impl' }, { id: 'T-002', kind: 'impl' }, { id: 'T-003', kind: 'impl' },
    { id: 'T-002.rv', kind: 'review' }, { id: 'T-002.rv-2', kind: 'review' }, { id: 'T-003.rv', kind: 'review' },
    { id: 'T-002.fx-1', kind: 'fix' }, { id: 'C-001', kind: 'consult' },
  ];
  const runs = [
    { role: 'architect', task: 'T-001', started_at: '1' }, { role: 'architect', task: 'T-001', started_at: '2' },
    { role: 'backend', task: 'T-002', started_at: '3' }, { role: 'reviewer', task: 'T-002.rv', started_at: '4' },
    { role: 'backend', task: 'T-002', started_at: '5' }, { role: 'backend', task: 'T-002', started_at: '6' },
    { role: 'frontend', task: 'T-003', started_at: '7' }, { role: 'frontend', task: 'T-002.fx-1', started_at: '8' },
    { role: 'architect', task: 'C-001', started_at: '9' },
  ];
  const events = [
    { flow: 'B-001', type: 'transition', trigger: 'merge_conflict', task: 'T-002' },
    { flow: 'B-001', type: 'note', task: 'T-002', data: { kind: 'sync_conflict', files: ['a.ts'] } },
    { flow: 'B-001', type: 'transition', trigger: 'review_changes', task: 'T-002' },
    { flow: 'B-002', type: 'transition', trigger: 'merge_conflict', task: 'T-009' },
  ];
  const r = reworkStats(runs, tasks, events, 'B-001');
  assert.deepEqual(r.by_role['backend'], { tasks: 1, first_runs: 1, rework_runs: 2, fix_runs: 0 });
  assert.deepEqual(r.by_role['frontend'], { tasks: 1, first_runs: 1, rework_runs: 0, fix_runs: 1 });
  assert.deepEqual(r.by_role['architect'], { tasks: 1, first_runs: 1, rework_runs: 1, fix_runs: 0 });
  assert.equal(r.rework_runs, 2);
  assert.deepEqual(r.conflicts, { merge: 1, sync: 1 });
  assert.equal(r.review_rounds, 3);
  assert.deepEqual(r.review_rounds_max, { task: 'T-002', rounds: 2 });
});

test('隐藏测试：按组计分，失败用例带组名', () => {
  const s = scoreHidden(parseHidden('## 一期：用户（1/2）\n✓ 登录\n✗ 停用：期望 401\n## 页面（1/1）\n✓ /login\n合计：2/3\n'));
  assert.equal(s.passed, 2);
  assert.equal(s.total, 3);
  assert.deepEqual(s.groups['一期：用户'], { passed: 1, total: 2 });
  assert.deepEqual(s.failed, ['一期：用户：停用']);
});
