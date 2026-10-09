// 来源：pi-flow test/unit/redact.test.ts @ 31f3f15
// 敏感内容打码（第六轮 D4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redactSecrets } from '../../src/core/redact.ts';
import { redactToolResult } from '../../src/pi-adapter/redact-hook.ts';

test('常见密钥形态打码', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
  const cases = [
    pem,
    'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'xoxb-1234567890-abcdefghij',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
  ];
  for (const c of cases) {
    const r = redactSecrets(`前 ${c} 后`);
    assert.equal(r.count, 1, c);
    assert.ok(!r.text.includes(c), c);
    assert.match(r.text, /^前 \[已打码\]/);
  }
  const env = redactSecrets('DB_PASSWORD=hunter2hunter2\nexport GITHUB_TOKEN="abcdef123456"\nAPI_KEY: s3cr3tvalue1\nPORT=3000');
  assert.equal(env.count, 3);
  assert.equal(env.text, `DB_PASSWORD=${REDACTED}\nexport GITHUB_TOKEN="${REDACTED}"\nAPI_KEY: ${REDACTED}\nPORT=3000`);
});

test('变量引用、占位符与代码不打码', () => {
  const text = [
    'API_KEY=${API_KEY}', 'SECRET_TOKEN=$TOKEN', 'PASSWORD=<your-password>', 'TOKEN=short',
    'const token = req.headers.token;', 'process.env.API_KEY', 'sk-short', 'task-runner sk-',
  ].join('\n');
  assert.deepEqual(redactSecrets(text), { text, count: 0 });
});

test('工具结果：同时替换 content 与 structuredContent', () => {
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz';
  const r = redactToolResult({ content: [{ type: 'text', text: `out ${secret}` }], structuredContent: { output: `out ${secret}`, exit_code: 0 } })!;
  assert.equal(r.count, 2);
  assert.deepEqual(r.content, [{ type: 'text', text: `out ${REDACTED}` }]);
  assert.deepEqual(r.structuredContent, { output: `out ${REDACTED}`, exit_code: 0 });
  assert.equal(redactToolResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { output: 'ok' } }), null);
});
