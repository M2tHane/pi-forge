// 把一个项目的 .forge/ 状态生成一个可交互的 HTML（自包含，不联网）：
// 阶段（P0、P1、S0…Sn）与任务 DAG（按角色着色，派生任务挨着原任务）、任务状态机与转移次数、§17 度量、变更与规格修订、运行时间线、成本、事件日志、原始状态。
//   npm run view -- <项目目录> [--out <文件>]
//   node scripts/forge-view.ts <项目目录> [--out <文件>]
// 默认输出到 <项目目录>.forge-view.html（项目目录之外，不污染工作区）。只读，不修改 .forge/；内嵌的自由文本都经过打码。
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '../src/core/state/state-store.ts';
import { buildViewData, renderViewHtml } from './forge-view-data.ts';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const dir = path.resolve(argv.find((a, i) => !a.startsWith('--') && i !== outIdx + 1) ?? '.');
const out = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]!) : `${dir.replace(/\/$/, '')}.forge-view.html`;
if (!existsSync(path.join(dir, '.forge', 'state.json'))) { console.error(`${dir} 不是 pi-forge 项目（缺少 .forge/state.json）`); process.exit(1); }

writeFileSync(out, renderViewHtml(buildViewData(new StateStore(dir), dir)));
console.log(`已生成：${out}`);
