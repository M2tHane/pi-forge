// 套件：pi-forge 自身（约 1.9 万行 TypeScript），复制当前工作树（不含 node_modules、.git、legacy），
// 叠加 pi-forge-suite/ 里的规格、架构说明与验收测试入口。6 个 S1 task，带 ★ 的是故意的极端情况。
import { cpSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { TaskInput } from '../../../src/core/state/state-store.ts';
import type { Suite } from './types.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const OVERLAY = path.join(import.meta.dirname, '../pi-forge-suite');
const STAGE = 'S1';
const SKIP = new Set(['node_modules', '.git', 'legacy', '.forge', '.pi']);

const base = (id: string, title: string, module: string, writes: string[], ac: string[], extra: Partial<TaskInput> = {}): TaskInput => ({
  id, stage: STAGE, kind: 'impl', role: 'worker', title, scopes: ['code'], depends_on: [], inputs: [],
  writes: [...writes, `tests/acceptance/${id}/**`], verify: ['test'], module, size: 'M', ac, ...extra,
});

const ENTRY = '验收测试入口：直接 import 下面列出的导出函数（tests/acceptance/<task>/*.test.ts，node:test），不开进程、不读 .forge/。';

export const piForge: Suite = {
  name: 'pi-forge',
  project: 'pi-forge',
  title: 'pi-forge 自身改进（真实模型实验，约 1.9 万行）',
  stageGoal: '度量、计划报告、规格检查、脱敏、guard 与状态视图的六项改进',
  commands: { install: 'npm ci', typecheck: 'npm run typecheck', test: 'npm run test:fast', acceptance: 'npm run test:acceptance' },
  runMinutes: 25,
  prepare: (dir) => {
    cpSync(ROOT, dir, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) || path.dirname(src) !== ROOT });
    cpSync(OVERLAY, dir, { recursive: true });
    const pkgPath = path.join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts['test:acceptance'] = 'node tests/run-acceptance.mjs';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    appendFileSync(path.join(dir, 'rules/global.md'), readFileSync(path.join(import.meta.dirname, 'pi-forge-rules-append.md'), 'utf8'));
  },
  tasks: [
    { task: base('T-001', '度量里的并行度', 'stage', ['src/core/stage/signoff.ts', 'src/core/ops/status-detail.ts', 'test/unit/signoff.test.ts', 'test/unit/__snapshots__/status/**'], ['REQ-001.AC1', 'REQ-001.AC2', 'REQ-001.AC3']),
      brief: `正常任务：/forge-status --metrics 的「速度」段新增并行度一行。并行度由 .forge/runs 里每个 run 的 started_at/ended_at 计算（纯函数放 src/core/stage/signoff.ts，renderMetrics 输出）。${ENTRY}入口：signoff.ts 新导出的纯函数与 renderMetrics。测试怎么搭：RunFile 对象直接手写（只需 started_at/ended_at），参考 test/unit/signoff.test.ts 里 computeMetrics 的用法。注意 test/unit/status-snapshots.test.ts 的快照（UPDATE_SNAPSHOTS=1 重新生成，diff 要看过）。` },
    { task: base('T-002', '计划报告的层级', 'plan', ['src/core/state/dag.ts', 'src/core/plan/plan.ts', 'test/unit/dag.test.ts', 'test/unit/plan.test.ts'], ['REQ-002.AC1', 'REQ-002.AC2', 'REQ-002.AC3']),
      brief: `正常任务：dag.ts 新增纯函数算每个 task 的层级（level），formatPlanReport 输出「层级」一行。${ENTRY}入口：dag.ts 的层级函数与 plan.ts 的 formatPlanReport。测试怎么搭：task 用 test/helpers/tasks.ts 的 mkTask/hard/soft 构造，参考 test/unit/dag.test.ts。` },
    // ★ 改 spec 检查：项目里的 e2e 夹具规格很多，只能跑 test:fast；看它是否把新检查做成提醒而不是错误
    { task: base('T-003', '规格检查：术语别名提醒', 'spec', ['src/core/spec/spec.ts', 'test/unit/spec.test.ts'], ['REQ-003.AC1', 'REQ-003.AC2', 'REQ-003.AC3']),
      brief: `极端：spec.ts 已解析术语表的「不要叫」别名（aliases）但没有用它；新增检查：需求标题或 AC 文本用了别名就给 warnings 加一条 glossary-alias 提醒。只能是 warnings，不能进 errors（否则 test/e2e 的大量夹具会过不了，而你只能跑 test:fast）。lintSpec 返回 { errors, warnings }。${ENTRY}入口：lintSpec。测试怎么搭：四个 markdown 字符串直接传给 lintSpec，参考 test/unit/spec.test.ts。` },
    { task: base('T-004', '脱敏 Bearer 令牌', 'security', ['src/core/security/redact.ts', 'test/unit/redact.test.ts'], ['REQ-004.AC1', 'REQ-004.AC2']),
      brief: `正常任务：redactSecrets 新增 Bearer 令牌脱敏；已有规则不能变。${ENTRY}入口：redactSecrets。测试怎么搭：纯字符串进出，参考 test/unit/redact.test.ts。` },
    // ★ 改 guard（安全层，30 个测试、路径区域判定复杂）：curl -o 写进工作区内文件放行
    { task: base('T-005', 'guard：curl 可写工作区内文件', 'security', ['src/core/security/guard.ts', 'test/unit/guard.test.ts'], ['REQ-005.AC1', 'REQ-005.AC2', 'REQ-005.AC3'], { size: 'L' }),
      brief: `极端：目前 curl 的 -o/--output 一律拦下；改成目标在当前任务 worktree 或临时目录内就放行，其余照旧拦下。guard.ts 里已有路径区域判定（areaOf 之类）与 localCurlDenied，先读懂再改；test/unit/guard.test.ts 的 ctx() 能构造 worker 上下文。${ENTRY}入口：checkToolCall。测试怎么搭：用 test/unit/guard.test.ts 顶部的 ctx()/bash()/allowed()/blocked() 这套 helper（可以复制到验收测试里）。` },
    // ★ 快照测试 + 依赖 T-001（两者都改状态视图输出，先合 T-001 避免快照冲突）
    { task: base('T-006', '状态视图的进度条', 'ops', ['src/core/ops/status-view.ts', 'test/unit/status-view.test.ts', 'test/unit/__snapshots__/status/**'], ['REQ-006.AC1', 'REQ-006.AC2'], { depends_on: [{ task: 'T-001', type: 'hard' }] }),
      brief: `极端：/forge-status 的进度行加 10 格文本进度条。快照测试 test/unit/status-snapshots.test.ts 会失败，用 UPDATE_SNAPSHOTS=1 重新生成并核对 diff 只有进度条。硬依赖 T-001（它也改快照）。${ENTRY}入口：renderStatus / renderFlow。测试怎么搭：test/helpers/project.ts 的 setupProject({ tasks }) 建临时项目与 store，mkTask 造任务，参考 test/unit/status-view.test.ts 与 test/unit/signoff.test.ts 里 renderStatus 的用法；不要自己从 StateStore.init 搭。` },
  ],
};
