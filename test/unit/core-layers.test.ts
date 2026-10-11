// src/core 目录分层检查：下层不得 import 上层，目录依赖图无环。
// 新增文件违反分层会直接失败；新增目录必须先登记到 LAYERS。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const CORE = resolve(import.meta.dirname, "../../src/core");

// 目录 -> 层号（数字越小越靠下；下层不得 import 上层）
const LAYERS: Record<string, number> = {
  state: 1, // schemas、config、paths、git、状态仓库与状态机、纯函数工具
  security: 2, // guard、shell、redact、工具参数
  workspace: 2, // worktree、依赖准备、命令运行、资源分配、服务、只读 forge_read
  verify: 3, // 验证缓存、测试调整
  insight: 3, // 成本、预算、角色模型、停滞检测
  spec: 4, // 规格与 intake、预检
  acceptance: 5, // 验收测试流程、覆盖率、阶段修复
  plan: 6, // 契约、计划、变更请求、纳管、规格修订批准
  stage: 7, // 阶段流程、闸门、审查、签收、合入
  engine: 8, // 调度、子进程、合并队列、预检、知识与笔记
  ops: 9, // 斜杠命令与状态展示：init、doctor、resume、status-view 等
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']*)["']/g;

function topDir(file: string): string {
  return relative(CORE, file).split(sep)[0]!;
}

/** 解析 src/core 内所有相对 import，返回 [来源文件, 目标文件] */
function edges(): Array<[string, string]> {
  const res: Array<[string, string]> = [];
  for (const file of walk(CORE)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolve(dirname(file), m[1]!.replace(/\.js$/, ".ts"));
      if (target.startsWith(CORE + sep)) res.push([file, target]);
    }
  }
  return res;
}

test("src/core 每个目录都登记了层号", () => {
  for (const n of readdirSync(CORE).filter((x) => !x.startsWith("."))) { // 忽略 .DS_Store 等系统文件
    assert.ok(statSync(join(CORE, n)).isDirectory(), `src/core 根下不应有文件：${n}`);
    assert.ok(n in LAYERS, `目录 ${n} 未登记到 LAYERS`);
  }
});

test("下层目录不得 import 上层目录", () => {
  const bad: string[] = [];
  for (const [from, to] of edges()) {
    const a = topDir(from);
    const b = topDir(to);
    if (a === b) continue;
    if (LAYERS[b]! > LAYERS[a]!) {
      bad.push(`${relative(CORE, from)} (层${LAYERS[a]}) -> ${relative(CORE, to)} (层${LAYERS[b]})`);
    }
  }
  assert.deepEqual(bad, [], `向上依赖：\n${bad.join("\n")}`);
});

test("目录依赖图无环（含同层目录之间）", () => {
  const graph = new Map<string, Set<string>>();
  for (const [from, to] of edges()) {
    const a = topDir(from);
    const b = topDir(to);
    if (a === b) continue;
    if (!graph.has(a)) graph.set(a, new Set());
    graph.get(a)!.add(b);
  }
  const mark = new Map<string, number>();
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const visit = (n: string): void => {
    if (cycle) return;
    mark.set(n, 1);
    stack.push(n);
    for (const m of graph.get(n) ?? []) {
      if (mark.get(m) === 1) {
        cycle = [...stack.slice(stack.indexOf(m)), m];
        return;
      }
      if (!mark.has(m)) visit(m);
    }
    stack.pop();
    mark.set(n, 2);
  };
  for (const n of graph.keys()) if (!mark.has(n)) visit(n);
  assert.equal(cycle, null, `目录依赖成环：${cycle === null ? "" : (cycle as string[]).join(" -> ")}`);
});
