// 消融结果的汇总：node scripts/ablation/analyze.ts [<结果目录>]
// 1. 每一臂相对基线新增的失败用例（扣除同一批里基线也失败的，即负载引起的偶发失败）；
// 2. 观测臂的命令记录：同一测试场景里、同一棵树上已经成功跑过的同名命令再次运行的次数，按预检、合并、门禁分开。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ArmResult } from './run.ts';

const dir = path.resolve(process.argv[2] ?? '/tmp/forge-ablation');
const results: ArmResult[] = JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const key = (f: { suite: string; file: string; name: string }) => `${f.suite}:${f.file} › ${f.name}`;
const baseline = new Set((results.find((r) => r.id === 'baseline')?.failures ?? []).map(key));

console.log(`# 消融结果（${results[0]?.commit.slice(0, 7) ?? '?'}）\n`);
console.log(`基线失败 ${baseline.size} 个${baseline.size ? `：${[...baseline].join('；')}` : ''}\n`);
console.log('| 臂 | 类型 | 通过 | 失败 | 相对基线新增的失败 | 分钟 |\n|---|---|---|---|---|---|');
for (const r of results) {
  const extra = r.failures.filter((f) => !baseline.has(key(f)));
  console.log(`| ${r.id} | ${r.kind} | ${r.pass} | ${r.fail} | ${r.error ? `错误：${r.error}` : extra.length ? extra.length : 0} | ${r.minutes} |`);
}
for (const r of results) {
  const extra = r.failures.filter((f) => !baseline.has(key(f)));
  if (!extra.length) continue;
  console.log(`\n## ${r.id}（${r.mechanism}）\n假设：${r.hypothesis}\n`);
  for (const f of extra) console.log(`- ${key(f)}`);
}

interface Row { file: string; tag: string; tree: string; cmd: string; exit: number }
const phase = (tag: string) => tag.startsWith('pc-') ? 'precheck' : tag.startsWith('merge-') ? 'merge' : tag.startsWith('gate-') ? 'gate' : 'other';
for (const arm of ['probe', 'proposal-skip-same-tree']) {
  const f = path.join(dir, `${arm}.probe.tsv`);
  if (!existsSync(f)) continue;
  const rows: Row[] = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [file, tag, tree, cmd, exit] = l.split('\t');
    return { file: path.basename(file ?? '?'), tag: tag ?? '', tree: tree ?? '?', cmd: cmd ?? '', exit: Number(exit) };
  }).filter((r) => phase(r.tag) !== 'other' && !r.tree.endsWith('+dirty') && r.tree !== '?');
  const ran = new Map<string, number>();
  const byPhase = new Map<string, { runs: number; redundant: number }>();
  const byFile = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.file}\t${r.tree}\t${r.cmd}`;
    const p = byPhase.get(phase(r.tag)) ?? { runs: 0, redundant: 0 };
    p.runs++;
    if ((ran.get(k) ?? 0) > 0) { p.redundant++; byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1); }
    if (r.exit === 0) ran.set(k, (ran.get(k) ?? 0) + 1);
    byPhase.set(phase(r.tag), p);
  }
  console.log(`\n## 命令记录：${arm}（${rows.length} 次预检、合并、门禁命令）\n`);
  console.log('| 阶段 | 运行次数 | 同一棵树上已成功跑过的同名命令 |\n|---|---|---|');
  for (const [p, v] of byPhase) console.log(`| ${p} | ${v.runs} | ${v.redundant}（${Math.round((v.redundant / v.runs) * 100)}%） |`);
  const total = [...byPhase.values()].reduce((a, v) => ({ runs: a.runs + v.runs, redundant: a.redundant + v.redundant }), { runs: 0, redundant: 0 });
  console.log(`| 合计 | ${total.runs} | ${total.redundant}（${Math.round((total.redundant / Math.max(1, total.runs)) * 100)}%） |`);
}
