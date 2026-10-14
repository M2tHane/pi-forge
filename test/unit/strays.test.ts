// 残留进程清理：按工作目录找进程；keepGroups 里的进程组不算残留
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { processesIn } from '../../src/core/workspace/strays.ts';

test('processesIn 找到工作目录在给定目录里的进程；keepGroups 排除整个进程组', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'strays-'));
  const child = spawn('sleep', ['30'], { cwd: dir, detached: true, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const pid = child.pid!;
    assert.ok(processesIn([dir]).includes(pid), '应找到 cwd 在目录里的进程');
    assert.ok(!processesIn([dir], { keepGroups: [pid] }).includes(pid), 'keepGroups 里的进程组不算残留');
    assert.ok(!processesIn([path.join(dir, 'other')]).includes(pid), '不存在的目录不匹配');
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退出 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keepGroups 也保留后代进程：pi 的 bash 工具把测试放进新的进程组，祖先链上有活跃 run 就不算残留', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'strays-'));
  // 外层 node（模拟 pi 进程）再以 detached 启动 sleep（模拟 bash 工具起的新进程组），并把内层 pid 打到 stdout
  const child = spawn(process.execPath, ['-e', "const c=require('node:child_process').spawn('sleep',['30'],{detached:true,stdio:'ignore'}); process.stdout.write(String(c.pid)+'\\n'); setTimeout(()=>{}, 40000)"], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const inner = Number(await new Promise<string>((resolve) => { let buf = ''; child.stdout.on('data', (c: Buffer) => { buf += c; if (buf.includes('\n')) resolve(buf.trim()); }); }));
    const pid = child.pid!;
    const all = processesIn([dir]);
    assert.ok(all.includes(pid) && all.includes(inner), `应找到外层 ${pid} 与内层 ${inner}：${all.join(',')}`);
    assert.deepEqual(processesIn([dir], { keepGroups: [pid] }), [], '外层 pid 在 keepGroups 里时，它的后代也不算残留');
  } finally {
    for (const p of processesIn([dir])) { try { process.kill(p, 'SIGKILL'); } catch { /* 已退出 */ } }
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退出 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
