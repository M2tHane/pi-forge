// 规则草案：写在 docs/rules-draft/（随文档合入集成分支），用户确认后程序写入 rules/。项目命令不走草案（commands.yaml 随代码合并）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { listDrafts } from '../../src/core/plan/rules-draft.ts';
import { setupProject } from '../helpers/project.ts';
import { makeEngine, commitToBranch } from '../helpers/engine.ts';
import { TEMPLATE_YAML } from '../helpers/config.ts';
import { commandEnv } from '../helpers/commands.ts';

const DRAFTS = {
  'docs/rules-draft/backend.md': '# 后端规则\n\n1. 数据库访问统一用 Prisma Client，不写原生 SQL。\n',
  'docs/rules-draft/prisma.md': '# Prisma 规则\n\n1. schema.prisma 只由 worker 修改。\n',
  // 草案目录里的其他文件不当作草案
  'docs/rules-draft/commands.yaml': 'commands:\n  test: "npm test"\n',
};

test('列出并应用规则草案：替换与新增、提交；草案目录里的非规则文件忽略', async () => {
  const p = await setupProject({ yaml: TEMPLATE_YAML });
  try {
    const { engine } = makeEngine(p, async () => {});
    commitToBranch(p.dir, `flow/${p.flowId}/integration`, DRAFTS, '架构师的草案');
    const drafts = listDrafts(p.dir, `flow/${p.flowId}/integration`);
    assert.deepEqual(drafts.map((d) => [d.file, d.target]), [
      ['docs/rules-draft/backend.md', 'rules/backend.md'], ['docs/rules-draft/prisma.md', 'rules/prisma.md']]);
    assert.match(drafts[1]!.summary, /新文件/);
    const e = commandEnv(p, engine);
    assert.match(await runFlowCommand('rules', e), /待应用的规则草案[\s\S]*\/forge rules apply all/);

    const before = readFileSync(path.join(p.dir, 'workflow.yaml'), 'utf8');
    const out = await runFlowCommand('rules apply all', e);
    assert.match(out, /已应用：rules\/backend\.md、rules\/prisma\.md，并已提交[\s\S]*缓存会失效一次/);
    assert.match(readFileSync(path.join(p.dir, 'rules/backend.md'), 'utf8'), /Prisma Client/);
    assert.ok(existsSync(path.join(p.dir, 'rules/prisma.md')));
    assert.equal(readFileSync(path.join(p.dir, 'workflow.yaml'), 'utf8'), before, 'workflow.yaml 不变');
    assert.match(p.git('log', '-1', '--format=%s'), /pi-forge: 应用 B-001 的规则草案/);
    assert.equal(await runFlowCommand('rules', e), '没有待应用的规则草案。');
  } finally { p.cleanup(); }
});
