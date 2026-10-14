import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunFailure } from '../../src/core/engine/failure-class.ts';
import { pauseDuration } from '../../src/core/engine/model-pause.ts';
import { renderRunFailures, runFailures } from '../../src/core/stage/signoff.ts';

const kind = (r: Parameters<typeof classifyRunFailure>[0]) => classifyRunFailure(r).kind;

test('模型的问题暂停模型、不计任务失败：额度、限流与 5xx、配置错误', () => {
  assert.equal(kind({ error: 'You have hit your usage limit. Try again in ~42 min', exitCode: 0 }), 'model_quota');
  assert.equal(kind({ error: 'magpie API error (502): Bad Gateway', exitCode: 0 }), 'model_unavailable');
  for (const error of ['401 Unauthorized', 'invalid_api_key: Incorrect API key provided', 'The model `gpt-x` does not exist or you do not have access to it']) {
    const c = classifyRunFailure({ error, exitCode: 0 });
    assert.equal(c.kind, 'model_config', error);
    assert.equal(c.recovery, 'pause_model');
    assert.equal(c.pause?.kind, 'config');
  }
  // Pi 启动时的配置错误在 stderr（退出码非 0）
  assert.equal(kind({ error: null, stderrTail: 'No API key found for "magpie".\n\nUse /login ...', exitCode: 1 }), 'model_config');
  assert.equal(kind({ error: null, stderrTail: 'Model "glm-9" not found. Use --list-models to see available models.', exitCode: 1 }), 'model_config');
  // 自定义模型名的提醒不是错误
  assert.equal(kind({ error: null, stderrTail: 'Warning: Model "glm-5.3-flash" not found for provider "magpie". Using custom model id.', exitCode: 0 }), 'no_submit');
  // 401 只在模型返回的错误里认，stderr 里的数字不算
  assert.equal(kind({ error: null, stderrTail: 'took 401 ms', exitCode: 1 }), 'crash');
  // 配置错误要手动恢复
  assert.equal(pauseDuration({ kind: 'config' }, 1), null);
});

test('运行环境的问题交给用户，不重试；上下文超限从头重试并带上提示', () => {
  for (const stderrTail of ['Error: ENOSPC: no space left on device, write', 'Error: Cannot find module \'/x/guard.js\'', 'Error: spawn pi ENOENT']) {
    const c = classifyRunFailure({ error: null, stderrTail, exitCode: null });
    assert.equal(c.kind, 'environment', stderrTail);
    assert.equal(c.recovery, 'hand_to_user');
    assert.match(c.reason, /\/forge unblock/);
  }
  const o = classifyRunFailure({ error: 'prompt is too long: 213462 tokens > 200000 maximum', exitCode: 0 });
  assert.equal(o.kind, 'context_overflow');
  assert.equal(o.recovery, 'retry');
  assert.match(o.reason, /上下文超限.*行号范围/);
});

test('正常退出没提交与异常退出：重试；原因稳定，失败签名能识别重复', () => {
  const a = classifyRunFailure({ error: null, stderrTail: '', exitCode: 0 });
  assert.equal(a.kind, 'no_submit');
  assert.equal(a.recovery, 'retry');
  assert.match(a.reason, /未提交就结束.*forge_submit/);
  assert.equal(classifyRunFailure({ error: null, exitCode: 0 }).reason, a.reason);
  const killed = classifyRunFailure({ error: 'aborted', stderrTail: '', exitCode: null });
  assert.equal(killed.kind, 'crash');
  assert.match(killed.reason, /被信号结束/);
  assert.match(classifyRunFailure({ error: 'boom', exitCode: 1 }).reason, /没有提交（boom）/);
});

test('度量：没提交就结束的 run 按类别计数', () => {
  const f = runFailures([{ failure_kind: 'no_submit' }, { failure_kind: 'no_submit' }, { failure_kind: 'crash' }, {}]);
  assert.deepEqual(f, { no_submit: 2, crash: 1 });
  assert.equal(renderRunFailures(f), '运行没提交就结束：未提交 2、异常退出 1');
  assert.equal(renderRunFailures({}), '运行没提交就结束：0');
});
