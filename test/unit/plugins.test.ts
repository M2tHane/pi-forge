// 改编自 pi-flow test/unit/plugins.test.ts @ 31f3f15（M2 按 pi-forge 角色重写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pluginExtensionsFor, packageRoots } from '../../src/pi-adapter/plugins.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { TEST_YAML } from '../helpers/config.ts';

test('按角色的工具组解析插件：项目级优先，未安装的报告缺失', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-plug-'));
  try {
    const proj = path.join(dir, 'proj');
    const agent = path.join(dir, 'agent');
    const pkg = (root: string, name: string) => { mkdirSync(path.join(root, name), { recursive: true }); writeFileSync(path.join(root, name, 'package.json'), '{}'); };
    const [projNm, agentNm] = packageRoots(proj, agent);
    pkg(agentNm!, '@vndv/pi-codegraph');
    pkg(projNm!, '@vndv/pi-codegraph');
    const config = parseConfig(TEST_YAML);
    const be = pluginExtensionsFor(config, 'worker', [projNm!, agentNm!]);
    assert.deepEqual(be.paths, [path.join(projNm!, '@vndv/pi-codegraph')]);
    const rv = pluginExtensionsFor(config, 'architect', [projNm!, agentNm!]);
    assert.deepEqual(rv.paths, ['builtin:codemode', path.join(projNm!, '@vndv/pi-codegraph')]);
    const withWeb = parseConfig(TEST_YAML.replace('tools: [read, "@codegraph", forge_review_report', 'tools: [read, "@web", "@codegraph", forge_review_report'));
    assert.deepEqual(pluginExtensionsFor(withWeb, 'reviewer', [projNm!, agentNm!]), { paths: [path.join(projNm!, '@vndv/pi-codegraph')], missing: ['pi-web-access'] });
    assert.deepEqual(pluginExtensionsFor(config, 'stage-qa', [projNm!, agentNm!]), { paths: [path.join(projNm!, '@vndv/pi-codegraph')], missing: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('角色启用 codemode 时显式加载 Pi 内置扩展 builtin:codemode（子进程以 --no-extensions 运行）', async () => {
  const { parseConfig } = await import('../../src/core/state/config.ts');
  const { TEST_YAML } = await import('../helpers/config.ts');
  const { pluginExtensionsFor } = await import('../../src/pi-adapter/plugins.ts');
  const config = parseConfig(TEST_YAML);
  assert.deepEqual(pluginExtensionsFor(config, 'architect', []).paths, ['builtin:codemode']);
  assert.ok(!pluginExtensionsFor(config, 'worker', []).paths.includes('builtin:codemode'));
  assert.ok(config.activeTools('architect').includes('codemode'));
  assert.throws(() => parseConfig(TEST_YAML.replace('tools: [read, grep, find, ls, forge_read', 'tools: [codemode, read, grep, find, ls, forge_read')), /orchestrator 只能使用/);
});
