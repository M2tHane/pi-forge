// /forge-build 不指定 --prd：扫描项目 docs/ 下用户放的需求文档（偏离第 71 条）。有文档时入库并让主会话只问疑点，没有时详细访谈。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { CONTRACTS } from '../helpers/contracts.ts';
import { DOCS_INPUT_DEST, gitBlobId, pickDocInputs, prepareInputs } from '../../src/core/intake.ts';
import { nextStep } from '../../src/core/context-injector.ts';
import { p0Opening, parseBuildArgs, runFlowBuild, type CommandEnv } from '../../src/commands/forge.ts';

const ROOT = path.join(import.meta.dirname, '../..');
function env(p: Project, talks: string[] = []): CommandEnv {
  const { engine } = makeEngine(p, async () => {});
  return {
    root: p.dir, packageRoot: ROOT, ui: null, engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
    startConversation: (t: string) => { talks.push(t); },
  };
}
function put(p: Project, files: Record<string, string>) {
  for (const [rel, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(p.dir, rel)), { recursive: true });
    writeFileSync(path.join(p.dir, rel), c);
  }
}
async function fresh(files: Record<string, string> = {}) {
  const p = await setupProject({ files });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  return p;
}

test('pickDocInputs：跳过 pi-forge 维护的目录、隐藏文件、敏感文件', () => {
  const r = pickDocInputs(['prd.md', 'ui/首页.png', 'spec/requirements.md', 'contracts/openapi.yaml', 'qa/S1.md', '.DS_Store', 'notes/.secret/a.md', '.env', 'certs/server.pem', 'secrets/token.txt']);
  assert.deepEqual(r.take, ['prd.md', 'ui/首页.png']);
  assert.deepEqual(r.skip, ['docs/certs/server.pem（敏感文件，不入库）', 'docs/secrets/token.txt（敏感文件，不入库）']);
});

test('parseBuildArgs：--prd 可选，位置参数是流程名；未知参数与缺路径仍报错', () => {
  assert.deepEqual(parseBuildArgs([]), {});
  assert.deepEqual(parseBuildArgs(['看板', '系统']), { title: '看板 系统' });
  assert.deepEqual(parseBuildArgs(['--prd', 'a.md']), { prd: 'a.md' });
  assert.throws(() => parseBuildArgs(['--arch', 'x']), /未知参数/);
  assert.throws(() => parseBuildArgs(['--prd']), /缺少路径/);
});

test('p0Opening：有文档时先读、只问疑点；没有文档时详细访谈；feature 模式写增量规格', () => {
  assert.match(p0Opening('build', ['- docs/spec/inputs/docs/prd.md']), /逐份读完[\s\S]*只就这些点[\s\S]*不要再问/);
  assert.match(p0Opening('build', []), /没有提供需求文档[\s\S]*详细地向用户了解/);
  assert.match(p0Opening('feature', []), /feature 模式[\s\S]*feature_name \+ feature/);
});

test('/forge-build（不带参数）：docs/ 下的文档入库到集成分支 docs/spec/inputs/docs/，保持相对路径；主会话只问疑点', async () => {
  const p = await fresh();
  put(p, { 'docs/prd.md': '# 看板 PRD', 'docs/原型/首页.png': 'PNGDATA', 'docs/spec/old.md': '不该入库' });
  const talks: string[] = [];
  try {
    const out = await runFlowBuild('', env(p, talks));
    assert.match(out, /已接收需求文档，共 2 个文件/);
    const flow = p.store.readFlow(p.store.readState().active_flow!);
    assert.equal(flow.intake?.prd, DOCS_INPUT_DEST);
    assert.deepEqual(flow.intake?.files.map((f) => f.path), [`${DOCS_INPUT_DEST}/prd.md`, `${DOCS_INPUT_DEST}/原型/首页.png`]);
    assert.equal(p.git('show', `${flow.integration_branch}:${DOCS_INPUT_DEST}/prd.md`), '# 看板 PRD');
    assert.equal(flow.title, path.basename(p.dir));
    assert.match(talks[0]!, /只就这些点/);
    assert.match(nextStep(p.store, 3).next, /只就有疑问的地方/);
  } finally { p.cleanup(); }
});

test('/forge-build "<名字>"：docs/ 下没有文档时照常建流程，不记 intake，主会话详细访谈', async () => {
  const p = await fresh();
  const talks: string[] = [];
  try {
    const out = await runFlowBuild('"团队看板"', env(p, talks));
    assert.match(out, /没有找到需求文档：主会话会详细地问你需求/);
    const flow = p.store.readFlow(p.store.readState().active_flow!);
    assert.equal(flow.title, '团队看板');
    assert.equal(flow.intake, undefined);
    assert.match(talks[0]!, /没有提供需求文档/);
    assert.match(nextStep(p.store, 3).next, /详细地向用户了解需求/);
  } finally { p.cleanup(); }
});

test('feature 模式：主分支上已经入库过的文档跳过，只收新文档', async () => {
  const contracts = Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [`docs/contracts/${k}`, v]));
  const p = await fresh({ ...contracts, 'docs/spec/inputs/docs/prd.md': '# 旧 PRD', 'docs/prd.md': '# 旧 PRD' });
  put(p, { 'docs/导出功能.md': '# 导出' });
  try {
    const ingested = new Set([gitBlobId(Buffer.from('# 旧 PRD'))]);
    const r = prepareInputs(p.dir, { docs: { ingested } });
    assert.deepEqual(r.files.map((f) => f.path), [`${DOCS_INPUT_DEST}/导出功能.md`]);
    assert.ok(r.skipped?.some((s) => s.includes('docs/prd.md（已在之前的流程入库）')));
    const talks: string[] = [];
    const out = await runFlowBuild('--feature', env(p, talks));
    assert.match(out, /共 1 个文件[\s\S]*已在之前的流程入库/);
  } finally { p.cleanup(); }
});

test('gitBlobId 与 git hash-object 一致', async () => {
  const p = await fresh();
  try {
    put(p, { 'x.txt': '你好\n' });
    assert.equal(gitBlobId(Buffer.from('你好\n')), p.git('hash-object', '--no-filters', 'x.txt'));
  } finally { p.cleanup(); }
});
