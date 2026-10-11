// e2e 共用：命令层的 CommandEnv、带命令环境的引擎、fake agent 的常用动作、反复 next 直到没有新的派发。
import assert from 'node:assert/strict';
import type { CommandEnv } from '../../src/commands/forge.ts';
import type { MergeHooks } from '../../src/core/verify/merge-queue.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { ALL_FAKE, makeEngine, type RoleScript } from './engine.ts';
import { formatStalls, stalls } from '../../src/core/state/waits.ts';
import type { Project } from './project.ts';

export const PACKAGE_ROOT = new URL('../..', import.meta.url).pathname;

/** 无界面、等引擎空闲的命令环境 */
export function commandEnv(p: Project, engine: ReturnType<typeof makeEngine>['engine'], over: Partial<CommandEnv> = {}): CommandEnv {
  return {
    root: p.dir, packageRoot: PACKAGE_ROOT, ui: null,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
    ...over,
  };
}

/** makeEngine 加上对应的命令环境 */
export function engineEnv(p: Project, scripts: RoleScript, hooks?: MergeHooks) {
  const m = makeEngine(p, scripts, ALL_FAKE, hooks);
  return { ...m, cmd: commandEnv(p, m.engine) };
}

/** 写文件（每个都要成功） */
export async function writeFiles(a: FakeAgent, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) assert.ok((await a.call('write', { path: rel, content })).ok, rel);
}

/** 写文件、写 handoff、提交（提交必须成功） */
export async function submitWork(a: FakeAgent, note: string, files: Record<string, string> = {}): Promise<void> {
  await writeFiles(a, files);
  await a.call('forge_note', { text: note });
  const r = await a.call('forge_submit', { summary: note });
  assert.ok(r.ok, r.text);
}

/** 测试配置关闭了自动派发：反复 next 直到没有新的派发 */
export async function drive(e: ReturnType<typeof makeEngine>, flowId: string, rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const before = e.launcher.launched.length;
    await e.engine.next(flowId);
    await e.engine.idle();
    // 停滞（互相等待、等到 blocked / cancelled）立即失败，不等超时
    const stalled = stalls(e.store.listTasks(flowId));
    if (stalled.length) throw new Error(`drive 第 ${i + 1} 轮后出现停滞：${formatStalls(stalled)}`);
    if (e.launcher.launched.length === before && i > 2) break;
  }
}
