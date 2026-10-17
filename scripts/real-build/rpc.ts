// 以 RPC 模式拉起 pi 的最小客户端（real-build.ts 用）。
// 已核实（Pi 1.1.0 docs/rpc.md、rpc-commands.md、rpc-extension-ui.md、json.md）：
// - 严格 JSONL，只按 LF 切分（不能用 readline：U+2028/2029 会被误切）；stdin 每条命令一行 JSON。
// - prompt 的响应只表示"已接受/已处理"（data.disposition）；一轮模型工作结束看 agent_settled。
// - 扩展命令（/forge-build 等）即使主会话在运行中也立即执行；其输出经 extension_ui_request 的 notify 送达。
// - 对话框（select / input / editor / confirm）发 extension_ui_request，要用同一个 id 回 extension_ui_response。
// - 关闭 stdin 请求有序退出。
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export type RpcRecord = { type: string; [k: string]: unknown };

export interface RpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** rpc.jsonl：每行 {"t","dir","msg"}；message_update（逐字增量）不存，只记个数 */
  logFile: string;
  onRecord: (r: RpcRecord) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class RpcProcess {
  readonly child: ChildProcess;
  stderrTail = '';
  /** 最近一次从 stdout 收到任何记录的时刻 */
  lastRecordAt = Date.now();
  skippedUpdates = 0;
  private nextId = 1;
  private readonly waiting = new Map<string, (r: RpcRecord) => void>();
  private readonly logFile: string;
  private closed = false;

  constructor(opts: RpcOptions) {
    this.logFile = opts.logFile;
    writeFileSync(this.logFile, '');
    this.child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const decoder = new StringDecoder('utf8');
    let buf = '';
    this.child.stdout!.on('data', (chunk: Buffer) => {
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let rec: RpcRecord;
        try { rec = JSON.parse(line) as RpcRecord; } catch { continue; }
        this.lastRecordAt = Date.now();
        this.log('out', rec);
        if (rec.type === 'response' && typeof rec['id'] === 'string' && this.waiting.has(rec['id'])) {
          const done = this.waiting.get(rec['id'])!;
          this.waiting.delete(rec['id']);
          done(rec);
        }
        opts.onRecord(rec);
      }
    });
    this.child.stderr!.setEncoding('utf8').on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-6000); });
    this.child.stdin!.on('error', () => { /* 进程已退出 */ });
    this.child.on('close', (code, signal) => { this.closed = true; for (const w of this.waiting.values()) w({ type: 'response', success: false, error: 'pi 进程已退出' }); this.waiting.clear(); opts.onExit(code, signal); });
  }

  get alive(): boolean { return !this.closed; }

  private log(dir: 'in' | 'out', msg: RpcRecord): void {
    if (dir === 'out' && msg.type === 'message_update') { this.skippedUpdates++; return; }
    try { appendFileSync(this.logFile, `${JSON.stringify({ t: new Date().toISOString(), dir, msg })}\n`); } catch { /* 留档失败不影响运行 */ }
  }

  /** 发一条命令，不等响应 */
  send(cmd: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin!.writable) return;
    this.log('in', cmd as RpcRecord);
    this.child.stdin!.write(`${JSON.stringify(cmd)}\n`);
  }

  /** 发一条命令并等它的响应（按 id 对应）；超时返回 success:false */
  request(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<RpcRecord> {
    const id = `rb-${this.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ type: 'response', success: false, error: `等待响应超时（${timeoutMs} ms）` }); }, timeoutMs);
      this.waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.send({ ...cmd, id });
    });
  }

  respondUi(id: string, response: { value: string } | { cancelled: true } | { confirmed: boolean }): void {
    this.send({ type: 'extension_ui_response', id, ...response });
  }

  /** 关闭 stdin 请求有序退出；超时后 SIGTERM 整个进程组，再超时 SIGKILL */
  async stop(graceMs = 8000): Promise<void> {
    if (this.closed) return;
    try { this.child.stdin!.end(); } catch { /* 忽略 */ }
    const exited = new Promise<void>((r) => this.child.once('close', () => r()));
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    await Promise.race([exited, wait(graceMs)]);
    if (this.closed) return;
    this.signal('SIGTERM');
    await Promise.race([exited, wait(5000)]);
    if (!this.closed) this.signal('SIGKILL');
  }

  signal(sig: NodeJS.Signals): void {
    try { process.kill(-this.child.pid!, sig); } catch { try { this.child.kill(sig); } catch { /* 已退出 */ } }
  }
}
