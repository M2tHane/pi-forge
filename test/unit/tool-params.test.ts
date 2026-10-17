// 可选参数里的占位值当作没传：M9 冒烟里 gpt 给 forge_spec 的 feature/feature_name 填了 'N/A'，build 流程反复拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { withoutPlaceholders } from '../../src/core/security/tool-params.ts';
import { Type } from 'typebox';
import { WaitParams } from '../../src/tools/orchestrator-tools.ts';

const Params = Type.Object({ title: Type.String(), description: Type.Optional(Type.String()), note: Type.Optional(Type.String()), detail: Type.Optional(Type.String()) });

test('withoutPlaceholders：去掉可选参数里的 N/A、空串、null；必填与正常值原样保留', () => {
  assert.deepEqual(withoutPlaceholders(Params, { title: 't', description: 'd', note: 'n', detail: 'N/A' }), { title: 't', description: 'd', note: 'n' });
  assert.deepEqual(withoutPlaceholders(Params, { title: 't', description: '', note: null }), { title: 't' });
  assert.deepEqual(withoutPlaceholders(Params, { title: 't', description: '无', note: '说明' }), { title: 't', note: '说明' });
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
