// 结构化笔记放回上下文与按阈值压缩（第五轮），子进程扩展与主会话扩展共用。
// 已核实（Pi 1.1 dist/core/extensions/types.d.ts、runner.js）：before_agent_start 可返回一条存进会话的消息（多个处理函数的消息都会追加）；
// sendMessage 的 deliverAs steer 在运行中把消息存进会话；ctx.getContextUsage() 给出占比；ctx.compact() 触发压缩但不等待；
// session_compact / session_compact_failed 报告结果。
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export const NOTES_MESSAGE_TYPE = 'pi-forge-notes';
/** 离压缩阈值还差这么多个百分点时提醒先更新笔记 */
export const REMIND_MARGIN = 10;
export const REMIND_TEXT = '[提醒] 上下文接近压缩阈值。先用 notes update 记下当前进度（done、todo、current），压缩后只保留笔记与最近的对话；之前的细节可以用 history 检索。';

export interface MemoryHooks {
  /** 是否作用于这个上下文（主会话只在已初始化的项目中生效） */
  active(ctx: ExtensionContext): boolean;
  /** 放回上下文的笔记消息；null 表示不放 */
  notesMessage(ctx: ExtensionContext): string | null;
  /** 触发压缩的上下文占比（0–1） */
  compactAt(ctx: ExtensionContext): number;
}

const percentOf = (ctx: ExtensionContext): number | null => {
  try { return ctx.getContextUsage()?.percent ?? null; } catch { return null; }
};

/**
 * 笔记只在上下文里还没有最新一份时存进会话：一轮开始时笔记变了、压缩之后。
 * 原来每次请求都把笔记临时接在末尾，请求就不再是上一次请求的追加；只认追加的提示缓存（magpie 转发的 gpt）从第一次写笔记起不再增长，
 * stock run-02 主会话每次请求约 9 万 token 只命中 9344（缓存命中约 9%）。notes 工具的结果本身带着完整笔记，更新后不用再放。
 */
export function installMemory(pi: ExtensionAPI, hooks: MemoryHooks): void {
  let compacting = false;
  /** 上下文里已有的笔记文本（放进去的消息或 notes 工具的结果）；压缩后清空 */
  let shown: string | null = null;
  let reminded = false;
  const current = (ctx: ExtensionContext): string | null => { try { return hooks.notesMessage(ctx); } catch { return null; } };
  const message = (content: string) => ({ customType: NOTES_MESSAGE_TYPE, content, display: false });

  pi.on('before_agent_start', (_e, ctx) => {
    if (!hooks.active(ctx)) return;
    const text = current(ctx);
    if (!text || text === shown) return;
    shown = text;
    return { message: message(text) };
  });

  // notes 工具更新后结果里就是新笔记
  pi.on('tool_result', (e, ctx) => {
    if (e.toolName === 'notes' && !e.isError && hooks.active(ctx)) shown = current(ctx);
  });

  // 回合结束时检查上下文占用：接近阈值提醒一次，超过阈值就压缩（Pi 自己的阈值是窗口减去 reserveTokens，通常更晚）
  pi.on('turn_end', (_e, ctx) => {
    if (compacting || !hooks.active(ctx)) return;
    const pct = percentOf(ctx);
    if (pct === null) return;
    const limit = hooks.compactAt(ctx) * 100;
    if (pct < limit) {
      if (!reminded && pct >= limit - REMIND_MARGIN) { reminded = true; pi.sendMessage(message(REMIND_TEXT), { deliverAs: 'steer' }); }
      return;
    }
    compacting = true;
    ctx.compact({
      customInstructions: '摘要只需保留最近的工作脉络；目标、已完成、待完成、决策与踩过的坑已在笔记中，压缩后会原样放回上下文，之前的细节可以用 history 检索。',
      onComplete: () => { compacting = false; },
      onError: () => { compacting = false; },
    });
  });
  pi.on('session_compact', (_e, ctx) => {
    compacting = false;
    reminded = false;
    shown = null;
    if (!hooks.active(ctx)) return;
    const text = current(ctx);
    if (!text) return;
    shown = text;
    pi.sendMessage(message(text), { deliverAs: 'steer' });
  });
  pi.on('session_compact_failed', () => { compacting = false; });
}
