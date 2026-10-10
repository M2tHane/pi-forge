// 第 8.2 节：预检要跑的命令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheckCommands } from '../../src/core/precheck.ts';
import { readFileSync } from 'node:fs';

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

test('runPrecheck：worker 改了已有契约时，预检在跑命令之前就失败（contracts），并点出文件', async () => {
  const { setupProject, PROJECT_YAML } = await import('../helpers/project.ts');
  const { mkTask } = await import('../helpers/tasks.ts');
  const { runPrecheck } = await import('../../src/core/precheck.ts');
  const { mkdirSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const rel = 'docs/contracts/paths/team.yaml';
  const v1 = "/api/teams:\n  get:\n    operationId: listTeams\n    responses:\n      '200': { description: 团队列表 }\n";
  const p = await setupProject({ yaml: PROJECT_YAML, files: { [rel]: v1 }, tasks: [mkTask('T-001', { module: 'team' })] });
  const wt = path.join(mkdtempSync(path.join(tmpdir(), 'pi-forge-wt-')), 'task');
  try {
    const base = p.git('rev-parse', 'HEAD');
    p.git('worktree', 'add', '-q', '-b', 'task', wt, base);
    const t = mkTask('T-001', { module: 'team', base_sha: base, worktree: wt });
    mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    writeFileSync(path.join(wt, rel), v1.replace('listTeams', 'listAllTeams'));
    p.git('-C', wt, 'commit', '-q', '-am', 'worker 改契约');
    const r = await runPrecheck(p.dir, p.store, p.config, p.flowId, t);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.command, 'contracts');
      assert.match(r.reason, /docs\/contracts\/paths\/team\.yaml/);
    }
  } finally {
    try { p.git('worktree', 'remove', '--force', wt); } catch { /* 已清理 */ }
    rmSync(path.dirname(wt), { recursive: true, force: true });
    p.cleanup();
  }
});

test('contractAppendCheck：同步集成分支后，已批准变更对契约的修改不算 worker 的违规；worker 自己的修改算', async () => {
  const { tmpRepo } = await import('../helpers/repo.ts');
  const { mkTask } = await import('../helpers/tasks.ts');
  const { contractAppendCheck } = await import('../../src/core/precheck.ts');
  const { mkdirSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const r = tmpRepo();
  const wt = path.join(mkdtempSync(path.join(tmpdir(), 'pi-forge-wt-')), 'task');
  try {
    const rel = 'docs/contracts/paths/team.yaml';
    const put = (dir: string, text: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
    const v1 = "/api/teams:\n  get:\n    operationId: listTeams\n    responses:\n      '200': { description: 团队列表 }\n";
    put(r.dir, v1);
    r.git('add', '.'); r.git('commit', '-q', '-m', 'base');
    const base = r.git('rev-parse', 'HEAD');
    r.git('branch', 'integ');
    r.git('worktree', 'add', '-q', '-b', 'task', wt, base);
    const t = mkTask('T-001', { module: 'team', base_sha: base, worktree: wt });
    assert.equal(contractAppendCheck(r.dir, t, 'integ'), null, '没有改动');

    // 已批准的变更请求在集成分支上改了已有契约（architect 的修改），任务同步后进入 worktree
    r.git('checkout', '-q', 'integ');
    put(r.dir, v1.replace('团队列表', '团队列表（含归档）'));
    r.git('commit', '-q', '-am', '变更请求：改描述');
    r.git('-C', wt, 'merge', '-q', '--no-edit', 'integ');
    assert.equal(contractAppendCheck(r.dir, t, 'integ'), null, '以合并基点为基线：已批准的修改不算违规');
    assert.match(contractAppendCheck(r.dir, t) ?? '', /契约只能追加/, '对照：以 base_sha 为基线会把它误判为违规');

    // worker 自己的修改仍然算，且点出文件与位置
    put(wt, readFileSync(path.join(wt, rel), 'utf8').replace('operationId: listTeams', 'operationId: listAllTeams'));
    r.git('-C', wt, 'commit', '-q', '-am', 'worker 改契约');
    const bad = contractAppendCheck(r.dir, t, 'integ');
    assert.match(bad ?? '', /预检未通过：契约只能追加（共 1 处违规）/);
    assert.match(bad ?? '', /docs\/contracts\/paths\/team\.yaml/);
    assert.match(bad ?? '', /operationId/);
  } finally {
    try { r.git('worktree', 'remove', '--force', wt); } catch { /* 已清理 */ }
    rmSync(path.dirname(wt), { recursive: true, force: true });
    r.cleanup();
  }
});
