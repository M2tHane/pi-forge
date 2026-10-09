// 来源：pi-flow test/e2e/flow6.test.ts @ 31f3f15
// 第六轮新流程（fake-subagent 驱动）：用户带着 PRD 与原型进来 → 主 agent 就绪检查、提交需求说明（检查通过直接进入规划）
// → 主 agent 写规划文档、提交模块清单（检查不通过、被打回后修改）→ 用户批准 → 按模块实施、合并、独立验收 → 合入主分支。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { runFlowBuild, runFlowCommand } from '../../src/commands/forge.ts';
import { FLOW5_YAML, SETTINGS5, cmdEnv } from '../helpers/flow5.ts';
import { renderStatus } from '../../src/core/status-view.ts';
import { flowPlanDoc, flowProposeModules, flowRequirements, statusText } from '../../src/tools/orchestrator-tools.ts';
import { nextStep, turnContext } from '../../src/core/context-injector.ts';
import { mainSkillNames } from '../../src/core/planning.ts';
import { parseConfig } from '../../src/core/config.ts';

const MODULES = [
  { id: 'M-1', title: '底座：项目骨架与公共组件', writes: ['src/base/**'], shared: ['src/routes.ts'], acceptance: ['AC-01：服务能启动', 'AC-03：首页能打开'] },
  { id: 'M-2', title: '待办：增删改查', writes: ['src/todo/**'], shared: ['src/routes.ts'], acceptance: ['AC-02：可以新增待办'], ui_pages: ['prototype/index.html'], depends_on: [{ module: 'M-1', reason: '需要底座' }] },
  { id: 'M-3', title: '标签：给待办打标签', writes: ['src/tag/**'], shared: ['src/routes.ts'], acceptance: ['AC-04：可以新增标签'], depends_on: [{ module: 'M-1', reason: '需要底座' }], size: 'S' as const, manual_checks: ['标签颜色看起来清楚'] },
];

type Engine = ReturnType<typeof makeEngine>['engine'];

/** onMain：主会话进行的阶段（D0 未提交需求、D2 未提交规划）时调用，模拟主 agent */
async function drive(p: Project, engine: Engine, flowId: string, onHuman: (stage: string) => Promise<void>, onMain: (stage: string) => Promise<void>) {
  for (let i = 0; i < 80; i++) {
    if (!p.store.readState().active_flow) return;
    const f = p.store.readFlow(flowId);
    if (f.stage_status === 'awaiting_human') { await onHuman(f.stage); continue; }
    if (f.stage_status === 'active' && ((f.stage === 'D0' && !f.requirements?.submitted) || (f.stage === 'D2' && !f.planning?.submitted))) { await onMain(f.stage); continue; }
    const sig = () => `${p.store.readFlow(flowId).version}|${p.store.listTasks(flowId).map((t) => `${t.id}:${t.status}:${t.accepted ?? ''}`).join(',')}`;
    const before = sig();
    await engine.pump(flowId);
    await engine.next(flowId);
    await engine.idle();
    if (sig() === before) throw new Error(`流程停在 ${f.stage}/${f.stage_status}：\n${statusText(p.store, null, flowId)}`);
  }
  throw new Error('流程未在预期步数内结束');
}

/** 用户在别处准备好的输入：PRD、技术架构、Claude Design 式的导出目录（含 DESIGN.md 与二进制资源） */
function inputs(dir: string): string {
  const root = `${dir}.in`;
  mkdirSync(path.join(root, 'design/assets'), { recursive: true });
  writeFileSync(path.join(root, 'prd.md'), '# 待办应用\n## 功能\n- 新增待办\n- 标签\n');
  writeFileSync(path.join(root, 'arch.md'), '# 架构\nNode + SQLite\n');
  writeFileSync(path.join(root, 'design/index.html'), '<html><head><title>待办列表</title></head><body>原型</body></html>');
  writeFileSync(path.join(root, 'design/assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  writeFileSync(path.join(root, 'design/DESIGN.md'), '# 设计规范\n主色 #1d4ed8\n');
  return root;
}

const REQUIREMENTS = (withIds: boolean) => `# 需求说明\n## 需求\n- R1 新增待办（PRD §功能）\n  ${withIds ? 'AC-01：服务能启动；AC-02：可以新增待办；AC-03：首页能打开' : '能新增待办'}\n- R2 标签（PRD §功能）\n  ${withIds ? 'AC-04：可以新增标签' : '能打标签'}\n`;

test('第六轮全流程：带 PRD 与原型进来 → 就绪检查后提交需求说明（没有 AC 编号被退回）→ 主 agent 规划（缺项目规则被退回、用户打回一次）→ 底座先行、两个模块并行 → 验收不通过交回修复再复查 → 合入主分支', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML });
  const input = inputs(p.dir);
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    let acceptRound = 0;
    const roles: string[] = [];
    const script = async (role: string, _nth: number, a: FakeAgent) => {
      const t = p.store.readTask(a.env.flow, a.env.task);
      roles.push(role);
      if (role === 'acceptor') {
        const ids = t.accept_kind === 'check' ? t.acceptance.filter((x) => /^A-\d+ /.test(x)).map((x) => x.split(' ')[0]!) : null;
        if (t.accept_kind === 'check') {
          // 底座第一次验收：A-2（首页）不通过；其他模块全部通过
          const fail = t.title.includes('底座') && acceptRound++ === 0;
          const r = await a.call('forge_accept', { summary: '验收完成', results: ids!.map((id) => ({ id, passed: !(fail && id === 'A-2'), evidence: fail && id === 'A-2' ? 'GET / 返回 404' : 'curl 通过' })) });
          assert.ok(r.ok, r.text);
        } else {
          const r = await a.call('forge_accept_confirm', { summary: '已修好', results: [{ id: 'A-2', passed: true, evidence: 'GET / 返回 200' }] });
          assert.ok(r.ok, r.text);
        }
        return;
      }
      assert.ok((await a.call('forge_claim')).ok);
      if (t.kind === 'merge-fix') {
        // 公共文件的冲突：保留双方的追加
        for (const f of t.conflict_files ?? []) {
          const text = readFileSync(path.join(a.spec.cwd, f), 'utf8').split('\n').filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join('\n');
          await a.call('write', { path: f, content: text });
        }
      } else {
        const dir = t.writes[0]!.replace('/**', '');
        await a.call('write', { path: `${dir}/index.ts`, content: `// ${t.title}\n` });
        const routes = path.join(a.spec.cwd, 'src/routes.ts');
        await a.call('write', { path: 'src/routes.ts', content: `${existsSync(routes) ? readFileSync(routes, 'utf8') : ''}// ${t.id}\n` });
        await a.call('bash', { command: `git add -A && git -c user.name=t -c user.email=t@x commit -q -m "${t.id} 第一步"` });
        await a.call('notes', { action: 'update', ops: [{ section: 'done', op: 'add', text: '第一步' }] });
        if (t.kind === 'review-fix') await a.call('write', { path: `${dir}/home.ts`, content: '// 首页\n' });
      }
      await a.call('forge_note', { text: '完成' });
      const s = await a.call('forge_submit', { summary: t.title });
      assert.ok(s.ok, s.text);
    };
    const { engine, errors } = makeEngine(p, script, SETTINGS5);
    const talks: string[] = [];
    const env = { ...cmdEnv(p, engine), startConversation: (text: string) => { talks.push(text); } };
    const out = await runFlowBuild(`--prd ${input}/prd.md --arch ${input}/arch.md --design ${input}/design`, env);
    assert.match(out, /已接收 PRD（docs\/prd\/prd\.md）、技术架构（docs\/architecture\/arch\.md）、原型 1 页、设计规范 DESIGN\.md/);
    assert.match(talks.at(-1)!, /带来了 PRD、技术架构与原型/);
    // PRD 只在集成分支上：原文放进开始的消息，主 agent 不必去主工作区找（第六轮真实模型实验发现的问题）
    assert.match(talks.at(-1)!, /主工作区里没有，不要用 read 去找[\s\S]*===== docs\/prd\/prd\.md[\s\S]*- 新增待办\n- 标签[\s\S]*===== docs\/architecture\/arch\.md/);
    const flowId = p.store.readState().active_flow!;
    const flow = p.store.readFlow(flowId);
    assert.equal(flow.title, '待办应用');
    assert.deepEqual(flow.stages, ['D0', 'D2', 'E']);
    const show = (rel: string) => p.git('show', `${flow.integration_branch}:${rel}`);
    // 输入原样放进集成分支（二进制也原样），生成原型清单；接收与规划都没有子任务
    assert.match(show('docs/prd/prd.md'), /新增待办/);
    assert.match(show('docs/architecture/arch.md'), /SQLite/);
    assert.match(show('DESIGN.md'), /主色/);
    assert.match(show('prototype/INDEX.md'), /prototype\/index\.html`：待办列表/);
    assert.equal(p.git('cat-file', '-s', `${flow.integration_branch}:prototype/assets/logo.png`), '8');
    assert.match(renderStatus(p.store, p.config), /\[接收\] → 规划 → 实施 → 完成/);

    let reqRounds = 0;
    let planRounds = 0;
    const seen: string[] = [];
    await drive(p, engine, flowId, async (stage) => {
      seen.push(stage);
      if (stage === 'D2' && seen.length === 1) {
        // 规划等用户审批：模块清单与按默认处理的地方给用户看；用户打回一次，主 agent 带着意见回到规划
        assert.match(statusText(p.store, null, flowId), /T-001[\s\S]*底座/);
        assert.match(await runFlowCommand('reject "标签要能改颜色"', env), /主 agent 会带着你的意见/);
        assert.match(talks.at(-1)!, /打回了规划/);
        const f = p.store.readFlow(flowId);
        assert.deepEqual([f.stage, f.stage_status, f.planning?.submitted, f.planning?.feedback], ['D2', 'active', false, '标签要能改颜色']);
        return;
      }
      if (stage === 'D2') {
        const r = await runFlowCommand('approve', env);
        assert.match(r, /已按模块清单创建 3 个模块任务/);
        assert.match(readFileSync(path.join(p.dir, 'rules/project.md'), 'utf8'), /用 SQLite/);
        return;
      }
      await runFlowCommand('approve --yes', env);
    }, async (stage) => {
      const step = nextStep(p.store, 3, 0, p.config);
      const f = p.store.readFlow(flowId);
      if (stage === 'D0') {
        // 接收：指引是就绪检查（不是逐轮讨论），注入 intake-check；规划文档此时只能写 DESIGN.md
        assert.equal(step.tool, 'forge_requirements');
        assert.match(step.next, /现在是接收[\s\S]*docs\/prd\/prd\.md[\s\S]*只就缺口/);
        assert.deepEqual(mainSkillNames(f), ['intake-check', 'write-requirements']);
        // 每轮状态注入都带原件：不依赖终端 startConversation，也覆盖恢复与打回后的 D0。
        assert.match(turnContext(p.store, 3, 0, p.config), /===== docs\/prd\/prd\.md[\s\S]*- 新增待办\n- 标签[\s\S]*===== docs\/architecture\/arch\.md[\s\S]*Node \+ SQLite/);
        assert.equal(existsSync(path.join(p.dir, 'docs/prd/prd.md')), false, '主工作区不必检出原件');
        assert.throws(() => flowPlanDoc(p.dir, p.store, { path: 'docs/modules.md', content: 'x' }), /只能在规划阶段/);
        if (reqRounds++ === 0) {
          // 第一次没有给验收条目编号：检查不通过，带着原因回到接收
          await flowRequirements(p.dir, p.store, engine, { content: REQUIREMENTS(false) });
          const back = p.store.readFlow(flowId);
          assert.deepEqual([back.stage, back.requirements?.submitted], ['D0', false]);
          assert.match(back.requirements?.feedback ?? '', /AC-01/);
          return;
        }
        assert.match(step.next, /没有通过或被打回[\s\S]*AC-01/);
        const r = await flowRequirements(p.dir, p.store, engine, { content: REQUIREMENTS(true) });
        assert.match(r.text, /检查通过，进入规划/);
        return;
      }
      // 规划：主 agent 自己写规划文档、提交模块清单
      assert.equal(step.tool, 'forge_propose_modules');
      assert.doesNotMatch(turnContext(p.store, 3, 0, p.config), /===== docs\/prd\/prd\.md/, '规划阶段不重复注入接收原文');
      assert.deepEqual(mainSkillNames(f), ['plan-modules', 'domain-modeling', 'write-rules']);
      assert.match(step.next, /你自己规划[\s\S]*docs\/architecture\/arch\.md[\s\S]*prototype\/INDEX\.md/);
      planRounds++;
      if (planRounds === 1) {
        await assert.rejects(flowProposeModules(p.dir, p.store, p.config, engine, { modules: MODULES }), /还没有写 docs\/modules\.md/);
        assert.throws(() => flowPlanDoc(p.dir, p.store, { path: 'src/app.ts', content: 'x' }), /不在规划文档范围内/);
        assert.match(flowPlanDoc(p.dir, p.store, { path: 'docs/modules.md', content: '# 模块\n' }).text, /已写入 docs\/modules\.md/);
        await assert.rejects(flowProposeModules(p.dir, p.store, p.config, engine, { modules: [{ id: 'M-1', title: 'x', writes: ['**'], acceptance: ['a'], ui_pages: ['prototype/nope.html'] }] }),
          (e: Error) => /不合法/.test(e.message) && /原型里没有 prototype\/nope\.html/.test(e.message));
        // 漏写项目规则：规划检查不通过，带着原因回到规划
        const r = await flowProposeModules(p.dir, p.store, p.config, engine, { modules: MODULES, assumptions: ['标签不区分大小写'] });
        assert.match(r.text, /规划检查没有通过[\s\S]*project\.md/);
        return;
      }
      if (planRounds === 2) assert.match(step.next, /没有通过或被打回[\s\S]*project\.md/);
      if (planRounds === 3) assert.match(step.next, /标签要能改颜色/);
      flowPlanDoc(p.dir, p.store, { path: 'docs/rules-draft/project.md', content: '# 项目规则\n- 用 SQLite\n' });
      const r = await flowProposeModules(p.dir, p.store, p.config, engine, { modules: MODULES, assumptions: ['标签不区分大小写'] });
      assert.match(r.text, /等用户审批/);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(seen, ['D2', 'D2', 'E']);
    assert.ok(!roles.includes('architect') && !roles.includes('designer'), '接收与规划都不派子进程');
    const tasks = p.store.listTasks(flowId);
    const mods = tasks.filter((t) => t.needs_acceptance);
    assert.equal(mods.length, 3);
    assert.ok(mods.every((t) => t.status === 'done' && t.accepted && t.created_by === 'orchestrator'));
    const base = mods.find((t) => t.title.includes('底座'))!;
    assert.equal(p.store.readAcceptance(flowId, base.id)!.round, 1);
    // 界面模块：原型页面与用户给的设计规范加进输入，界面检查交给用户
    const todo = mods.find((t) => t.title.startsWith('待办'))!;
    assert.ok(['prototype/index.html', 'DESIGN.md'].every((f) => todo.inputs.includes(f)), todo.inputs.join());
    assert.match(todo.manual_checks!.join('\n'), /^界面按原型 prototype\/index\.html 实现[\s\S]*\n界面遵循 DESIGN\.md/);
    assert.ok(!base.inputs.includes('DESIGN.md'), '没有界面的模块不加设计规范');
    const fix = tasks.find((t) => t.kind === 'review-fix')!;
    assert.match(fix.acceptance[0]!, /A-2 AC-03：首页能打开（未通过：GET \/ 返回 404）/);
    const main = p.git('show', 'main:src/routes.ts');
    for (const m of mods) assert.match(main, new RegExp(`// ${m.id}`));
    assert.match(p.git('show', 'main:docs/prd/prd.md'), /新增待办/);
  } finally { rmSync(input, { recursive: true, force: true }); p.cleanup(); }
});

test('没有 PRD 时退回讨论；规划闸门设为自动通过时提交模块清单后直接开工并应用规则草案；输入路径写错时不建流程', async () => {
  const yaml = FLOW5_YAML.replace(/(id: D2, name: planning, +phase: planning, +gate: \{ )human: true/g, '$1human: false');
  const p = await setupProject({ yaml });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.equal(parseConfig(yaml).raw.modes['build']!.stages[1]!.gate.human, false);
    const { engine } = makeEngine(p, async () => {}, SETTINGS5);
    const talks: string[] = [];
    const env = { ...cmdEnv(p, engine), startConversation: (text: string) => { talks.push(text); } };
    await assert.rejects(runFlowBuild('--prd nope.md', env), /找不到 PRD nope\.md/);
    await assert.rejects(runFlowBuild('--design x', env), /要和 --prd 一起用/);
    assert.equal(p.store.readState().active_flow, null);
    await runFlowBuild('做一个命令行记账工具', env);
    assert.match(talks.at(-1)!, /开始需求讨论/);
    const flowId = p.store.readState().active_flow!;
    const f = p.store.readFlow(flowId);
    assert.equal(f.intake, undefined);
    assert.deepEqual(mainSkillNames(f), ['grilling', 'write-requirements']);
    assert.match(nextStep(p.store, 3, 0, p.config).next, /需求讨论（用户没有给 PRD）/);
    assert.match(renderStatus(p.store, p.config), /\[需求\] → 规划/);
    await flowRequirements(p.dir, p.store, engine, { content: '# 记账\n- R1 记一笔账\n  AC-01：add 命令写入一条记录\n' });
    assert.equal(p.store.readFlow(flowId).stage, 'D2');
    flowPlanDoc(p.dir, p.store, { path: 'docs/modules.md', content: '# 模块\n' });
    flowPlanDoc(p.dir, p.store, { path: 'docs/rules-draft/project.md', content: '# 项目规则\n- 用 TypeScript\n' });
    const r = await flowProposeModules(p.dir, p.store, p.config, engine, { modules: [{ id: 'M-1', title: '记账', writes: ['src/**'], acceptance: ['AC-01：add 命令写入一条记录'] }] });
    assert.match(r.text, /自动批准[\s\S]*进入 E/);
    const after = p.store.readFlow(flowId);
    assert.equal(after.stage, 'E');
    assert.equal(p.store.listTasks(flowId).filter((t) => t.needs_acceptance).length, 1);
    assert.match(readFileSync(path.join(p.dir, 'rules/project.md'), 'utf8'), /用 TypeScript/);
    // 实施阶段改计划：/forge replan 记下请求交给主 agent，不再派子任务
    assert.match(await runFlowCommand('replan "加一个导出 CSV"', env), /交给主 agent 起草/);
    assert.match(talks.at(-1)!, /我要修订计划：加一个导出 CSV/);
    const step = nextStep(p.store, 3, 0, p.config);
    assert.equal(step.tool, 'forge_revise_plan');
    assert.deepEqual(mainSkillNames(p.store.readFlow(flowId)), ['revise-plan']);
    assert.equal(p.store.listTasks(flowId).length, 1);
  } finally { p.cleanup(); }
});
