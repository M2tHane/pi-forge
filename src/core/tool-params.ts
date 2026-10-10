// 工具参数的预处理（偏离 82）：有的模型（M9 冒烟里的 gpt-6.1-sol）会把没用到的可选参数填成占位值（''、'N/A'、null 等），
// 工具据此误判"传了这个参数"并反复拒绝。校验前把顶层可选参数里的占位值当作没传；必填参数原样保留，交给 schema 校验。
const PLACEHOLDERS = new Set(['', 'n/a', 'na', 'none', 'null', 'undefined', 'nil', '-', '—', '无', '不适用', '没有']);

/** 纯函数：返回去掉占位值后的参数副本；schema 不是对象 schema 或参数不是对象时原样返回 */
export function withoutPlaceholders(schema: unknown, params: unknown): unknown {
  const s = schema as { type?: unknown; properties?: Record<string, unknown>; required?: readonly string[] } | null;
  if (!s || s.type !== 'object' || !s.properties || !params || typeof params !== 'object' || Array.isArray(params)) return params;
  const required = new Set(s.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (!required.has(k) && k in s.properties && (v === null || (typeof v === 'string' && PLACEHOLDERS.has(v.trim().toLowerCase())))) continue;
    out[k] = v;
  }
  return out;
}
