// 从失败输出里找出仓库里的文件（门禁生成修复任务时用）。纯函数。
// 文件名沿用 scope-hint：原先的"范围申请提示"随 worker 写入范围放开一并删除。

// 来自 stage/gates.ts：workspace 在 stage 之下，不能反过来 import 它。
/** 从失败输出中找出仓库里的文件（测试文件、报错位置） */
export function failingFiles(output: string, tracked: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/[\w@.\-/]+\.[A-Za-z0-9]+/g)) {
    let p = m[0].replace(/^\.\//, '');
    if (!tracked.has(p)) {
      const parts = p.split('/');
      p = parts.map((_, i) => parts.slice(i).join('/')).find((x) => tracked.has(x)) ?? '';
    }
    if (p) out.add(p);
  }
  return [...out].slice(0, 20);
}
