// 把一次真实运行（scripts/real-build.ts 的输出目录）整理成工作流示范网站的数据（docs/demo/data.js）。
// 用法：node scripts/demo-site.ts <运行目录> [对照运行目录（原生单会话）] [输出文件，默认 docs/demo/data.js]
// 只读运行目录；不输出会话路径、令牌哈希等与展示无关的字段。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const [runDir, compareDir, outArg] = process.argv.slice(2);
if (!runDir) { console.error('用法：node scripts/demo-site.ts <运行目录> [对照运行目录] [输出文件]'); process.exit(1); }
const out = outArg ?? path.join(import.meta.dirname, '..', 'docs/demo/data.js');
const proj = path.join(runDir, 'project');
const forge = path.join(proj, '.forge');
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const jsonl = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const git = (...args: string[]) => { try { return execFileSync('git', ['-C', proj, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; } };

const summary = readJson(path.join(runDir, 'summary.json'));
const flowId = readdirSync(path.join(forge, 'flows')).find((d) => d.startsWith('B-'))!;
const flowDir = path.join(forge, 'flows', flowId);
const integ = `flow/${flowId}/integration`;

// 规格：REQ 与 AC
const reqText = git('show', `${integ}:docs/spec/requirements.md`);
const reqs: { id: string; title: string; tags: string[]; roles: string; ac: { id: string; text: string; manual: boolean }[] }[] = [];
for (const line of reqText.split('\n')) {
  const h = /^### (REQ-\d+) (.+?)((?: \[[^\]]+\])*)\s*$/.exec(line);
  if (h) { reqs.push({ id: h[1]!, title: h[2]!, tags: [...h[3]!.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!), roles: '', ac: [] }); continue; }
  const cur = reqs.at(-1);
  if (!cur) continue;
  const r = /^角色：(.+)$/.exec(line);
  if (r) cur.roles = r[1]!;
  const a = /^- (AC\d+)(（[^）]*）)?：(.+)$/.exec(line);
  if (a) cur.ac.push({ id: `${cur.id}.${a[1]}`, text: a[3]!, manual: /manual/.test(a[2] ?? '') });
}

const plan = JSON.parse(git('show', `${integ}:docs/plan/plan.yaml`) || '{}');
const tasks = readdirSync(path.join(flowDir, 'tasks')).filter((f) => f.endsWith('.json')).map((f) => {
  const t = readJson(path.join(flowDir, 'tasks', f));
  return {
    id: t.id, kind: t.kind, stage: t.stage, status: t.status, role: t.role, title: t.title, module: t.module, size: t.size,
    attempts: t.attempts ?? 0, violations: t.violations ?? 0, ac: t.ac ?? [], writes: t.writes ?? [], shared: t.shared ?? [],
    produces: t.produces ?? [], requires: t.requires ?? [], depends_on: t.depends_on ?? [], for_task: t.for_task,
    blocked_reason: t.blocked_reason, last_failure: t.last_failure?.slice(0, 1500), base_sha: t.base_sha,
  };
});

const runs = readdirSync(path.join(forge, 'runs')).filter((f) => f.endsWith('.json')).map((f) => {
  const r = readJson(path.join(forge, 'runs', f));
  return { id: r.run_id, task: r.task ?? null, role: r.role, model: r.model, started_at: r.started_at, ended_at: r.ended_at, outcome: r.outcome, cost: r.cost ?? 0, turns: r.turns ?? 0, tokens: r.tokens ?? null, violations: r.violations ?? 0 };
}).sort((a, b) => a.started_at.localeCompare(b.started_at));

const events = jsonl(path.join(forge, 'events.jsonl'))
  .filter((e) => e.type !== 'note' || /合并|预检|阻塞|放行|拒绝|批准|审查|门禁|同步|验收|计划/.test(e.reason ?? ''))
  .map((e) => ({ ts: e.ts, type: e.type, task: e.task, actor: e.actor, from: e.from, to: e.to, trigger: e.trigger, reason: e.reason?.slice(0, 600), data: e.type === 'violation' ? { tool: e.data?.tool, detail: String(e.data?.detail ?? '').slice(0, 200) } : e.type === 'transition' ? { entity: e.data?.entity, stage: e.data?.stage } : e.type === 'merge' ? { files: e.data?.files } : undefined }));

const handoffs: Record<string, string> = {};
for (const f of readdirSync(path.join(flowDir, 'handoff'))) handoffs[f.replace(/\.md$/, '')] = readFileSync(path.join(flowDir, 'handoff', f), 'utf8').slice(0, 6000);

// 产出：已合入的看集成分支上的提交，没合入的看任务分支相对基线的改动
const numstat = (range: string[]) => git('diff', '--numstat', ...range).trim().split('\n').filter(Boolean).map((l) => {
  const [add, del, file] = l.split('\t');
  return { file: file!, add: Number(add) || 0, del: Number(del) || 0 };
});
const commits = git('log', '--format=%H%x09%s', integ).trim().split('\n').map((l) => l.split('\t') as [string, string]);
const outputs: Record<string, { merged: boolean; files: { file: string; add: number; del: number }[]; preview?: { file: string; text: string } }> = {};
for (const t of tasks) {
  if (t.kind !== 'impl' && t.kind !== 'fix' && t.id !== 'T-001') continue;
  const c = commits.find(([, s]) => s.startsWith(`[${flowId}/${t.id}]`));
  const branch = `flow/${flowId}/${t.id}`;
  const files = c ? numstat([`${c[0]}^`, c[0]]) : t.base_sha && git('rev-parse', '--verify', '-q', branch) ? numstat([t.base_sha, branch]) : [];
  if (!files.length) continue;
  const ref = c ? c[0] : branch;
  const main = [...files].filter((f) => /\.(js|ts|html|sql|ya?ml|md)$/.test(f.file) && !/\.gitkeep$/.test(f.file))
    .sort((a, b) => Number(/test|acceptance/.test(a.file)) - Number(/test|acceptance/.test(b.file)) || b.add - a.add)[0];
  outputs[t.id] = { merged: !!c, files, ...(main ? { preview: { file: main.file, text: git('show', `${ref}:${main.file}`).split('\n').slice(0, 80).join('\n') } } : {}) };
}

const interventions = jsonl(path.join(runDir, 'interventions.jsonl')).map((i) => ({ ts: i.ts, category: i.category, note: String(i.note ?? '').slice(0, 1200), answer: String(i.answer ?? '').slice(0, 600) }));
const hidden = existsSync(path.join(runDir, 'hidden-build.json')) ? readJson(path.join(runDir, 'hidden-build.json')).result?.cases ?? [] : [];
const prd = git('show', `${integ}:docs/spec/inputs/prd/requirement.md`);

const brief = (s: { arm: string; run_id: string; agent_min: number; status: string; models: unknown; score?: { base?: { passed: number; total: number } }; usage?: { cost?: number } }) =>
  ({ arm: s.arm, run_id: s.run_id, agent_min: s.agent_min, status: s.status, models: s.models, base: s.score?.base ?? null, cost: s.usage?.cost ?? null });
const compare = compareDir ? brief(readJson(path.join(compareDir, 'summary.json'))) : null;

const data = {
  generated_from: path.basename(runDir),
  summary: { ...brief(summary), started_at: summary.started_at, ended_at: summary.ended_at, thinking: summary.thinking, failure: summary.failure },
  compare,
  prd, reqs, plan, tasks, runs, events, handoffs, outputs, interventions, hidden,
};
// 绝对路径换成占位，不暴露本机目录
const json = JSON.stringify(data).split(path.resolve(runDir)).join('<运行目录>').split(homedir()).join('~');
writeFileSync(out, `// 由 scripts/demo-site.ts 从运行 ${data.generated_from} 生成，不要手改\nwindow.DEMO = ${json};\n`);
console.log(`已写入 ${out}：${reqs.length} 条 REQ、${tasks.length} 个 task、${runs.length} 次运行、${events.length} 条事件、${Object.keys(outputs).length} 份产出`);
