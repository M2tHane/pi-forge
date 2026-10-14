// 测试分组：按文件内容把单元测试分成"纯函数（快）"与"用到 git / 临时目录（慢）"两组，避免手工维护清单。
// 用法：node scripts/test-groups.ts fast|slow|unit|e2e [--list] [<测试文件>...]
//       给了测试文件就只跑这些文件（审查者按 task 改动的文件运行：npm run test:fast test/unit/x.test.ts）。
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SLOW = /mkdtemp|setupProject|tmpdir|initRepo|\bgit\(/;
const unitDir = path.join(process.cwd(), 'test', 'unit');
const e2eDir = path.join(process.cwd(), 'test', 'e2e');
const list = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort().map((f) => path.join(dir, f));
const isSlow = (f: string) => SLOW.test(readFileSync(f, 'utf8'));

const group = process.argv[2] ?? 'fast';
const files = group === 'fast' ? list(unitDir).filter((f) => !isSlow(f))
  : group === 'slow' ? list(unitDir).filter(isSlow)
    : group === 'unit' ? list(unitDir)
      : group === 'e2e' ? list(e2eDir) : null;
if (!files) { console.error('用法：node scripts/test-groups.ts fast|slow|unit|e2e [--list]'); process.exit(2); }
const picked = process.argv.slice(3).filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
const rel = (picked.length ? picked : files).map((f) => path.relative(process.cwd(), f));
if (process.argv.includes('--list')) { console.log(rel.join('\n')); process.exit(0); }
const extra = group === 'e2e' ? ['--test-concurrency=2'] : [];
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...extra, ...rel], { stdio: 'inherit' });
process.exit(r.status ?? 1);
