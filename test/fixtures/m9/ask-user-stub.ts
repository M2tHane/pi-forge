// 测试用的 ask_user 替身：行为照 @tian.zuo/pi-ask-user 0.2.1 在非 TUI 模式下的实现
// （每个问题一次 ctx.ui.select，选项标签 "N. 标签 — 说明"，末尾追加 "N+1. Other — type your own answer"；
// 真实插件只在 ctx.mode === 'tui' 时才用 ctx.ui.custom()，RPC 模式 hasUI 为 true，走 select / editor）。
import { Type } from 'typebox';

export default function (pi: any) {
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask User',
    description: 'Ask the user one or more multiple-choice questions.',
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String(),
        options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) })),
      })),
    }),
    async execute(_id: string, params: { questions: { question: string; options: { label: string; description?: string }[] }[] }, _signal: unknown, _onUpdate: unknown, ctx: any) {
      if (!ctx.hasUI) return { content: [{ type: 'text', text: 'No interactive UI is available, so the questions could not be shown. Ask the user in plain text instead.' }], details: {} };
      const lines: string[] = [];
      for (const [i, q] of params.questions.entries()) {
        const labels = q.options.map((o, k) => `${k + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
        labels.push(`${q.options.length + 1}. Other — type your own answer`);
        const picked: string | undefined = await ctx.ui.select(`${i + 1}. ${q.question}`, labels);
        lines.push(picked === undefined ? `Question ${i + 1}: dismissed` : `Question ${i + 1}: selected option ${picked}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    },
  });
}
