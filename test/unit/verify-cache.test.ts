// 同一棵代码树只验证一次（偏离 76）：沿用条件是代码树相同、命令名相同、命令内容的哈希相同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { VERIFIED, cleanTreeOf, commandHash, reusableRuns, reuseText, treeOfCommit } from '../../src/core/verify-cache.ts';
import { tmpRepo } from '../helpers/repo.ts';

const ev = (flow: string, tree: string, runs: { name: string; shell: string; evidence: string }[]) =>
  ({ type: 'note', flow, data: { kind: VERIFIED, tree, runs: runs.map((r) => ({ name: r.name, hash: commandHash(r.shell), evidence: r.evidence })) } });
const plan = [{ name: 'typecheck', shell: 'pnpm typecheck' }, { name: 'test', shell: 'pnpm test' }, { name: 'acceptance', shell: 'pnpm test:acceptance' }];

test('reusableRuns：同一棵树、同名、命令内容相同才沿用；取最近一次的 evidence', () => {
  const events = [
    ev('B-001', 't1', [{ name: 'typecheck', shell: 'pnpm typecheck', evidence: 'old/typecheck.log' }]),
    ev('B-001', 't1', [{ name: 'typecheck', shell: 'pnpm typecheck', evidence: 'new/typecheck.log' }, { name: 'test', shell: 'pnpm test', evidence: 'new/test.log' }]),
    // 预检的 acceptance 带 "-- <task>"，内容不同，不能给合并时的全量 acceptance 沿用
    ev('B-001', 't1', [{ name: 'acceptance', shell: 'pnpm test:acceptance -- T-001', evidence: 'pc/acceptance.log' }]),
  ];
  assert.deepEqual([...reusableRuns(events, 'B-001', 't1', plan)].sort(), [['test', 'new/test.log'], ['typecheck', 'new/typecheck.log']]);
});

test('reusableRuns：代码树不同、命令内容变了、别的流程、工作区不干净（tree 为 null）都不沿用', () => {
  const events = [ev('B-001', 't1', [{ name: 'typecheck', shell: 'pnpm typecheck', evidence: 'a' }, { name: 'test', shell: 'pnpm test', evidence: 'b' }])];
  assert.equal(reusableRuns(events, 'B-001', 't2', plan).size, 0);
  assert.equal(reusableRuns(events, 'B-002', 't1', plan).size, 0);
  assert.equal(reusableRuns(events, 'B-001', null, plan).size, 0);
  // P1 或变更请求批准后 commands 变了：同名命令不再沿用
  assert.deepEqual([...reusableRuns(events, 'B-001', 't1', [{ name: 'test', shell: 'pnpm vitest run' }, { name: 'typecheck', shell: 'pnpm typecheck' }]).keys()], ['typecheck']);
  // 首尾空白不算内容变化
  assert.equal(commandHash('pnpm test '), commandHash('pnpm test'));
});

test('沿用记录写明代码树与每个命令沿用的 evidence', () => {
  const text = reuseText('abc123', new Map([['test', '.forge/flows/B-001/evidence/T-001/precheck-a0-test.log']]));
  assert.match(text, /代码树：abc123/);
  assert.match(text, /- test：沿用 \.forge\/flows\/B-001\/evidence\/T-001\/precheck-a0-test\.log/);
});

test('cleanTreeOf：干净时等于 HEAD 的代码树；有改动或未被忽略的新文件时为 null；treeOfCommit 读提交的代码树', () => {
  const r = tmpRepo();
  try {
    writeFileSync(path.join(r.dir, 'a.txt'), '1');
    writeFileSync(path.join(r.dir, '.gitignore'), 'node_modules/\n');
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'init');
    const head = r.git('rev-parse', 'HEAD');
    assert.equal(cleanTreeOf(r.dir), r.git('rev-parse', 'HEAD^{tree}'));
    assert.equal(treeOfCommit(r.dir, head), cleanTreeOf(r.dir));
    r.git('init', '-q', 'node_modules'); // 被忽略的目录不影响
    assert.equal(cleanTreeOf(r.dir), r.git('rev-parse', 'HEAD^{tree}'));
    writeFileSync(path.join(r.dir, 'new.txt'), 'x');
    assert.equal(cleanTreeOf(r.dir), null);
    r.git('add', 'new.txt');
    r.git('commit', '-q', '-m', 'new');
    writeFileSync(path.join(r.dir, 'a.txt'), '2');
    assert.equal(cleanTreeOf(r.dir), null);
    assert.equal(treeOfCommit(r.dir, 'deadbeef'), null);
  } finally { r.cleanup(); }
});
