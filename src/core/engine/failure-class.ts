// 运行失败分类：子进程没有提交就结束时，按错误信息确定性地分出类别，决定恢复动作，不调用模型。
// 超时（run_timeout）、guard 违规满额、运行中原地打转（subagent-runtime）各有自己的路径，不经过这里。
import type { FailureKind } from '../state/schemas.ts';
import { classifyUnavailable, type Unavailable } from './model-pause.ts';

/**
 * pause_model：暂停这个模型，不计任务失败（额度、限流、配置错误）；
 * hand_to_user：转 blocked 等用户，不重试（运行环境的问题，重试结果一样）；
 * retry：计一次失败后重新派发（同样的失败两次升级模型，仍一样交给用户）。
 */
export type Recovery = 'pause_model' | 'hand_to_user' | 'retry';

export interface FailureClass {
  kind: FailureKind;
  recovery: Recovery;
  /** 失败原因（给 last_failure 与事件）；retry 时带上给下一次运行的提示 */
  reason: string;
  /** recovery 为 pause_model 时的暂停依据 */
  pause?: Unavailable;
}

export interface RunEnd {
  /** 最后一条 assistant 的 errorMessage */
  error?: string | null;
  stderrTail?: string;
  exitCode: number | null;
}

/** API key、模型名、权限：改配置之前每次都一样。只认 Pi 与提供方的报错原文 */
const CONFIG = /No API key (?:found )?for|Model "[^"]*" not found\. Use --list-models|No models match pattern|invalid[_ ]?api[_ ]?key|incorrect api key|authentication[_ ]?(?:error|failed)|unauthori[sz]ed|model[_ ]not[_ ]found|does not exist or you do not have access/i;
/** HTTP 401、403 只在模型返回的错误信息里认 */
const CONFIG_STATUS = /\b(?:401|403)\b/;
/** 上下文超限（Pi 自动压缩后仍放不下）；取自 pi-ai utils/overflow.ts 的常见写法 */
const OVERFLOW = /prompt (?:is )?too long|request_too_large|exceeds the context window|maximum context length|context[_ ]length[_ ]exceeded|context window exceeds limit|exceeded model token limit|input token count.*exceeds the maximum/i;
/** 磁盘满、文件句柄用尽、pi 或插件加载失败：与任务无关，重试也一样 */
const ENVIRONMENT = /ENOSPC|no space left on device|EMFILE|too many open files|ERR_MODULE_NOT_FOUND|Cannot find module|spawn \S+ ENOENT/i;

const clip = (s: string, n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** 分类一次没有提交就结束的 run（纯函数） */
export function classifyRunFailure(r: RunEnd): FailureClass {
  const err = r.error && r.error !== 'aborted' ? r.error : '';
  // stderr 只认具体的报错写法：正常退出时也看（prompt 被拒绝时退出码为 0），启动失败时退出码为 null
  const stderr = (r.stderrTail ?? '').slice(-2000);
  const text = `${err}\n${stderr}`;
  const unavailable = classifyUnavailable(r.error, r.stderrTail, r.exitCode);
  if (unavailable?.kind === 'quota') return { kind: 'model_quota', recovery: 'pause_model', reason: unavailable.reason, pause: unavailable };
  if (CONFIG.test(text) || CONFIG_STATUS.test(err)) {
    const reason = clip(err || stderr);
    return { kind: 'model_config', recovery: 'pause_model', reason, pause: { kind: 'config', reason } };
  }
  if (unavailable) return { kind: 'model_unavailable', recovery: 'pause_model', reason: unavailable.reason, pause: unavailable };
  if (OVERFLOW.test(err)) {
    return { kind: 'context_overflow', recovery: 'retry', reason: `子进程结束但没有提交（上下文超限：${clip(err, 200)}）。这次从头开始：不要整份读大文件，用 grep 和行号范围读需要的部分，进展随时记到 notes。` };
  }
  if (ENVIRONMENT.test(text)) {
    return { kind: 'environment', recovery: 'hand_to_user', reason: `运行环境出错，与任务无关，重试结果一样（磁盘、文件句柄或 pi 与插件的安装）：${clip(err || stderr)}。处理后 /forge unblock` };
  }
  if (!err && r.exitCode === 0) {
    return { kind: 'no_submit', recovery: 'retry', reason: '子进程结束但没有提交（未提交就结束）。做完要调用 forge_submit；做不下去时用 forge_block 说明卡在哪里，不要直接结束。' };
  }
  const why = err || `退出码 ${r.exitCode ?? '无（被信号结束）'}${r.stderrTail ? `：${r.stderrTail.slice(-300)}` : ''}`;
  return { kind: 'crash', recovery: 'retry', reason: `子进程结束但没有提交（${why}）` };
}
