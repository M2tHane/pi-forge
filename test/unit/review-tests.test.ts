// 审查者要运行的、本 task 范围内的测试命令（纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewTestCommands } from '../../src/core/stage/review-tests.ts';

test('reviewTestCommands：没有改动单元测试就跳过 test；不跑 typecheck、lint；acceptance 只跑 -- <task>', () => {
  const cmds = { typecheck: 'pnpm tsc', lint: 'pnpm lint', test: 'pnpm vitest run', acceptance: 'pnpm acc' };
  const r = reviewTestCommands(cmds, 'T-003', true);
  assert.deepEqual(r.run, [{ name: 'acceptance', shell: 'pnpm acc -- T-003' }]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!, /没有改动单元测试/);
  assert.deepEqual(reviewTestCommands(cmds, 'T-003', false).run, []);
  assert.deepEqual(reviewTestCommands({ acceptance: 'x' }, 'T-001', true).run, [{ name: 'acceptance', shell: 'x -- T-001' }]);
});

test('reviewTestCommands：{files} 占位替换成本任务改动的单元测试文件；没有占位时追加在末尾；文件名带引号时转义', () => {
  assert.deepEqual(reviewTestCommands({ test: 'pnpm vitest run {files}' }, 'T-1', false, { testFiles: ['src/a.test.ts', "it's.test.ts"] }).run,
    [{ name: 'test', shell: "pnpm vitest run 'src/a.test.ts' 'it'\\''s.test.ts'" }]);
  assert.deepEqual(reviewTestCommands({ test: 'pnpm test' }, 'T-1', false, { testFiles: ['src/a.test.ts'] }).run,
    [{ name: 'test', shell: "pnpm test 'src/a.test.ts'" }]);
});

test('reviewTestCommands：lean 共享目录只跑本任务的场景文件；没有改动则跳过', () => {
  const cmds = { acceptance: 'pnpm acc' };
  assert.deepEqual(reviewTestCommands(cmds, 'suite', true, { testFiles: [], accFiles: ['suite/a.test.js', 'suite/b.test.js'] }).run,
    [{ name: 'acceptance', shell: 'pnpm acc -- suite/a.test.js suite/b.test.js' }]);
  const none = reviewTestCommands(cmds, 'suite', true, { testFiles: [], accFiles: [] });
  assert.deepEqual(none.run, []);
  assert.match(none.skipped[0]!, /验收测试.*阶段门禁/);
});

test('acceptanceAudit：程序扫描本 task 每条 AC 有没有带编号的验收测试；不是 worker 写测试时返回 null', async () => {
  const { tmpRepo } = await import('../helpers/repo.ts');
  const { acceptanceAudit } = await import('../../src/core/stage/review-tests.ts');
  const { mkTask } = await import('../helpers/tasks.ts');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = (await import('node:path')).default;
  const r = tmpRepo();
  try {
    mkdirSync(path.join(r.dir, 'tests/acceptance/T-001'), { recursive: true });
    writeFileSync(path.join(r.dir, 'tests/acceptance/T-001/a.test.js'), "test('[REQ-001.AC1][REQ-001.AC2] 创建后可见', () => {});\n");
    r.git('add', '.'); r.git('commit', '-q', '-m', 'tests');
    const t = mkTask('T-001', { worktree: r.dir, ac: ['REQ-001.AC1', 'REQ-001.AC2', 'REQ-001.AC3', 'manual:看起来不错'], writes: ['src/**', 'tests/acceptance/T-001/**'] });
    const a = acceptanceAudit(t)!;
    assert.deepEqual(a.missing, ['REQ-001.AC3']);
    assert.deepEqual(a.rows.map((x) => x.ac), ['REQ-001.AC1', 'REQ-001.AC2', 'REQ-001.AC3'], 'manual 条目不算');
    assert.equal(a.rows[0]!.files[0], 'tests/acceptance/T-001/a.test.js');
    assert.equal(acceptanceAudit(mkTask('T-002', { worktree: r.dir, ac: ['REQ-001.AC1'], writes: ['src/**'] })), null, '自己的验收目录不在 writes 里：测试不是 worker 写的');
  } finally { r.cleanup(); }
});
