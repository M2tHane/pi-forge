// 可选参数里的占位值当作没传（偏离 82）：M9 冒烟里 gpt 给 forge_spec 的 feature/feature_name 填了 'N/A'，build 流程反复拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { withoutPlaceholders } from '../../src/core/tool-params.ts';
import { SpecParams, WaitParams } from '../../src/tools/orchestrator-tools.ts';

test('withoutPlaceholders：去掉可选参数里的 N/A、空串、null；必填与正常值原样保留', () => {
  const p = { requirements: 'r', screens: 's', permissions: 'p', glossary: 'g', feature: 'N/A', feature_name: ' n/a ' };
  assert.deepEqual(withoutPlaceholders(SpecParams, p), { requirements: 'r', screens: 's', permissions: 'p', glossary: 'g' });
  assert.deepEqual(withoutPlaceholders(SpecParams, { requirements: 'r', feature: '', feature_name: null }), { requirements: 'r' });
  assert.deepEqual(withoutPlaceholders(SpecParams, { requirements: '无', feature: '新增归档' }), { feature: '新增归档' });
  // 带格式约束的可选参数：占位值去掉后才能通过 schema 校验
  assert.equal(Value.Check(WaitParams, { task_id: 'N/A' }), false);
  assert.equal(Value.Check(WaitParams, withoutPlaceholders(WaitParams, { task_id: 'N/A' })), true);
});

test('withoutPlaceholders：必填参数的占位值不动（交给 schema 与业务校验报错）；非对象原样返回', () => {
  const schema = { type: 'object', properties: { reason: { type: 'string' }, note: { type: 'string' } }, required: ['reason'] };
  assert.deepEqual(withoutPlaceholders(schema, { reason: 'N/A', note: '-' }), { reason: 'N/A' });
  assert.equal(withoutPlaceholders(schema, 'x'), 'x');
  assert.deepEqual(withoutPlaceholders({ type: 'string' }, { a: '' }), { a: '' });
});
