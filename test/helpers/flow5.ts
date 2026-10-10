// 来源：pi-flow test/helpers/flow5.ts @ 31f3f15
// 第五、六轮新流程的测试夹具：真实模板（命令换成本地可跑的）、各角色的假模型、命令环境。
import path from 'node:path';
import type { Project } from './project.ts';
import type { makeEngine } from './engine.ts';
import { REAL_TEMPLATE_YAML } from './config.ts';
import type { CommandEnv } from '../../src/commands/forge.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';
const PACKAGE_ROOT = new URL('../..', import.meta.url).pathname;

/** 全量测试：仓库里有 BROKEN 文件时失败 */
export const FLOW5_YAML = REAL_TEMPLATE_YAML
  .replace(/commands:[\s\S]*?\nlimits:/, 'commands:\n  install: "true"\n  typecheck: "true"\n  lint: "true"\n  test: "test ! -e BROKEN"\n  acceptance: "true"\n  acceptance_list: "true"\nlimits:')
  .replace(/^limits:/m, 'limits:\n  timeout_review: auto')
  .replace(/^  auto_dispatch: true.*$/m, '  auto_dispatch: false');
export const SETTINGS5: RoleSettingsFile = { version: 1, roles: Object.fromEntries(
  ['orchestrator', 'worker', 'test-author', 'architect', 'stage-qa', 'reviewer', 'researcher'].map((r) => [r, { model: 'fake/m' }])) };

export function cmdEnv(p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv {
  return {
    root: p.dir, packageRoot: PACKAGE_ROOT, ui: null,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => SETTINGS5, availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
  };
}

