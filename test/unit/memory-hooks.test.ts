import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMemory, NOTES_MESSAGE_TYPE, REMIND_TEXT } from '../../src/pi-adapter/memory.ts';

function mockPi() {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
  const sent: { message: { customType: string; content: string; display: boolean }; options?: { deliverAs?: string } }[] = [];
  return { handlers, sent, pi: {
    on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => { handlers.set(ev, h); return () => {}; },
    sendMessage: (message: { customType: string; content: string; display: boolean }, options?: { deliverAs?: string }) => { sent.push({ message, ...(options ? { options } : {}) }); },
  } };
}
function mockCtx(percent: number | null) {
  const calls: { customInstructions?: string; onComplete?: () => void }[] = [];
  return { calls, ctx: { getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }), compact: (o: { customInstructions?: string; onComplete?: () => void }) => calls.push(o) } };
}

test('memory：笔记只在上下文里还没有最新一份时存进会话（一轮开始时变了、压缩之后），不再每次请求临时接在末尾', async () => {
  const { pi, handlers, sent } = mockPi();
  let notes: string | null = null;
  installMemory(pi as never, { active: () => true, notesMessage: () => notes, compactAt: () => 0.7 });
  assert.equal(handlers.get('context'), undefined, '不改每次请求的消息：只认追加的提示缓存会整段失效');
  const start = handlers.get('before_agent_start')!;
  const { ctx } = mockCtx(10);
  assert.equal(await start({}, ctx), undefined, '没有笔记不放');
  notes = '笔记 v1';
  assert.deepEqual(await start({}, ctx), { message: { customType: NOTES_MESSAGE_TYPE, content: '笔记 v1', display: false } });
  assert.equal(await start({}, ctx), undefined, '没变就不再放');
  // notes 工具的结果里已经是新笔记：下一轮不重复放
  notes = '笔记 v2';
  handlers.get('tool_result')!({ toolName: 'notes', isError: false }, ctx);
  assert.equal(await start({}, ctx), undefined);
  // 笔记在别处变了（例如程序写的）：下一轮开始时放一次
  notes = '笔记 v3';
  assert.equal(((await start({}, ctx)) as { message: { content: string } }).message.content, '笔记 v3');
  // 压缩后立刻存一份进会话
  handlers.get('session_compact')!({}, ctx);
  assert.deepEqual(sent.map((x) => [x.message.customType, x.message.content, x.options?.deliverAs]), [[NOTES_MESSAGE_TYPE, '笔记 v3', 'steer']]);
  assert.equal(await start({}, ctx), undefined);
});

test('memory：回合结束时接近阈值提醒一次、超过阈值才压缩，压缩进行中不重复触发，完成后可再次触发；不生效的上下文不处理', async () => {
  const { pi, handlers, sent } = mockPi();
  let active = true;
  installMemory(pi as never, { active: () => active, notesMessage: () => null, compactAt: () => 0.7 });
  const turnEnd = handlers.get('turn_end')!;
  const low = mockCtx(69);
  turnEnd({}, low.ctx);
  turnEnd({}, low.ctx);
  assert.equal(low.calls.length, 0);
  assert.deepEqual(sent.map((x) => x.message.content), [REMIND_TEXT], '离阈值 10 个百分点以内提醒一次');
  const unknown = mockCtx(null);
  turnEnd({}, unknown.ctx);
  assert.equal(unknown.calls.length, 0, '刚压缩完占用未知时不触发');
  const high = mockCtx(75);
  turnEnd({}, high.ctx);
  turnEnd({}, high.ctx);
  assert.equal(high.calls.length, 1);
  assert.match(high.calls[0]!.customInstructions!, /history/);
  handlers.get('session_compact')!({}, high.ctx);
  turnEnd({}, high.ctx);
  assert.equal(high.calls.length, 2);
  high.calls[1]!.onComplete!();
  active = false;
  turnEnd({}, high.ctx);
  assert.equal(high.calls.length, 2);
});
