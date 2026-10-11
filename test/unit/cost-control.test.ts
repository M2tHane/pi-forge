// 改编自 pi-flow test/unit/cost-control.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/core/state/config.ts';
import { escalationModel, resolveModelRef } from '../../src/core/insight/cost-control.ts';
import { TEMPLATE_YAML, TEST_YAML } from '../helpers/config.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

// 中等档的 test-author 验证默认升级；worker 在真实模板里已是 strong。
const YAML = TEST_YAML.replace(/models:[\s\S]*?\nmodes:/, 'models:\n  strong: "p/strong"\n  medium: "p/medium"\n  cheap:  "<provider/model>"\nmodes:');
const config = parseConfig(YAML);

test('模型引用与升级：档位或 provider/model；占位符取不到；默认升到上一档；/forge-config 优先；与原模型相同不升级', () => {
  assert.equal(resolveModelRef(config, 'strong'), 'p/strong');
  assert.equal(resolveModelRef(config, 'cheap'), null);
  assert.equal(resolveModelRef(config, 'x/y'), 'x/y');
  const none = { version: 1 as const, roles: {} };
  assert.equal(escalationModel(config, none, 'test-author', 'p/medium'), 'p/strong');
  assert.equal(escalationModel(config, none, 'worker', 'p/strong'), null, 'worker 默认 strong，没有上一档');
  assert.equal(escalationModel(config, none, 'architect', 'p/strong'), null, 'strong 没有上一档');
  assert.equal(escalationModel(config, { version: 1, roles: { 'worker': { escalate_model: 'q/big' } } }, 'worker', 'p/medium'), 'q/big');
  assert.equal(escalationModel(config, none, 'worker', 'p/strong'), null);
  assert.throws(() => parseConfig(YAML.replace('roles:\n', 'roles:\n  x-role: { model: medium, tools: [read], escalate_model: huge }\n')), /模型档位 huge 未在 models 中定义/);
});

