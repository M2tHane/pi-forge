// 验收测试入口：`npm run test:acceptance` 跑全部；`npm run test:acceptance -- T-003` 只跑 tests/acceptance/T-003/。
import { spawnSync } from 'node:child_process';
const task = process.argv[2];
const pattern = task ? `tests/acceptance/${task}/**/*.test.ts` : 'tests/acceptance/**/*.test.ts';
const r = spawnSync(process.execPath, ['--test', pattern], { stdio: 'inherit' });
process.exit(r.status ?? 1);
