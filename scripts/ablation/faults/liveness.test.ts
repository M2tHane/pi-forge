// 故障注入 F2：停滞（活性）能否由纯函数在第一次 pump 时就发现，而不是等 e2e 超时。
// 原型：等待图 waitsOn —— 每个未结束的 task 指向它在等的 task（pending 等硬依赖，awaiting_inputs 等验收测试、软依赖、waits_for）；
// 图里有环，或等的是 blocked / cancelled 的 task，就是停滞。
// 用偏离 72 的现场验证：S0 的 impl 在 awaiting_inputs，它的 .at 硬依赖它（impl 合入后才写）。
// 偏离 72 之前的等待规则（latestAcctest）在这里成环；现行规则（awaitedAcctest）不成环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskFile } from '../../../src/core/schemas.ts';
import { awaitedAcctest, latestAcctest } from '../../../src/core/acceptance-flow.ts';
import { hard, mkTask, soft } from '../../../test/helpers/tasks.ts';

type Pick = (tasks: readonly TaskFile[], impl: string) => TaskFile | undefined;
const OPEN = (t: TaskFile) => t.status !== 'done' && t.status !== 'cancelled';

/** t 在等哪些 task（未 done 的）；in_progress、checking、queued_merge、merging 由运行者或程序步骤推进，不等别人 */
export function waitsOn(t: TaskFile, tasks: readonly TaskFile[], pick: Pick = awaitedAcctest): string[] {
  const notDone = (id: string) => tasks.find((x) => x.id === id)?.status !== 'done';
  if (t.status === 'pending') return t.depends_on.filter((d) => d.type === 'hard' && notDone(d.task)).map((d) => d.task);
  if (t.status !== 'awaiting_inputs') return [];
  const at = pick(tasks, t.for_task ?? t.id);
  return [...(at && at.status !== 'done' ? [at.id] : []), ...t.depends_on.filter((d) => d.type === 'soft' && notDone(d.task)).map((d) => d.task), ...(t.waits_for ?? []).filter(notDone)];
}

/** 停滞：等待图中的环，或等到 blocked / cancelled 的链 */
export function stalls(tasks: readonly TaskFile[], pick: Pick = awaitedAcctest): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const start of tasks.filter(OPEN)) {
    const seen: string[] = [];
    let frontier = [start.id];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        const t = byId.get(id);
        if (!t) continue;
        if (t.status === 'cancelled' || (t.status === 'blocked' && id !== start.id)) { out.push(`${start.id} 等到 ${id}（${t.status}）`); continue; }
        for (const w of waitsOn(t, tasks, pick)) {
          if (w === start.id) out.push(`${start.id} 在等待环里（经 ${id}）`);
          else if (!seen.includes(w)) { seen.push(w); next.push(w); }
        }
      }
      frontier = next;
    }
  }
  return [...new Set(out)];
}

const s0 = (impl: Partial<TaskFile>) => [
  mkTask('T-001', { stage: 'S0', status: 'awaiting_inputs', ...impl }),
  mkTask('T-001.at', { stage: 'S0', kind: 'acctest', role: 'test-author', for_task: 'T-001', deps: [hard('T-001')], status: 'pending' }),
];

test('F2：偏离 72 的现场——旧等待规则（latestAcctest）成环，现行规则（awaitedAcctest）不成环', () => {
  const tasks = s0({});
  assert.deepEqual(stalls(tasks, latestAcctest), ['T-001 在等待环里（经 T-001.at）', 'T-001.at 在等待环里（经 T-001）']);
  assert.deepEqual(stalls(tasks, awaitedAcctest), []);
});

test('F2：等到已阻塞的软依赖生产方，也报停滞（规格第 8.1 节"卡住时必须能被看见"）', () => {
  const tasks = [mkTask('T-001', { status: 'blocked', blocked_by: 'agent' }), mkTask('T-002', { status: 'awaiting_inputs', deps: [soft('T-001')] })];
  assert.deepEqual(stalls(tasks), ['T-002 等到 T-001（blocked）']);
});

test('F2：正常的并行等待不报停滞', () => {
  const tasks = [
    mkTask('T-001', { status: 'in_progress' }),
    mkTask('T-001.at', { kind: 'acctest', role: 'test-author', for_task: 'T-001', status: 'in_progress' }),
    mkTask('T-002', { status: 'awaiting_inputs', deps: [soft('T-001')] }),
    mkTask('T-003', { status: 'pending', deps: [hard('T-002')] }),
  ];
  assert.deepEqual(stalls(tasks), []);
});
