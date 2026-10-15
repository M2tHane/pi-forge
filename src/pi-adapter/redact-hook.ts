// tool_result 打码（第六轮 D4）：同时替换 content 与 structuredContent（Pi 1.0.0 文档：只替换 content 会丢掉 structuredContent）。
import type { ToolResultEvent, ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import { redactDeep, redactSecrets } from '../core/security/redact.ts';

/** 没有要打码的内容时返回 null */
export function redactToolResult(event: Pick<ToolResultEvent, 'content' | 'structuredContent'>): (Required<Pick<ToolResultEventResult, 'content'>> & ToolResultEventResult & { count: number }) | null {
  let count = 0;
  const content = event.content.map((c) => {
    if (c.type !== 'text') return c;
    const r = redactSecrets(c.text);
    count += r.count;
    return r.count ? { ...c, text: r.text } : c;
  });
  const sc = redactDeep(event.structuredContent);
  count += sc.count;
  if (!count) return null;
  return { content, ...(event.structuredContent !== undefined ? { structuredContent: sc.value } : {}), count };
}
