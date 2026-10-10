// M4：impl 已 done 的验收测试单独合并（第 9.5 节）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { hard, mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';

const YAML = PROJECT_YAML.replace('acceptance: "true"', 'acceptance: "sh tests/acc.sh"');
// 验收测试里有 NEEDS_V2 时，要求实现里有 v2
const FILES = { 'tests/acc.sh': 'for f in $(find tests/acceptance -name "*.test.ts"); do if grep -q NEEDS_V2 "$f" && ! grep -q v2 src/server/t-001/a.ts; then echo "FAIL $f"; exit 1; fi; done\n' };
const AT = mkTask('T-001.at', { kind: 'acctest', role: 'test-author', scopes: ['acctest'], for_task: 'T-001', verify: [], ac: ['REQ-001.AC1'],
  depends_on: [hard('T-001')], writes: ['tests/acceptance/T-001/**', 'tests/acceptance/_support/T-001/**'] });

async function submit(a: FakeAgent, files: Record<string, string>, note: string) {
  for (const [p, c] of Object.entries(files)) assert.ok((await a.call('write', { path: p, content: c })).ok);
  await a.call('forge_note', { text: note });
  const r = await a.call('forge_submit', { summary: note });
  assert.ok(r.ok, r.text);
}

for (const pass of [true, false]) {
  test(pass ? '单独合并：测试在已有实现上通过 → 进合并队列（全量验证）并合入' : '单独合并：测试在已有实现上失败 → .at 以 report 结束，原 impl 得到 .fx-n（分支含这批测试），修好后测试随 .fx-n 合入', async () => {
    const p = await setupProject({ yaml: YAML, files: FILES, tasks: [mkTask('T-001', { ac: ['REQ-001.AC1'] }), AT] });
    const e = makeEngine(p, async (role, _nth, a) => {
      await a.call('forge_claim');
      const id = a.env.task;
      if (id === 'T-001') return submit(a, { 'src/server/t-001/a.ts': 'v1\n' }, '骨架');
      if (id === 'T-001.at') return submit(a, { 'tests/acceptance/T-001/a.test.ts': `test('[REQ-001.AC1] ${pass ? 'ok' : 'NEEDS_V2'}', () => {});\n` }, 'AC1');
      assert.equal(id, 'T-001.fx-1');
      assert.equal(role, 'worker');
      return submit(a, { 'src/server/t-001/a.ts': 'v2\n' }, '修好');
    });
    try {
      for (let i = 0; i < 10; i++) { await e.engine.next(p.flowId); await e.engine.idle(); }
      assert.deepEqual(e.errors, []);
      const integ = p.store.readFlow(p.flowId).integration_branch;
      assert.match(p.git('show', `${integ}:tests/acceptance/T-001/a.test.ts`), /REQ-001\.AC1/, '测试已合入集成分支');
      const at = p.store.readTask(p.flowId, 'T-001.at');
      assert.equal(at.status, 'done');
      if (pass) {
        assert.ok(p.store.readEvents().some((ev) => ev.task === 'T-001.at' && ev.trigger === 'merge_done'));
        assert.ok(!p.store.listTasks(p.flowId).some((t) => t.id.includes('.fx-')));
      } else {
        assert.ok(p.store.readEvents().some((ev) => ev.task === 'T-001.at' && ev.trigger === 'precheck_fail_handoff'));
        const fx = p.store.readTask(p.flowId, 'T-001.fx-1');
        assert.deepEqual([fx.kind, fx.status, fx.for_task], ['fix', 'done', 'T-001']);
        assert.equal(p.git('show', `${integ}:src/server/t-001/a.ts`), 'v2');
      }
    } finally { p.cleanup(); }
  });
}
