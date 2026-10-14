import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, gitOk } from '../../src/core/state/git.ts';
import { resolveConflictsStructured } from '../../src/core/engine/merge-queue.ts';

const ID = { engineIdentity: true } as const;

/** 临时仓库：main 与 task 分支各自改同一个文件，task 分支 rebase 到 main 后停在冲突上。返回 worktree 路径与冲突文件 */
function setup(file: string, base: string, ours: string, theirs: string): { dir: string; conflicts: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-structured-'));
  const write = (text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); };
  git(dir, ['init', '-q', '-b', 'main']);
  write(base);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base'], ID);
  git(dir, ['checkout', '-q', '-b', 'task']);
  write(theirs);
  git(dir, ['commit', '-q', '-am', 'task'], ID);
  git(dir, ['checkout', '-q', 'main']);
  write(ours);
  git(dir, ['commit', '-q', '-am', 'main'], ID);
  git(dir, ['checkout', '-q', 'task']);
  try { git(dir, ['rebase', '-q', 'main'], ID); } catch { /* 冲突时 rebase 返回非零，停在冲突上 */ }
  return { dir, conflicts: git(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean) };
}

const BASE = 'export const E1 = 1;\n';

test('rebase 冲突：两个分支都往 src/shared/errors.ts 末尾追加 → 结构化合并，含两行', () => {
  const { dir, conflicts } = setup('src/shared/errors.ts', BASE, BASE + 'export const E2 = 2;\n', BASE + 'export const E3 = 3;\n');
  try {
    assert.deepEqual(conflicts, ['src/shared/errors.ts']);
    assert.equal(resolveConflictsStructured(dir, conflicts, { integration: 2, task: 3 }, () => true), true);
    git(dir, ['-c', 'core.editor=true', 'rebase', '--continue'], { ...ID, env: { GIT_EDITOR: 'true' } });
    assert.equal(readFileSync(path.join(dir, 'src/shared/errors.ts'), 'utf8'), BASE + 'export const E2 = 2;\nexport const E3 = 3;\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('allowed 为 false 的普通文件：不合并、不写文件', () => {
  const r = setup('src/shared/errors.ts', BASE, BASE + 'export const E2 = 2;\n', BASE + 'export const E3 = 3;\n');
  try {
    const before = readFileSync(path.join(r.dir, 'src/shared/errors.ts'), 'utf8');
    assert.equal(resolveConflictsStructured(r.dir, r.conflicts, { integration: 2, task: 3 }), false);
    assert.equal(resolveConflictsStructured(r.dir, r.conflicts, { integration: 2, task: 3 }, () => false), false);
    assert.equal(readFileSync(path.join(r.dir, 'src/shared/errors.ts'), 'utf8'), before);
    assert.match(before, /<<<<<<</);
    gitOk(r.dir, ['rebase', '--abort']);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('一方修改了已有行：不合并', () => {
  const r = setup('src/shared/errors.ts', BASE, 'export const E1 = 10;\n', BASE + 'export const E3 = 3;\n');
  try {
    assert.equal(resolveConflictsStructured(r.dir, r.conflicts, { integration: 2, task: 3 }, () => true), false);
    gitOk(r.dir, ['rebase', '--abort']);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
