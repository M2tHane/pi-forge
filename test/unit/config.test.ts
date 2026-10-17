import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import { parseConfig, ConfigError } from '../../src/core/state/config.ts';
import { parseProjectCommands } from '../../src/core/state/project-commands.ts';
import type { WorkflowFile } from '../../src/core/state/schemas.ts';
import { TEMPLATE_YAML, TEST_YAML, REAL_TEMPLATE_YAML } from '../helpers/config.ts';

const errorsOf = (yaml: string): string[] => {
  try { parseConfig(yaml); }
  catch (e) {
    if (e instanceof ConfigError) return e.errors;
    throw e;
  }
  return [];
};
const changed = (change: (wf: WorkflowFile) => void, source = REAL_TEMPLATE_YAML): string => {
  const wf = parse(source) as WorkflowFile;
  change(wf);
  return stringify(wf);
};

test('真实 v3 模板与运行时夹具通过校验，测试派发配置固定', () => {
  for (const source of [REAL_TEMPLATE_YAML, TEMPLATE_YAML]) {
    const c = parseConfig(source);
    assert.equal(c.limits.max_parallel, 3);
    assert.ok(c.warnings.some((w) => w.includes('models.strong')));
    assert.ok(!c.warnings.some((w) => w.includes('已不再支持')), c.warnings.join('\n'));
    assert.deepEqual(Object.keys(c.roles).sort(), ['orchestrator', 'architect', 'backend', 'frontend', 'worker', 'reviewer', 'stage-qa'].sort());
    const template = parseConfig(REAL_TEMPLATE_YAML);
    assert.deepEqual(c.raw.scopes, template.raw.scopes);
    assert.deepEqual(c.raw.tool_groups, template.raw.tool_groups);
    for (const name of Object.keys(template.roles)) {
      const role = c.role(name), expected = template.role(name);
      assert.deepEqual(role.scopes, expected.scopes, name);
      assert.deepEqual(role.writes, expected.writes, name);
      assert.equal(role.modelTier, expected.modelTier, name);
      assert.equal(role.bash, expected.bash, name);
      assert.deepEqual(role.bashAllow, expected.bashAllow, name);
      // 模板的 worker 不再有 forge_dispute；运行时夹具为沿用争议用例保留
      const noDispute = (ts: Iterable<string>) => [...ts].filter((x) => x !== 'forge_dispute').sort();
      assert.deepEqual(noDispute(role.tools), noDispute(expected.tools), name);
    }
  }
  const c = parseConfig(TEST_YAML);
  assert.equal(c.limits.max_parallel, 2);
  assert.equal(c.limits.auto_dispatch, false);
});

test('新配置块、命令与次数默认值可读取；命令来自 commands.yaml，没有时用 workflow.yaml 里旧的 commands', () => {
  const c = parseConfig(changed((wf) => {
    delete wf.limits.max_merge_failures;
  }));
  assert.equal(c.limits.max_merge_failures, 2);
  assert.equal(c.limits.max_parallel_aux, 4);
  assert.equal(c.limits.port_block, 10);
  assert.equal(c.raw.review?.max_rounds, 2);
  assert.equal(c.raw.testing?.adjust_tests, true, '按真实模板保留');
  assert.equal(c.raw.qa?.max_rounds, 2);
  assert.deepEqual(c.commands, {}, '模板的 workflow.yaml 不再有命令');
  c.setProjectCommands(parseProjectCommands('commands:\n  test: "npm test"\n  db_create: "createdb $FORGE_DB_NAME"\ngui_commands: ["npm run desktop"]\nshared_env: { deps: [.venv] }\n'));
  assert.deepEqual([c.commands.db_create, c.guiCommands, c.sharedEnv?.deps], ['createdb $FORGE_DB_NAME', ['npm run desktop'], ['.venv']]);
  const legacy = parseConfig(TEMPLATE_YAML);
  assert.equal(legacy.commands['test'], 'pnpm test', '老项目 workflow.yaml 里的 commands 仍然认');
});

test('角色 writes 由真实 scopes 并集推导；env 与读路径顺序保留', () => {
  const c = parseConfig(TEST_YAML);
  // architect 兼有 plan 与 code scope（S0 搭骨架）；P1 的 task 只取 plan scope（config.scopeWrites()）
  assert.deepEqual(c.role('architect').scopes, ['plan', 'code']);
  assert.deepEqual(c.role('architect').writes, ['docs/contracts/**', 'docs/arch/**', 'docs/plan/**', 'commands.yaml', 'AGENTS.md', '**']);
  assert.deepEqual(c.scopeWrites()['plan'], ['docs/contracts/**', 'docs/arch/**', 'docs/plan/**', 'commands.yaml', 'AGENTS.md']);
  assert.deepEqual(c.role('reviewer').writes, []);
  assert.deepEqual(c.role('stage-qa').writes, []);
  assert.deepEqual(c.role('worker').writes, ['**']);
  assert.deepEqual(c.role('worker').env, {});
  assert.equal(c.role('worker').modelTier, 'strong');
  const strict = parseConfig(changed((wf) => {
    wf.roles['worker']!.env = { PI_FORGE_STRICT: '1' };
    wf.roles.worker!.read_paths = ['**'];
  }, TEST_YAML));
  assert.equal(strict.role('worker').env.PI_FORGE_STRICT, '1');
  // 旧配置里的 read_paths 仍能解析（已不再使用）
  assert.match(errorsOf(changed((wf) => { wf.roles.reviewer!.writes = ['src/**']; })).join(), /roles\.reviewer\.writes.*scopes/);
});

test('工具组展开、类别与唯一列表；orchestrator 严格使用规格白名单', () => {
  const c = parseConfig(REAL_TEMPLATE_YAML);
  const orchestrator = c.role('orchestrator');
  assert.deepEqual(orchestrator.writes, []);
  assert.equal(orchestrator.bash, 'none');
  assert.ok(!orchestrator.tools.has('bash'));
  assert.deepEqual([...orchestrator.tools].sort(), ['read', 'grep', 'find', 'ls', 'forge_read', 'ask_user', 'forge_change', 'forge_status', 'forge_wait', 'forge_change_request', 'forge_resolve_timeout', 'forge_decide', 'notes', 'history'].sort());
  assert.equal(c.role('architect').bash, 'full');
  assert.equal(c.role('worker').bash, 'full');
  assert.ok(c.role('worker').tools.has('codegraph_search'));
  assert.equal(c.toolKind('codegraph_search'), 'ext-read');
  assert.equal(c.toolKind('edit'), 'write');
  assert.equal(c.toolKind('web_search'), 'web');
  assert.equal(c.toolKind('forge_wait'), 'flow');
  assert.equal(c.toolKind('forge_qa_confirm'), 'flow');
  assert.equal(c.toolKind('unknown'), 'other');
  for (const r of Object.values(c.roles)) assert.equal(r.toolList.length, r.tools.size);
  assert.deepEqual(c.activeTools('worker'), c.role('worker').toolList);
  assert.throws(() => c.role('missing'), /角色 missing/);
  assert.ok(parseConfig(TEMPLATE_YAML).dagCatalog().commands.includes('acceptance'));
});

test('limits.change_max_tasks 默认 3，可配置，必须是正整数', () => {
  assert.equal(parseConfig(REAL_TEMPLATE_YAML).limits.change_max_tasks, 3);
  assert.equal(parseConfig(changed((wf) => { delete (wf.limits as Record<string, unknown>)['change_max_tasks']; })).limits.change_max_tasks, 3, '缺省补 3');
  assert.equal(parseConfig(changed((wf) => { (wf.limits as Record<string, unknown>)['change_max_tasks'] = 5; })).limits.change_max_tasks, 5);
  assert.throws(() => parseConfig(changed((wf) => { (wf.limits as Record<string, unknown>)['change_max_tasks'] = 0; })));
});

test('orchestrator 不能拥有 bash、写工具、扩展读工具或可写范围', () => {
  for (const tool of ['write', 'codemode', 'codegraph_search']) {
    assert.match(errorsOf(changed((wf) => { wf.roles.orchestrator!.tools.push(tool); })).join(), /orchestrator 只能使用/);
  }
  assert.match(errorsOf(changed((wf) => { wf.roles.orchestrator!.bash = 'readonly'; })).join(), /orchestrator.*bash/);
  assert.match(errorsOf(changed((wf) => {
    wf.roles.orchestrator!.scopes = ['code'];
    delete wf.roles.orchestrator!.writes;
  })).join(), /orchestrator 不能有可写范围/);
  assert.match(errorsOf(changed((wf) => { wf.roles.reviewer!.tools.push('write'); })).join(), /reviewer 没有可写范围/);
});

const CODERS = ['worker', 'backend', 'frontend', 'architect'];
const exclusiveTools: [string, string[]][] = [
  ['forge_add_dependency', CODERS], ['forge_private_deps', CODERS],
  ['forge_service', [...CODERS, 'stage-qa']], ['forge_propose_plan', ['architect']],
  ['forge_review_report', ['reviewer']], ['forge_review_confirm', ['reviewer']],
  ['forge_qa_report', ['stage-qa']], ['forge_qa_confirm', ['stage-qa']],
  ['forge_read', ['orchestrator']], ['forge_change', ['orchestrator']],
  ['forge_resolve_timeout', ['orchestrator']],
];
for (const [tool, owners] of exclusiveTools) {
  test(`专属工具 ${tool} 只给 ${owners.join('、')}，错误角色被拒`, () => {
    for (const owner of owners) {
      const c = parseConfig(changed((wf) => { wf.roles[owner]!.tools.push(tool); }));
      assert.ok(c.role(owner).tools.has(tool));
    }
    const other = ['reviewer', 'stage-qa', 'worker'].find((r) => !owners.includes(r))!;
    const errs = errorsOf(changed((wf) => { wf.roles[other]!.tools.push(tool); }));
    assert.ok(errs.some((e) => e.includes(`${tool} 只能分配给 ${owners.join('、')}`)), errs.join('\n'));
  });
}

test('分组工具同样执行专属工具校验，不得借分组绕过 bash 字段', () => {
  assert.match(errorsOf(changed((wf) => {
    wf.tool_groups.invalid = ['forge_add_dependency'];
    wf.roles.reviewer!.tools.push('@invalid');
  })).join(), /forge_add_dependency 只能分配给 worker、backend、frontend、architect/);
  assert.match(errorsOf(changed((wf) => {
    wf.tool_groups.invalid = ['bash_readonly'];
    wf.roles.architect!.tools.push('@invalid');
  })).join(), /bash_readonly.*请改用.*bash:/);
});

test('worker 专属工具按真实名字校验，改名或名字后缀不能继承权限', () => {
  const c = parseConfig(TEST_YAML);
  assert.ok(c.role('worker').tools.has('forge_add_dependency'));
  for (const name of ['custom-worker', 'custom-engineer']) {
    assert.match(errorsOf(changed((wf) => {
      wf.roles[name] = wf.roles.worker!;
      delete wf.roles.worker;
    }, TEST_YAML)).join(), /forge_add_dependency 只能分配给 worker、backend、frontend、architect/);
  }
  for (const name of ['reviewer', 'stage-qa']) {
    assert.match(errorsOf(changed((wf) => {
      wf.roles[name]!.tools.push('forge_add_dependency');
    }, TEST_YAML)).join(), /forge_add_dependency 只能分配给 worker、backend、frontend、architect/);
  }
});

test('architect 可以用 forge_service、forge_add_dependency、forge_private_deps、forge_sync、write（S0 由 architect 执行）', () => {
  for (const source of [REAL_TEMPLATE_YAML, TEST_YAML]) {
    const a = parseConfig(source).role('architect');
    for (const t of ['forge_service', 'forge_add_dependency', 'forge_private_deps', 'forge_sync', 'write', 'bash', 'forge_propose_plan']) assert.ok(a.tools.has(t), t);
    assert.equal(a.bash, 'full');
  }
  // 其他角色仍然不行
  for (const name of ['reviewer', 'stage-qa']) {
    assert.match(errorsOf(changed((wf) => { wf.roles[name]!.tools.push('forge_add_dependency'); }, TEST_YAML)).join(), /forge_add_dependency 只能分配给 worker、backend、frontend、architect/);
  }
});

test('隐式授予只包含通用子进程工具；专属工具不再隐式授予', () => {
  const c = parseConfig(changed((wf) => {
    for (const r of Object.values(wf.roles)) {
      r.tools = ['read'];
      delete r.bash;
      delete r.bash_allow;
    }
  }));
  for (const r of Object.values(c.roles)) {
    const implicit = r.name === 'orchestrator' ? ['forge_decide', 'notes', 'history'] : ['forge_block', 'forge_learn', 'notes', 'history'];
    assert.deepEqual([...r.tools].sort(), ['read', ...implicit].sort());
  }
  // 有 forge_submit 的角色才隐式拥有 forge_claim
  const withSubmit = parseConfig(changed((wf) => { wf.roles.worker!.tools = ['read', 'forge_submit']; }));
  assert.ok(withSubmit.roles.worker!.tools.has('forge_claim'));
  assert.ok(!withSubmit.roles.reviewer!.tools.has('forge_claim'));
});

test('必须有 orchestrator', () => {
  assert.match(errorsOf(changed((wf) => { delete wf.roles.orchestrator; })).join(), /缺少 orchestrator/);
});

for (const tool of ['bash', 'bash_readonly']) {
  test(`tools 中声明 ${tool} 报错并提示 bash 字段`, () => {
    assert.match(errorsOf(changed((wf) => { wf.roles.worker!.tools.push(tool); })).join(), /tools 中不能声明.*请改用.*bash:/);
  });
}

test('allowlist 必须有命令名数组；解析为 allowlist 并保留 bashAllow', () => {
  const c = parseConfig(REAL_TEMPLATE_YAML);
  // 模板里 reviewer 是 allowlist（放行 typecheck、lint、test、acceptance，用来核对本 task）
  assert.equal(c.role('reviewer').bash, 'allowlist');
  assert.deepEqual(c.role('reviewer').bashAllow, ['typecheck', 'lint', 'test', 'acceptance']);
  assert.ok(c.role('reviewer').tools.has('bash'));
  assert.deepEqual(c.role('worker').bashAllow, []);
  assert.match(errorsOf(changed((wf) => { delete wf.roles['reviewer']!.bash_allow; })).join(), /bash: allowlist 必须配置 bash_allow/);
  assert.ok(errorsOf(changed((wf) => { wf.roles['reviewer']!.bash_allow = []; })).length);
  // 命令名在 commands.yaml 里找，没定义的只是没有可放行的内容，不告警
  assert.ok(!parseConfig(changed((wf) => { wf.roles['reviewer']!.bash_allow = ['not_configured']; })).warnings.join().includes('not_configured'));
  assert.match(errorsOf(changed((wf) => { wf.roles.worker!.bash_allow = ['test']; })).join(), /bash_allow 只能用于 bash: allowlist/);
});

test('implementation_gate 默认只跑 test 与 acceptance（其余命令给 agent 参考）；已删除的配置项只提醒', () => {
  const c = parseConfig(REAL_TEMPLATE_YAML);
  assert.deepEqual(c.raw.implementation_gate?.auto, ['test', 'acceptance']);
  assert.equal(c.raw.implementation_gate?.coverage, true);
  assert.equal(c.raw.implementation_gate?.qa, true);
  // 已删除的配置项：旧项目的 workflow.yaml 里还有时忽略并提醒
  const legacy = parseConfig(changed((wf) => { (wf.implementation_gate as Record<string, unknown>)['test_author'] = true; (wf as Record<string, unknown>)['acctest_workspace'] = { cache: ['node_modules'] }; (wf.limits as Record<string, unknown>)['lean_below_loc'] = 6000; }));
  assert.ok(legacy.warnings.some((w) => /implementation_gate\.test_author 已不再支持/.test(w)));
  const oldTools = parseConfig(changed((wf) => { wf.roles.worker!.tools.push('forge_request_scope'); }));
  assert.ok(oldTools.warnings.some((w) => /forge_request_scope 已不再支持/.test(w)));
  assert.ok(!oldTools.role('worker').tools.has('forge_request_scope'));
  assert.ok(legacy.warnings.some((w) => /acctest_workspace 已不再支持/.test(w)));
  assert.ok(legacy.warnings.some((w) => /limits\.lean_below_loc 已不再支持/.test(w)));
  // 旧项目的 P0、P1 固定阶段与 forge_spec：忽略并提醒
  const p0 = parseConfig(changed((wf) => { (wf as Record<string, unknown>)['modes'] = { build: { stages: [{ id: 'P0', name: 'spec', gate: { human: true } }] } }; wf.roles.orchestrator!.tools.push('forge_spec'); }));
  assert.ok(p0.warnings.some((w) => /^modes 已不再支持/.test(w)));
  assert.ok(p0.warnings.some((w) => /forge_spec 已不再支持/.test(w)));
  // gate 里的命令名在 commands.yaml 里找，没有的运行时跳过，不算配置错误
  assert.deepEqual(errorsOf(changed((wf) => { wf.implementation_gate!.auto = ['missing']; })), []);
});

test('未知 scope、工具组、工具、模型档位的错误有 YAML 路径与行号', () => {
  const errs = errorsOf(changed((wf) => {
    wf.roles.worker!.scopes!.push('ghost');
    wf.roles.reviewer!.tools.push('@nope', 'scribble');
    wf.roles.reviewer!.model = 'turbo';
    wf.roles.worker!.escalate_model = 'missing';
  })).join('\n');
  assert.match(errs, /roles\.worker\.scopes\[1\]（第 \d+ 行）.*ghost/);
  assert.match(errs, /roles\.reviewer\.tools\[\d+\].*nope/);
  assert.match(errs, /scribble/);
  assert.match(errs, /roles\.reviewer\.model.*turbo/);
  assert.match(errs, /roles\.worker\.escalate_model.*missing/);
  assert.equal(errorsOf(changed((wf) => { wf.roles.worker!.escalate_model = 'provider/model'; })).length, 0);
});

test('语法错误、schema 错误与旧工具被拒绝', () => {
  assert.match(errorsOf('version: 1\nproject: [').join(), /YAML/);
  assert.match(errorsOf(TEST_YAML.replace('max_parallel: 2', 'max_parallel: "two"')).join(), /limits\.max_parallel/);
  for (const tool of ['forge_dispatch', 'forge_accept', 'forge_propose_modules', 'forge_requirements']) {
    assert.match(errorsOf(changed((wf) => { wf.roles.worker!.tools.push(tool); })).join(), /未知工具/);
  }
  assert.ok(errorsOf(REAL_TEMPLATE_YAML.replace('max_rounds: 2                   # 第 2 轮', 'final: true                     # 第 2 轮')).length);
  for (const key of ['max_parallel_backend', 'max_merge_failures', 'max_parallel_aux', 'port_block']) {
    assert.ok(errorsOf(changed((wf) => { Object.assign(wf.limits, { [key]: 0 }); })).length, key);
  }
  assert.ok(errorsOf(changed((wf) => { wf.roles.worker!.tools.push('@missing_group'); })).length);
});
