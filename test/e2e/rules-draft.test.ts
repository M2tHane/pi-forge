// 改编自 pi-flow test/e2e/rules-draft.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
// 规则与命令草案：architect 写在 docs/rules-draft/（随文档合入集成分支），用户确认后程序写入 rules/ 与 workflow.yaml。
import { test } from 'node:test';
import { parseConfig } from '../../src/core/config.ts';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { listDrafts } from '../../src/core/rules-draft.ts';
import { setupProject } from '../helpers/project.ts';
import { makeEngine, commitToBranch } from '../helpers/engine.ts';
import { TEMPLATE_YAML } from '../helpers/config.ts';
import { commandEnv } from '../helpers/commands.ts';


const DRAFTS = {
  'docs/rules-draft/backend.md': '# 后端规则\n\n1. 数据库访问统一用 Prisma Client，不写原生 SQL。\n',
  'docs/rules-draft/prisma.md': '# Prisma 规则\n\n1. schema.prisma 只由 worker 修改。\n',
  'docs/rules-draft/commands.yaml': 'commands:\n  test: "npm test"\n  typecheck: "npx tsc --noEmit"\ngui_commands: ["npm run dev:desktop"]\n',
};

test('列出并应用草案：规则替换与新增、命令修改保留注释、提交、运行中的配置同步更新', async () => {
  const p = await setupProject({ yaml: '# 应用命令草案时保留此注释\n' + TEMPLATE_YAML });
  try {
    const { engine } = makeEngine(p, async () => {});
    commitToBranch(p.dir, `flow/${p.flowId}/integration`, DRAFTS, '架构师的草案');
    const drafts = listDrafts(p.dir, `flow/${p.flowId}/integration`);
    assert.deepEqual(drafts.map((d) => [d.file, d.target]), [
      ['docs/rules-draft/backend.md', 'rules/backend.md'], ['docs/rules-draft/commands.yaml', 'workflow.yaml'], ['docs/rules-draft/prisma.md', 'rules/prisma.md']]);
    assert.match(drafts[1]!.summary, /test："pnpm test" → "npm test"/);
    assert.match(drafts[1]!.summary, /agent 不能运行（会打开界面）："npm run dev:desktop"/);
    assert.match(drafts[2]!.summary, /新文件/);
    const e = commandEnv(p, engine);
    assert.match(await runFlowCommand('rules', e), /规则与命令草案[\s\S]*\/forge rules apply all/);

    const out = await runFlowCommand('rules apply all', e);
    assert.match(out, /已应用：workflow\.yaml、rules\/backend\.md、rules\/prisma\.md，并已提交[\s\S]*缓存会失效一次/);
    assert.match(readFileSync(path.join(p.dir, 'rules/backend.md'), 'utf8'), /Prisma Client/);
    assert.ok(existsSync(path.join(p.dir, 'rules/prisma.md')));
    const wf = readFileSync(path.join(p.dir, 'workflow.yaml'), 'utf8');
    assert.match(wf, /test: "?npm test"?/);
    assert.match(wf, /应用命令草案时保留此注释/, '保留注释');
    assert.match(wf, /lint: +"pnpm lint"/, '未改的命令不动');
    assert.deepEqual(parseConfig(wf).raw.gui_commands, ['npm run dev:desktop'], '会打开界面的命令写进 gui_commands');
    assert.equal(p.config.commands['test'], 'npm test', '运行中的引擎配置同步更新');
    assert.match(p.git('log', '-1', '--format=%s'), /pi-forge: 应用 B-001 的规则与命令草案/);
    assert.equal(await runFlowCommand('rules', e), '没有待应用的规则或命令草案。');
  } finally { p.cleanup(); }
});

test('不合法的草案被拒绝且不写入任何文件', async () => {
  const p = await setupProject({ yaml: TEMPLATE_YAML });
  try {
    const { engine } = makeEngine(p, async () => {});
    commitToBranch(p.dir, `flow/${p.flowId}/integration`, { 'docs/rules-draft/commands.yaml': 'commands:\n  test: 123\n', 'docs/rules-draft/x.md': 'x' }, '坏草案');
    await assert.rejects(runFlowCommand('rules', commandEnv(p, engine)), /test 的命令必须是非空字符串/);
    assert.ok(!existsSync(path.join(p.dir, 'rules/x.md')));
  } finally { p.cleanup(); }
});

test('acctest_workspace 草案：列出摘要；格式不对时拒绝且不写入', async () => {
  const p = await setupProject({ yaml: TEMPLATE_YAML });
  try {
    const { engine } = makeEngine(p, async () => {});
    const ref = `flow/${p.flowId}/integration`;
    commitToBranch(p.dir, ref, { 'docs/rules-draft/commands.yaml': 'commands:\n  test: "npm test"\nacctest_workspace:\n  include: [package.json]\n  cache: [node_modules]\n' }, '草案');
    assert.match(listDrafts(p.dir, ref)[0]!.summary, /验收测试工作区：include package\.json；cache node_modules/);
    const before = readFileSync(path.join(p.dir, 'workflow.yaml'), 'utf8');
    commitToBranch(p.dir, ref, { 'docs/rules-draft/commands.yaml': 'commands:\n  test: "npm test"\nacctest_workspace:\n  include: package.json\n' }, '坏草案');
    await assert.rejects(runFlowCommand('rules apply all', commandEnv(p, engine)), /acctest_workspace 应为/);
    assert.equal(readFileSync(path.join(p.dir, 'workflow.yaml'), 'utf8'), before);
  } finally { p.cleanup(); }
});
