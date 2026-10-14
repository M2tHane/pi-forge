import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, listBoards, resetBoards } from '../../src/server/boards.ts';

beforeEach(() => resetBoards());

test('创建看板返回编号', () => {
  const r = createBoard('周计划');
  assert.equal(r.status, 201);
  assert.match((r.body as { id: string }).id, /^b-\d+$/);
  assert.equal((listBoards().body as unknown[]).length, 1);
});

test('名称为空返回 400', () => {
  assert.equal(createBoard('  ').status, 400);
});
