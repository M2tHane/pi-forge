// 偏离 115：impl / fix 不受计划 writes 限制（验收测试、规格、未列测试路径时的测试代码除外）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkToolCall, type GuardContext } from '../../src/core/security/guard.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { openWriteAllowed, opensWrites } from '../../src/core/state/paths.ts';
import { scopeHint, withScopeHint } from '../../src/core/workspace/scope-hint.ts';
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

test('openWriteAllowed：范围外的源码可以改；验收测试、规格不能改；测试代码看 writes 是否列了测试路径', () => {
  for (const f of ['src/server/index.js', 'src/web/app.js', 'package.json', 'docs/contracts/paths/cards.yaml', 'tests/acceptance/T-007/a.test.js']) assert.ok(openWriteAllowed(f, writes), f);
  for (const f of ['tests/acceptance/T-004/a.test.js', 'tests/acceptance/suite/x.test.js', 'docs/spec/requirements.md', 'tests/unit/a.test.js', 'src/a.test.js']) assert.equal(openWriteAllowed(f, writes), false, f);
  // 只有自己的验收目录不算列了测试路径；列了单元测试目录后，别处的测试代码也能写
  assert.ok(openWriteAllowed('src/a.test.js', [...writes, 'tests/unit/**']));
  assert.equal(openWriteAllowed('tests/acceptance/T-004/a.test.js', [...writes, 'tests/unit/**']), false);
});

test('opensWrites：只有 impl 与 fix', () => {
  for (const kind of ['impl', 'fix']) assert.ok(opensWrites({ kind }));
  for (const kind of ['merge-fix', 'acctest', 'doc', 'review']) assert.equal(opensWrites({ kind }), false, kind);
});

test('guard：openWrites 时可以写、删除范围外的源码（m9b STD 的路由注册文件），验收测试、规格、受保护路径仍阻断', () => {
  assert.ok(write('src/server/index.js', ctx()).allow);
  assert.ok(checkToolCall({ toolName: 'bash', input: { command: 'rm src/server/index.js' } }, ctx()).allow);
  for (const p of ['tests/acceptance/T-004/a.test.js', 'docs/spec/requirements.md', 'tests/unit/a.test.js']) {
    const d = write(p, ctx());
    assert.equal(d.allow, false, p);
    if (!d.allow) assert.match(d.reason, /不能改/);
  }
  assert.equal(write('workflow.yaml', ctx()).allow, false);
  // 不带 openWrites（merge-fix、其他角色）照旧按 writes 限制
  assert.equal(write('src/server/index.js', ctx({ openWrites: false })).allow, false);
});

test('scope-hint：openWrites 的任务不再追加范围申请提示', () => {
  const out = 'Error at src/server/index.js:3';
  const t = { kind: 'impl' as const, writes, shared: [], test_adjustments: [] };
  assert.match(scopeHint(out, t, new Set(['src/server/index.js'])), /forge_request_scope/);
  assert.equal(withScopeHint('预检未通过', out, t, wt), '预检未通过');
});
