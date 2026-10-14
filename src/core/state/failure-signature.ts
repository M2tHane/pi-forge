// 来源：pi-flow src/core/verify-runner.ts @ 31f3f15（从 workspace/verify-runner.ts 抽出：state-machine 在最底层也要用）
// 失败签名：同样的失败重复出现时签名相同。
import { createHash } from 'node:crypto';

/** 失败签名：摘要归一化（数字、耗时、十六进制、临时路径）后的短哈希。同样的失败重复出现时签名相同 */
export function failureSignature(summary: string): string {
  const norm = summary
    .replace(/(\/[\w.@+-]+)*\/(tmp|var\/folders|worktrees)\/[\w./@+-]*/g, '<path>')
    .replace(/\br-[0-9a-z]{6,}\b/g, '<run>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hex>')
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/g, '<t>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 12);
}
