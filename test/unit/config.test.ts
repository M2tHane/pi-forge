// 改编自 pi-flow test/unit/config.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import { parseConfig, ConfigError } from '../../src/core/config.ts';
import { PHASES, type WorkflowFile } from '../../src/core/schemas.ts';
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
    for (const mode of ['build', 'feature'] as const) {
      assert.deepEqual(c.raw.modes[mode]?.stages.map((s) => s.id), ['P0', 'P1']);
    }
    assert.deepEqual(Object.keys(c.roles).sort(), ['orchestrator', 'architect', 'worker', 'test-author', 'reviewer', 'stage-qa', 'researcher'].sort());
    const template = parseConfig(REAL_TEMPLATE_YAML);
    assert.deepEqual(c.raw.scopes, template.raw.scopes);
    assert.deepEqual(c.raw.tool_groups, template.raw.tool_groups);
    for (const name of Object.keys(template.roles)) {
      const role = c.role(name), expected = template.role(name);
      assert.deepEqual(role.scopes, expected.scopes, name);
      assert.deepEqual(role.writes, expected.writes, name);
      assert.deepEqual(role.readPaths, expected.readPaths, name);
      assert.equal(role.modelTier, expected.modelTier, name);
      assert.equal(role.bash, expected.bash, name);
      assert.deepEqual(role.bashAllow, expected.bashAllow, name);
      assert.deepEqual([...role.tools].sort(), [...expected.tools].sort(), name);
    }
  }
  const c = parseConfig(TEST_YAML);
  assert.equal(c.limits.max_parallel, 2);
  assert.equal(c.limits.auto_dispatch, false);
  assert.deepEqual(PHASES, ['spec', 'plan', 'implementation']);
});

test('新配置块、命令与次数默认值可读取', () => {
  const c = parseConfig(changed((wf) => {
    wf.commands.db_create = 'createdb $FORGE_DB_NAME';
    wf.commands.db_drop = 'dropdb --if-exists $FORGE_DB_NAME';
    delete wf.limits.max_precheck_failures;
    delete wf.limits.max_merge_failures;
  }));
  assert.equal(c.limits.max_precheck_failures, 3);
  assert.equal(c.limits.max_merge_failures, 2);
  assert.equal(c.limits.max_parallel_aux, 4);
  assert.equal(c.limits.lean_below_loc, 6000);
  assert.equal(c.limits.port_block, 10);
  assert.equal(c.raw.review?.per_task, true);
  assert.equal(c.raw.review?.max_rounds, 2);
  assert.deepEqual(c.raw.review?.skip_sizes, ['S']);
  assert.equal(c.raw.testing?.adjust_tests, true, '按真实模板保留');
  assert.equal(c.raw.testing?.max_disputes, 1);
  assert.equal(c.raw.qa?.max_rounds, 2);
  assert.deepEqual(c.raw.generated_paths, ['web/src/api/generated/**']);
  assert.deepEqual(c.raw.acctest_workspace?.cache, ['node_modules']);
  assert.ok(c.raw.acctest_workspace?.include?.includes('vitest.config.*'));
  assert.equal(c.commands.db_create, 'createdb $FORGE_DB_NAME');
  assert.equal(c.commands.db_drop, 'dropdb --if-exists $FORGE_DB_NAME');
});

test('角色 writes 由真实 scopes 并集推导；env 与读路径顺序保留', () => {
  const c = parseConfig(TEST_YAML);
  assert.deepEqual(c.role('architect').writes, ['docs/contracts/**', 'docs/arch/**', 'docs/plan/**', 'docs/spec/glossary.md', 'docs/rules-draft/**', 'AGENTS.md']);
  assert.deepEqual(c.role('reviewer').writes, []);
  assert.deepEqual(c.role('stage-qa').writes, []);
  assert.deepEqual(c.role('test-author').writes, ['tests/acceptance/**']);
  assert.deepEqual(c.role('researcher').writes, ['docs/research/**']);
  assert.deepEqual(c.role('worker').writes, ['**']);
  assert.deepEqual(c.role('worker').env, {});
  assert.equal(c.role('worker').modelTier, 'strong');
  const strict = parseConfig(changed((wf) => {
    wf.roles['worker']!.env = { PI_SERENA_STRICT: '1' };
    wf.roles.worker!.read_paths = ['**', '!a/**', 'a/b/**'];
  }, TEST_YAML));
  assert.equal(strict.role('worker').env.PI_SERENA_STRICT, '1');
  assert.deepEqual(strict.role('worker').readPaths, ['**', '!a/**', 'a/b/**']);
  assert.match(errorsOf(changed((wf) => { wf.roles.researcher!.writes = ['src/**']; })).join(), /roles\.researcher\.writes.*scopes/);
});

test('工具组展开、类别与唯一列表；orchestrator 严格使用规格白名单', () => {
  const c = parseConfig(REAL_TEMPLATE_YAML);
  const orchestrator = c.role('orchestrator');
  assert.deepEqual(orchestrator.readPaths, ['**']);
  assert.deepEqual(orchestrator.writes, []);
  assert.equal(orchestrator.bash, 'none');
  assert.ok(!orchestrator.tools.has('bash'));
  assert.deepEqual([...orchestrator.tools].sort(), ['read', 'grep', 'find', 'ls', 'forge_read', 'ask_user', 'forge_spec', 'forge_spec_amend', 'forge_status', 'forge_wait', 'forge_change_request', 'forge_resolve_timeout', 'forge_resolve_scope', 'notes', 'history'].sort());
  assert.equal(c.role('architect').bash, 'readonly');
  assert.equal(c.role('worker').bash, 'full');
  assert.ok(c.role('worker').tools.has('serena_replace_symbol_body'));
  assert.ok(c.role('worker').tools.has('serena_find_symbol'));
  assert.equal(c.toolKind('serena_replace_content'), 'write');
  assert.equal(c.toolKind('edit'), 'write');
  assert.equal(c.toolKind('web_search'), 'web');
  assert.equal(c.toolKind('forge_spec'), 'flow');
  assert.equal(c.toolKind('forge_qa_confirm'), 'flow');
  assert.equal(c.toolKind('unknown'), 'other');
  for (const r of Object.values(c.roles)) assert.equal(r.toolList.length, r.tools.size);
  assert.deepEqual(c.activeTools('worker'), c.role('worker').toolList);
  assert.throws(() => c.role('missing'), /角色 missing/);
  assert.ok(c.dagCatalog().commands.includes('acceptance'));
});

test('orchestrator 不能拥有 bash、写工具、扩展读工具或可写范围', () => {
  for (const tool of ['write', 'codemode', 'serena_find_symbol']) {
    assert.match(errorsOf(changed((wf) => { wf.roles.orchestrator!.tools.push(tool); })).join(), /orchestrator 只能使用/);
  }
  assert.match(errorsOf(changed((wf) => { wf.roles.orchestrator!.bash = 'readonly'; })).join(), /orchestrator.*bash/);
  assert.match(errorsOf(changed((wf) => {
    wf.roles.orchestrator!.scopes = ['code'];
    delete wf.roles.orchestrator!.writes;
  })).join(), /orchestrator 不能有可写范围/);
  assert.match(errorsOf(changed((wf) => { wf.roles.reviewer!.tools.push('write'); })).join(), /reviewer 没有可写范围/);
});

const exclusiveTools: [string, string[]][] = [
  ['forge_request_scope', ['worker']], ['forge_dispute', ['worker']],
  ['forge_service', ['worker', 'stage-qa']], ['forge_propose_plan', ['architect']],
  ['forge_review_report', ['reviewer']], ['forge_review_confirm', ['reviewer']],
  ['forge_qa_report', ['stage-qa']], ['forge_qa_confirm', ['stage-qa']],
  ['forge_read', ['orchestrator']], ['forge_spec', ['orchestrator']], ['forge_spec_amend', ['orchestrator']],
  ['forge_resolve_timeout', ['orchestrator']], ['forge_resolve_scope', ['orchestrator']],
];
for (const [tool, owners] of exclusiveTools) {
  test(`专属工具 ${tool} 只给 ${owners.join('、')}，错误角色被拒`, () => {
    for (const owner of owners) {
      const c = parseConfig(changed((wf) => { wf.roles[owner]!.tools.push(tool); }));
      assert.ok(c.role(owner).tools.has(tool));
    }
    const errs = errorsOf(changed((wf) => { wf.roles.researcher!.tools.push(tool); }));
    assert.ok(errs.some((e) => e.includes(`${tool} 只能分配给 ${owners.join('、')}`)), errs.join('\n'));
  });
}

test('分组工具同样执行专属工具校验，不得借分组绕过 bash 字段', () => {
  assert.match(errorsOf(changed((wf) => {
    wf.tool_groups.invalid = ['forge_dispute'];
    wf.roles.architect!.tools.push('@invalid');
  })).join(), /forge_dispute 只能分配给 worker/);
  assert.match(errorsOf(changed((wf) => {
    wf.tool_groups.invalid = ['bash_readonly'];
    wf.roles.architect!.tools.push('@invalid');
  })).join(), /bash_readonly.*请改用.*bash:/);
});

test('worker 专属工具按真实名字校验，改名或名字后缀不能继承权限', () => {
  const c = parseConfig(TEST_YAML);
  assert.ok(c.role('worker').tools.has('forge_dispute'));
  assert.ok(c.role('worker').tools.has('forge_request_scope'));
  for (const name of ['custom-worker', 'custom-engineer']) {
    assert.match(errorsOf(changed((wf) => {
      wf.roles[name] = wf.roles.worker!;
      delete wf.roles.worker;
    }, TEST_YAML)).join(), /forge_request_scope 只能分配给 worker/);
  }
  for (const name of ['architect', 'test-author', 'researcher']) {
    assert.match(errorsOf(changed((wf) => {
      wf.roles[name]!.tools.push('forge_request_scope');
    }, TEST_YAML)).join(), /forge_request_scope 只能分配给 worker/);
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
    const implicit = r.name === 'orchestrator' ? ['notes', 'history'] : ['forge_block', 'forge_learn', 'notes', 'history'];
    assert.deepEqual([...r.tools].sort(), ['read', ...implicit].sort());
  }
  // 第 14 节：有 forge_submit 的角色才隐式拥有 forge_claim
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

test('allowlist 必须有命令名数组，命令必须存在；解析为 allowlist 并保留 bashAllow', () => {
  const c = parseConfig(REAL_TEMPLATE_YAML);
  assert.equal(c.role('test-author').bash, 'allowlist');
  assert.deepEqual(c.role('test-author').bashAllow, ['acceptance_list', 'acceptance']);
  assert.ok(c.role('test-author').tools.has('bash'));
  assert.deepEqual(c.role('worker').bashAllow, []);
  assert.match(errorsOf(changed((wf) => { delete wf.roles['test-author']!.bash_allow; })).join(), /bash: allowlist 必须配置 bash_allow/);
  assert.ok(errorsOf(changed((wf) => { wf.roles['test-author']!.bash_allow = []; })).length);
  assert.match(errorsOf(changed((wf) => { wf.roles['test-author']!.bash_allow = ['not_configured']; })).join(), /not_configured 未在 commands 中定义/);
  assert.match(errorsOf(changed((wf) => { wf.roles.worker!.bash_allow = ['test']; })).join(), /bash_allow 只能用于 bash: allowlist/);
  // Object 原型上的名字不算已配置命令。
  assert.match(errorsOf(changed((wf) => { wf.roles['test-author']!.bash_allow = ['toString']; })).join(), /toString 未在 commands/);
});

test('implementation_gate 保留可选 auto 命令；固定阶段 gate 引用缺失命令时报错', () => {
  const c = parseConfig(REAL_TEMPLATE_YAML);
  assert.ok(c.raw.implementation_gate?.auto?.includes('e2e'));
  assert.ok(!Object.hasOwn(c.commands, 'e2e'));
  assert.equal(c.raw.implementation_gate?.coverage, true);
  assert.equal(c.raw.implementation_gate?.qa, true);
  // 模板不写 test_author：按 plan_mode 决定（偏离 98）
  assert.equal(c.raw.implementation_gate?.test_author, undefined);
  assert.equal(c.testAuthorFor({ plan_mode: 'standard' }), true);
  assert.equal(c.testAuthorFor({}), true);
  assert.equal(c.testAuthorFor({ plan_mode: 'lean' }), false);
  const off = parseConfig(changed((wf) => { wf.implementation_gate!.test_author = false; }));
  assert.equal(off.testAuthorFor({ plan_mode: 'standard' }), false);
  const on = parseConfig(changed((wf) => { wf.implementation_gate!.test_author = true; }));
  assert.equal(on.testAuthorFor({ plan_mode: 'lean' }), true);
  assert.match(errorsOf(changed((wf) => {
    wf.modes.build!.stages[1]!.gate.auto = ['missing'];
  })).join(), /modes\.build\.stages\[1\]\.gate\.auto\[0\].*missing/);
});

test('固定模式只能配置 P0、P1，phase 不能倒退或使用旧名称', () => {
  assert.match(errorsOf(changed((wf) => {
    wf.modes.build!.stages.push({ id: 'S0', name: 'implementation', phase: 'implementation', gate: {} });
  })).join(), /只能按顺序配置 P0、P1/);
  assert.match(errorsOf(changed((wf) => {
    wf.modes.feature!.stages.reverse();
  })).join(), /只能按顺序配置 P0、P1/);
  assert.match(errorsOf(changed((wf) => {
    wf.modes.build!.stages[0]!.phase = 'plan';
    wf.modes.build!.stages[1]!.phase = 'spec';
  })).join(), /高层阶段只能按 spec → plan → implementation 前进/);
  assert.ok(errorsOf(REAL_TEMPLATE_YAML.replace('phase: spec', 'phase: requirements')).length);
});

test('未知 scope、工具组、工具、模型档位的错误有 YAML 路径与行号', () => {
  const errs = errorsOf(changed((wf) => {
    wf.roles.worker!.scopes!.push('ghost');
    wf.roles.researcher!.tools.push('@nope', 'scribble');
    wf.roles.researcher!.model = 'turbo';
    wf.roles.worker!.escalate_model = 'missing';
  })).join('\n');
  assert.match(errs, /roles\.worker\.scopes\[1\]（第 \d+ 行）.*ghost/);
  assert.match(errs, /roles\.researcher\.tools\[\d+\].*nope/);
  assert.match(errs, /scribble/);
  assert.match(errs, /roles\.researcher\.model.*turbo/);
  assert.match(errs, /roles\.worker\.escalate_model.*missing/);
  assert.equal(errorsOf(changed((wf) => { wf.roles.worker!.escalate_model = 'provider/model'; })).length, 0);
});

test('语法错误、schema 错误与旧工具被拒绝', () => {
  assert.match(errorsOf('version: 1\nproject: [').join(), /YAML/);
  assert.match(errorsOf(TEST_YAML.replace('max_parallel: 2', 'max_parallel: "two"')).join(), /limits\.max_parallel/);
  for (const tool of ['forge_dispatch', 'forge_accept', 'forge_propose_modules', 'forge_requirements']) {
    assert.match(errorsOf(changed((wf) => { wf.roles.worker!.tools.push(tool); })).join(), /未知工具/);
  }
  assert.ok(errorsOf(REAL_TEMPLATE_YAML.replace('per_task: true', 'final: true')).length);
  for (const key of ['max_precheck_failures', 'max_merge_failures', 'max_parallel_aux', 'port_block', 'lean_below_loc']) {
    assert.ok(errorsOf(changed((wf) => { Object.assign(wf.limits, { [key]: 0 }); })).length, key);
  }
  assert.ok(errorsOf(changed((wf) => { wf.roles.worker!.tools.push('@serena_missing'); })).length);
});
