// 来源：pi-flow test/unit/paths.test.ts @ 31f3f15
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globsOverlap, globWithin, matchesAny, matchesReadPaths, normalizeRelPath, isProtected } from '../../src/core/paths.ts';

test('globsOverlap：目录嵌套与通配', () => {
  assert.equal(globsOverlap('src/server/**', 'src/server/export/**'), true);
  assert.equal(globsOverlap('src/server/**', 'src/web/**'), false);
  assert.equal(globsOverlap('src/web/*.css', 'src/web/*.ts'), false);
  assert.equal(globsOverlap('src/web/*.ts', 'src/web/a.ts'), true);
  assert.equal(globsOverlap('src/**/x.ts', 'src/a/b/x.ts'), true);
  assert.equal(globsOverlap('src/**/x.ts', 'src/a/b/y.ts'), false);
  assert.equal(globsOverlap('package.json', 'package.json'), true);
  assert.equal(globsOverlap('tsconfig*.json', 'tsconfig.base.json'), true);
  assert.equal(globsOverlap('src/{db,server}/**', 'src/server/a.ts'), true);
  assert.equal(globsOverlap('src/{db,web}/**', 'src/server/a.ts'), false);
});

test('globWithin：任务 writes 不得越出 scope', () => {
  assert.equal(globWithin('src/server/export/**', 'src/server/**'), true);
  assert.equal(globWithin('src/server/a.ts', 'src/server/**'), true);
  assert.equal(globWithin('src/**', 'src/server/**'), false);
  assert.equal(globWithin('src/*/x.ts', 'src/server/**'), false);
  assert.equal(globWithin('src/web/**', 'src/server/**'), false);
});

test('normalizeRelPath：消除 .. 并拒绝越出根目录', () => {
  assert.equal(normalizeRelPath('/repo', 'src/../src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRelPath('/repo', '/repo/src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRelPath('/repo', './a/./b'), 'a/b');
  assert.equal(normalizeRelPath('/repo', '../etc/passwd'), null);
  assert.equal(normalizeRelPath('/repo', '/etc/passwd'), null);
});

test('有序 read_paths：排除 .forge，后面的模式覆盖前面的', () => {
  const patterns = ['**', '!.forge/**'];
  assert.equal(matchesReadPaths('src/a.ts', patterns), true);
  assert.equal(matchesReadPaths('.forge/state.json', patterns), false);
  assert.equal(matchesReadPaths('.forge', patterns), false, '排除目录本身，不能列出目录');
  assert.equal(matchesReadPaths('', patterns), true, '工作区根目录');
  assert.equal(matchesReadPaths('.config/a.ts', patterns), true, '隐藏路径也参与匹配');
});

test('有序 read_paths：多次排除与重新允许，最后一次匹配生效', () => {
  const patterns = ['**', '!a/**', 'a/b/**', '!a/b/private/**', 'a/b/private/public/**'];
  assert.equal(matchesReadPaths('other/x', patterns), true);
  assert.equal(matchesReadPaths('a/x', patterns), false);
  assert.equal(matchesReadPaths('a/b/x', patterns), true);
  assert.equal(matchesReadPaths('a/b/private/x', patterns), false);
  assert.equal(matchesReadPaths('a/b/private/public/x', patterns), true);
  assert.equal(matchesReadPaths('a/b/x', ['a/b/**', '!a/**']), false);
});

test('有序 read_paths：只有排除项、空列表、未匹配都不可读', () => {
  for (const rel of ['', 'a/x', '.forge/x', 'src/a.ts']) {
    assert.equal(matchesReadPaths(rel, ['!a/**', '!.forge/**']), false);
    assert.equal(matchesReadPaths(rel, []), false);
  }
  assert.equal(matchesReadPaths('src/a.ts', ['docs/**']), false);
  assert.equal(matchesReadPaths('docs/a.md', ['docs/**']), true);
  assert.equal(matchesReadPaths('docs/a.md', ['!']), false);
});

test('matchesAny 与受保护路径', () => {
  assert.equal(matchesAny('src/server/a.ts', ['src/server/**']), true);
  assert.equal(matchesAny('.forge/state.json', ['src/**']), false);
  assert.equal(isProtected('.forge/state.json'), true);
  assert.equal(isProtected('.git/HEAD'), true);
  assert.equal(isProtected('workflow.yaml'), true);
  assert.equal(isProtected('rules/backend.md'), true);
  assert.equal(isProtected('.pi/settings.json'), true);
  assert.equal(isProtected('docs/interfaces/a.md'), false);
  assert.equal(isProtected('src/a.ts'), false);
});
