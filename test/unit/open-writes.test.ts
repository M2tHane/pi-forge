// impl / fix 不受计划 writes 限制（只有 docs/spec/ 与受保护路径除外）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkToolCall, type GuardContext } from '../../src/core/security/guard.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { openWriteAllowed, opensWrites } from '../../src/core/state/paths.ts';
import { TEST_YAML } from '../helpers/config.ts';

const config = parseConfig(TEST_YAML);
let base: string, main: string, wt: string;
before(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-forge-open-')));
  main = path.join(base, 'proj');
  wt = path.join(base, 'proj.worktrees', 'B-001-T-007');
  for (const root of [main, wt]) mkdirSync(path.join(root, 'src/server'), { recursive: true });
  writeFileSync(path.join(wt, 'src/server/index.js'), '');
});
after(() => rmSync(base, { recursive: true, force: true }));

const writes = ['src/server/cards/**', 'tests/acceptance/T-007/**'];
const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({ config, role: 'worker', cwd: wt, workspaceRoot: wt, mainRoot: main, writes, openWrites: true, ...over });
const write = (p: string, c: GuardContext) => checkToolCall({ toolName: 'write', input: { path: p, content: 'x' } }, c);

test('openWriteAllowed：除 docs/spec/ 外都可以改，包括任何 task 的验收测试、单元测试、package.json、契约', () => {
  for (const f of ['src/server/index.js', 'src/web/app.js', 'package.json', 'docs/contracts/paths/cards.yaml', 'tests/acceptance/T-007/a.test.js',
    'tests/acceptance/T-004/a.test.js', 'tests/acceptance/suite/x.test.js', 'tests/unit/a.test.js', 'src/a.test.js']) assert.ok(openWriteAllowed(f), f);
  for (const f of ['docs/spec/requirements.md', 'docs/spec/inputs/a.md']) assert.equal(openWriteAllowed(f), false, f);
});

test('opensWrites：只有 impl 与 fix', () => {
  for (const kind of ['impl', 'fix']) assert.ok(opensWrites({ kind }));
  for (const kind of ['merge-fix', 'acctest', 'doc', 'review']) assert.equal(opensWrites({ kind }), false, kind);
});

test('guard：openWrites 时可以写、删除 writes 外的源码、单元测试、别的 task 的验收测试；规格、受保护路径仍阻断', () => {
  assert.ok(write('src/server/index.js', ctx()).allow);
  assert.ok(checkToolCall({ toolName: 'bash', input: { command: 'rm src/server/index.js' } }, ctx()).allow);
  for (const p of ['tests/unit/cards.test.js', 'tests/acceptance/T-004/a.test.js', 'package.json']) assert.ok(write(p, ctx()).allow, p);
  const spec = write('docs/spec/requirements.md', ctx());
  assert.equal(spec.allow, false);
  if (!spec.allow) assert.match(spec.reason, /不能改/);
  for (const p of ['workflow.yaml', 'rules/global.md', '.forge/state.json', '.pi/x']) assert.equal(write(p, ctx()).allow, false, p);
  // 不带 openWrites（merge-fix、其他角色）照旧按 writes 限制
  assert.equal(write('src/server/index.js', ctx({ openWrites: false })).allow, false);
});
