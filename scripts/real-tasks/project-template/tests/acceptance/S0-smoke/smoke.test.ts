import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, reset } from '../_support/api.ts';

test('[REQ-001.AC1] 创建看板返回编号', () => {
  reset();
  const r = api('POST', '/boards', { name: '冒烟' });
  assert.equal(r.status, 201);
});

test('[REQ-001.AC2] 名称为空返回 400 与 E_VALIDATION', () => {
  reset();
  const r = api('POST', '/boards', { name: '' });
  assert.equal(r.status, 400);
  assert.equal((r.body as { error: { code: string } }).error.code, 'E_VALIDATION');
});
