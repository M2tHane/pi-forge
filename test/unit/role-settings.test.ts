// 改编自 pi-flow test/unit/role-settings.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRoleSettings, saveRoleSettings, setRole, unsetRole, resolveRoleModel } from '../../src/core/role-settings.ts';
import { parseConfig } from '../../src/core/config.ts';
import { TEST_YAML } from '../helpers/config.ts';

const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-rs-'));
  return { file: path.join(dir, 'sub', 'pi-forge.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test('文件不存在时为空设置；保存后可读回', () => {
  const { file, cleanup } = tmp();
  try {
    assert.deepEqual(loadRoleSettings(file).roles, {});
    let s = setRole(loadRoleSettings(file), 'architect', { model: 'workbuddy/glm-5.3-flash', thinking: 'high' });
    s = setRole(s, 'stage-qa', { thinking: 'low' });
    saveRoleSettings(file, s, new Date('2026-01-01T00:00:00Z'));
    const back = loadRoleSettings(file);
    assert.deepEqual(back.roles['architect'], { model: 'workbuddy/glm-5.3-flash', thinking: 'high' });
    assert.equal(back.updated_at, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(unsetRole(back, 'architect').roles['architect'], undefined);
  } finally { cleanup(); }
});

test('损坏或不合法的文件给出中文错误', () => {
  const { file, cleanup } = tmp();
  try {
    saveRoleSettings(file, { version: 1, roles: {} });
    writeFileSync(file, '{oops');
    assert.throws(() => loadRoleSettings(file), /不是合法 JSON/);
    writeFileSync(file, JSON.stringify({ version: 1, roles: { a: { thinking: 'ultra' } } }));
    assert.throws(() => loadRoleSettings(file), /pi-forge\.json/);
    assert.throws(() => setRole({ version: 1, roles: {} }, 'a', { model: 'no-slash' }), /provider\/model/);
  } finally { cleanup(); }
});

test('解析优先级：/forge-config 设置 > workflow.yaml 档位', () => {
  const config = parseConfig(TEST_YAML.replace('medium: "<provider/model>"', 'medium: "workbuddy/glm-5.3-flash"').replace('strong: "<provider/model>"', 'strong: "openai/worker"'));
  const settings = { version: 1 as const, roles: { architect: { model: 'openai/gpt-x', thinking: 'high' as const }, researcher: { thinking: 'low' as const } } };
  assert.deepEqual(resolveRoleModel(config, settings, 'architect'), { model: 'openai/gpt-x', thinking: 'high', modelSource: 'forge-config', thinkingSource: 'forge-config' });
  assert.deepEqual(resolveRoleModel(config, settings, 'test-author'), { model: 'workbuddy/glm-5.3-flash', thinking: null, modelSource: 'workflow', thinkingSource: 'default' });
  // 档位为占位符时没有模型
  assert.deepEqual(resolveRoleModel(config, settings, 'worker'), { model: 'openai/worker', thinking: null, modelSource: 'workflow', thinkingSource: 'default' });
  assert.deepEqual(resolveRoleModel(config, settings, 'researcher'), { model: 'workbuddy/glm-5.3-flash', thinking: 'low', modelSource: 'workflow', thinkingSource: 'forge-config' });
  const placeholders = parseConfig(TEST_YAML);
  assert.deepEqual(resolveRoleModel(placeholders, settings, 'researcher'), { model: null, thinking: 'low', modelSource: 'unset', thinkingSource: 'forge-config' });
  assert.throws(() => resolveRoleModel(config, settings, 'nobody'), /nobody/);
});

test('写入是原子的且带换行', () => {
  const { file, cleanup } = tmp();
  try {
    saveRoleSettings(file, setRole({ version: 1, roles: {} }, 'x', { thinking: 'off' }));
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
  } finally { cleanup(); }
});
