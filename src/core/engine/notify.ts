// 来源：pi-flow src/core/notify.ts @ 31f3f15
// 外部通知（第六轮 7.5）：workflow.yaml 的 notify.command（可选）。需要用户处理的新事项、流程完成时运行一次，
// 事件 JSON 从标准输入传入（例如 macOS 的 osascript、发到 webhook 的脚本）。独立进程组、10 秒超时，失败不影响流程。
import { spawn } from 'node:child_process';
import type { FlowConfig } from '../state/config.ts';
import type { StatusSnapshot } from '../ops/status-view.ts';

export interface NotifyEvent { type: 'action' | 'done'; flow: string | null; key: string; text: string; command?: string; at: string }

const NOTIFY_TIMEOUT_MS = 10_000;

/** 两次快照之间新出现的事项与完成的流程 */
export function notifyEvents(prev: StatusSnapshot, next: StatusSnapshot, commands: Record<string, string> = {}, now = new Date()): NotifyEvent[] {
  const at = now.toISOString();
  const out: NotifyEvent[] = [];
  for (const [key, text] of Object.entries(next.actions)) {
    if (key in prev.actions) continue;
    const flow = /^[A-Z]-\d+/.exec(key)?.[0] ?? null;
    out.push({ type: 'action', flow, key, text, ...(commands[key] ? { command: commands[key] } : {}), at });
  }
  for (const [flow, phase] of Object.entries(next.phases)) {
    if (phase === 'done' && prev.phases[flow] && prev.phases[flow] !== 'done') out.push({ type: 'done', flow, key: `${flow}:done`, text: `${flow} 已完成`, at });
  }
  for (const flow of Object.keys(prev.phases)) {
    if (!(flow in next.phases) && prev.phases[flow] !== 'done') out.push({ type: 'done', flow, key: `${flow}:ended`, text: `${flow} 已结束`, at });
  }
  return out;
}

export function runNotify(config: FlowConfig, cwd: string, events: readonly NotifyEvent[]): void {
  const command = config.raw.notify?.command;
  if (!command || !events.length) return;
  for (const e of events) {
    try {
      const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, PI_FORGE_EVENT: e.type, PI_FORGE_TEXT: e.text } });
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(e));
      const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退出 */ } }, NOTIFY_TIMEOUT_MS);
      timer.unref();
      child.on('exit', () => clearTimeout(timer));
      child.unref();
    } catch { /* 通知失败不影响流程 */ }
  }
}
