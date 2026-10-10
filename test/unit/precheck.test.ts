// 第 8.2 节：预检要跑的命令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheckCommands } from '../../src/core/precheck.ts';

test('precheckCommands：只跑已定义且非空的 typecheck、lint、test；有验收测试目录时加 acceptance -- <task>', () => {
  const cmds = { typecheck: 'pnpm tsc', lint: '', test: 'pnpm vitest run {files}', acceptance: 'pnpm acc', e2e: 'pnpm e2e' };
  assert.deepEqual(precheckCommands(cmds, 'T-003', true), [
    { name: 'typecheck', shell: 'pnpm tsc' }, { name: 'test', shell: 'pnpm vitest run' }, { name: 'acceptance', shell: 'pnpm acc -- T-003' },
  ]);
  assert.deepEqual(precheckCommands(cmds, 'T-003', false).map((c) => c.name), ['typecheck', 'test']);
  assert.deepEqual(precheckCommands({ acceptance: 'x' }, 'T-001', true), [{ name: 'acceptance', shell: 'x -- T-001' }]);
});

test('contractBaseOf：同步过集成分支后，基线是合并基点（含已批准变更对契约的修改）；没有集成分支时用 base_sha', async () => {
  const { tmpRepo } = await import('../helpers/repo.ts');
  const { contractBaseOf } = await import('../../src/core/precheck.ts');
  const { writeFileSync } = await import('node:fs');
  const path = (await import('node:path')).default;
  const r = tmpRepo();
  try {
    writeFileSync(path.join(r.dir, 'a.txt'), '1');
    r.git('add', '.'); r.git('commit', '-q', '-m', 'base');
    const base = r.git('rev-parse', 'HEAD');
    r.git('branch', 'integ');
    r.git('checkout', '-q', '-b', 'task');
    writeFileSync(path.join(r.dir, 'b.txt'), 'task'); r.git('add', '.'); r.git('commit', '-q', '-m', 'task');
    const t = { base_sha: base, worktree: r.dir };
    assert.equal(contractBaseOf(t, 'integ'), base, '未同步：基点就是 base_sha');
    r.git('checkout', '-q', 'integ');
    writeFileSync(path.join(r.dir, 'c.txt'), 'arch'); r.git('add', '.'); r.git('commit', '-q', '-m', 'change');
    const changed = r.git('rev-parse', 'HEAD');
    r.git('checkout', '-q', 'task'); r.git('merge', '-q', '--no-edit', 'integ');
    assert.equal(contractBaseOf(t, 'integ'), changed, '同步后：基点是集成分支上的变更');
    assert.equal(contractBaseOf(t), base);
  } finally { r.cleanup(); }
});
