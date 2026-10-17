// codegraph CLI 封装（colbymchenry/codegraph 1.6.0 已核实：sync -q）。
// 只在主工作区使用（索引在 <root>/.codegraph）。第五轮起合并时一律跑全量测试，不再用 affected 选测试。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BIN = () => process.env['PI_FORGE_CODEGRAPH_BIN'] ?? 'codegraph';

function run(args: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(BIN(), args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const code = (err as { code?: unknown } | null)?.code;
      resolve({ code: err ? (typeof code === 'number' ? code : 1) : 0, stdout: String(stdout), missing: code === 'ENOENT' });
    });
  });
}

export const codegraphIndexed = (root: string) => existsSync(path.join(root, '.codegraph'));

/** 合并后同步索引；失败忽略 */
export async function codegraphSync(root: string): Promise<void> {
  if (!codegraphIndexed(root)) return;
  await run(['sync', '-q', root], root);
}

/** /forge init 时建立索引（codegraph 1.6.2 已核实：init -y 非交互，初始化并建索引）；失败不报错，返回一行结果 */
export async function codegraphInit(root: string): Promise<string> {
  const r = await run(['init', '-y', root], root, 10 * 60_000);
  if (r.missing) return '代码索引：没有找到 codegraph，跳过；安装后执行 codegraph init -y';
  if (r.code !== 0) return `代码索引：codegraph init 失败（退出码 ${r.code}），跳过；可稍后执行 codegraph init -y`;
  return '代码索引：已建立（.codegraph/）';
}
