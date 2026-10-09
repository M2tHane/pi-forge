// 来源：pi-flow src/core/services.ts @ 31f3f15
// 长时间运行的服务（第六轮 D2）：agent 不能用 & 把命令放到后台，要起开发服务器、数据库时用 forge_service。
// 只能启动 workflow.yaml commands 里 serve 或 serve_* 命名的命令；独立进程组运行，日志写到本次运行的临时目录；
// 记录写在临时目录的 services.json，子进程结束、超时、引擎回收运行时按记录结束整个进程组。
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';

export const SERVICE_NAME = /^serve(_[a-z0-9_]+)?$/;
export const SERVICE_READY_MAX_S = 60;
export const SERVICE_MAX = 3;
const LOG_TAIL = 4000;

export interface ServiceRecord { name: string; command: string; pid: number; log: string; started_at: string }

const recordFile = (scratch: string) => path.join(scratch, 'services.json');

export function readServices(scratch: string): ServiceRecord[] {
  try { return JSON.parse(readFileSync(recordFile(scratch), 'utf8')) as ServiceRecord[]; } catch { return []; }
}
function writeServices(scratch: string, list: ServiceRecord[]): void {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(recordFile(scratch), JSON.stringify(list, null, 2));
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** 结束整个进程组（服务派生的子进程一起）；先 SIGTERM，仍在的 SIGKILL */
export function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* 已退出 */ }
  const end = Date.now() + 1500;
  while (alive(pid) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

/** 结束临时目录里记录的全部服务，返回被结束的服务名 */
export function stopAllServices(scratch: string): string[] {
  const list = readServices(scratch);
  for (const s of list) killGroup(s.pid);
  if (list.length && existsSync(scratch)) writeServices(scratch, []);
  return list.map((s) => s.name);
}

export function serviceCommands(commands: Record<string, string>): string[] {
  return Object.keys(commands).filter((n) => SERVICE_NAME.test(n));
}

function tail(file: string): string {
  try {
    const s = readFileSync(file, 'utf8');
    return s.length > LOG_TAIL ? `…${s.slice(-LOG_TAIL)}` : s;
  } catch { return ''; }
}

/** ready：端口号或 http(s)://localhost… 的 URL；不在本机的拒绝 */
export function parseReady(ready: string | number | undefined): { port: number } | { url: string } | null | 'invalid' {
  if (ready === undefined || ready === '') return null;
  if (typeof ready === 'number' || /^\d+$/.test(ready)) {
    const port = Number(ready);
    return port > 0 && port < 65536 ? { port } : 'invalid';
  }
  try {
    const u = new URL(ready);
    return /^https?:$/.test(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? { url: u.toString() } : 'invalid';
  } catch { return 'invalid'; }
}

const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const s = connect({ port, host: '127.0.0.1' });
  const done = (ok: boolean) => { s.destroy(); resolve(ok); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(1000, () => done(false));
});
const urlOk = async (url: string) => {
  try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
};

export interface StartOptions { name: string; command: string; cwd: string; scratch: string; ready?: string | number; timeoutS?: number; env?: NodeJS.ProcessEnv }
export type StartResult = { ok: true; record: ServiceRecord; ready: boolean | null; log: string } | { ok: false; error: string; log: string };

export async function startService(o: StartOptions): Promise<StartResult> {
  const list = readServices(o.scratch).filter((s) => alive(s.pid));
  const running = list.find((s) => s.name === o.name);
  if (running) return { ok: false, error: `服务 ${o.name} 已在运行（pid ${running.pid}）；要重启先 stop`, log: tail(running.log) };
  if (list.length >= SERVICE_MAX) return { ok: false, error: `同时最多运行 ${SERVICE_MAX} 个服务（${list.map((s) => s.name).join('、')}），先 stop 不用的`, log: '' };
  const ready = parseReady(o.ready);
  if (ready === 'invalid') return { ok: false, error: 'ready 只能是本机端口号或 http://localhost… 的地址', log: '' };
  mkdirSync(o.scratch, { recursive: true });
  const log = path.join(o.scratch, `service-${o.name}.log`);
  const fd = openSync(log, 'a');
  const child = spawn('sh', ['-c', o.command], { cwd: o.cwd, detached: true, stdio: ['ignore', fd, fd], env: o.env ?? process.env });
  closeSync(fd);
  child.unref();
  if (!child.pid) return { ok: false, error: '启动失败', log: tail(log) };
  const record: ServiceRecord = { name: o.name, command: o.command, pid: child.pid, log, started_at: new Date().toISOString() };
  writeServices(o.scratch, [...list, record]);
  if (!ready) {
    await new Promise((r) => setTimeout(r, 300));
    if (!alive(record.pid)) return { ok: false, error: '服务启动后立即退出', log: tail(log) };
    return { ok: true, record, ready: null, log: tail(log) };
  }
  const end = Date.now() + Math.min(o.timeoutS ?? SERVICE_READY_MAX_S, SERVICE_READY_MAX_S) * 1000;
  for (;;) {
    if (!alive(record.pid)) {
      writeServices(o.scratch, readServices(o.scratch).filter((s) => s.pid !== record.pid));
      return { ok: false, error: '服务在就绪前退出', log: tail(log) };
    }
    if ('port' in ready ? await portOpen(ready.port) : await urlOk(ready.url)) return { ok: true, record, ready: true, log: tail(log) };
    if (Date.now() >= end) return { ok: true, record, ready: false, log: tail(log) };
    await new Promise((r) => setTimeout(r, 300));
  }
}

export function stopService(scratch: string, name: string): ServiceRecord | null {
  const list = readServices(scratch);
  const s = list.find((x) => x.name === name);
  if (!s) return null;
  killGroup(s.pid);
  writeServices(scratch, list.filter((x) => x !== s));
  return s;
}

export function serviceStatus(scratch: string): (ServiceRecord & { running: boolean })[] {
  return readServices(scratch).map((s) => ({ ...s, running: alive(s.pid) }));
}

export function serviceLog(scratch: string, name: string): string | null {
  const s = readServices(scratch).find((x) => x.name === name);
  return s ? tail(s.log) : null;
}
