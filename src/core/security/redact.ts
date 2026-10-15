// 敏感内容打码（第六轮 D4）：guard 拦下读敏感文件，但密钥也可能出现在命令输出、日志、配置示例里。
// 工具结果进入模型上下文之前按常见密钥形态打码；主会话与子进程都装。
export const REDACTED = '[已打码]';

const PATTERNS: { name: string; re: RegExp; keep?: (m: string, ...g: string[]) => string }[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { name: 'openai-like', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // KEY=value 形式的赋值（.env、导出的环境变量）：名字含 SECRET、TOKEN、PASSWORD 等，值像真实密钥（不是变量引用、占位符）
  {
    name: 'env-assignment',
    re: /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|AUTH_KEY)[A-Z0-9_]*\s*[=:]\s*)(["']?)([^\s"'$<{][^\s"']{7,})\2/gm,
    keep: (_m, prefix = '', quote = '') => `${prefix}${quote}${REDACTED}${quote}`,
  },
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m: string, ...g: unknown[]) => {
      count++;
      return p.keep ? p.keep(m, ...(g.filter((x) => typeof x === 'string') as string[])) : REDACTED;
    });
  }
  return { text: out, count };
}

/** 递归打码对象里的所有字符串（structuredContent）；没有改动时返回原对象 */
export function redactDeep(value: unknown): { value: unknown; count: number } {
  if (typeof value === 'string') { const r = redactSecrets(value); return { value: r.text, count: r.count }; }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((v) => { const r = redactDeep(v); count += r.count; return r.value; });
    return count ? { value: out, count } : { value, count: 0 };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) { const r = redactDeep(v); count += r.count; out[k] = r.value; }
    return count ? { value: out, count } : { value, count: 0 };
  }
  return { value, count: 0 };
}
