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
