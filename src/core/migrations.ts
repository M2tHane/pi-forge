// 来源：pi-flow src/core/migrations.ts @ 31f3f15
// .forge/ 格式迁移（第六轮 7.1）：state.json 的 schema_version 记录格式版本。旧版本在第一次写入时（或恢复时显式）
// 按版本链迁移流程、任务与提案文件，迁移与事件在同一个事务里提交，结果照常过 schema 校验。
// 每一步是纯函数：输入旧 JSON，返回新 JSON（不改就原样返回）。

type Json = Record<string, unknown>;

export interface Migration {
  /** 从这个版本迁移到 from + 1 */
  from: number;
  description: string;
  flow?: (f: Json) => Json;
  task?: (t: Json, flow: Json) => Json;
  proposal?: (p: Json, flow: Json) => Json;
  /** 任务迁移之后再改流程（before 是迁移前的任务） */
  finish?: (f: Json, before: readonly Json[]) => Json;
}

/** 当前格式版本 */
export const SCHEMA_VERSION = 2;

const SETTLED = new Set(['done', 'cancelled']);
const OLD_ROLES = new Set(['designer', 'architect']);

/**
 * 1 → 2（第六轮）：删除原型阶段 D1；规划由主 agent 进行（flow.planning）；计划修订由主 agent 起草（flow.replan_request）。
 * 旧流程停在 D1 时直接进入 D2 由主 agent 规划；designer、architect 未结束的任务取消，未结束的修订任务转为修订请求。
 */
const v1to2: Migration = {
  from: 1,
  description: '删除原型阶段，规划与计划修订改由主 agent 进行',
  flow: (f) => {
    const stages = (f['stages'] as string[]).filter((x) => x !== 'D1');
    const skip = ((f['skip_stages'] as string[] | undefined) ?? []).filter((x) => x !== 'D1');
    const { skip_stages: _s, ...rest } = f;
    const out: Json = { ...rest, stages, ...(skip.length ? { skip_stages: skip } : {}) };
    if (f['mode'] === 'fix') return out;
    const at = stages.indexOf(String(f['stage']));
    if (f['stage'] === 'D1') Object.assign(out, { stage: 'D2', stage_status: 'active', planning: { submitted: false, rounds: 0, feedback: '旧流程迁移：原型阶段已删除，规划改由你（主 agent）进行' } });
    else if (f['stage'] === 'D2') out['planning'] = { submitted: f['stage_status'] === 'awaiting_human', rounds: 0 };
    else if (at > stages.indexOf('D2')) out['planning'] = { submitted: true, rounds: 0 };
    return out;
  },
  task: (t) => {
    if (SETTLED.has(String(t['status'])) || !(OLD_ROLES.has(String(t['role'])) || t['replan'])) return t;
    return { ...t, status: 'cancelled', lease: null, blocked_reason: null };
  },
  finish: (f, before) => {
    const open = before.filter((t) => t['replan'] && !SETTLED.has(String(t['status'])));
    if (!open.length) return f;
    return { ...f, replan_request: { reason: open.map((t) => String(t['replan'])).join('\n\n'), at: new Date().toISOString() } };
  },
};

/** 版本链；新格式在此追加一步并把 SCHEMA_VERSION 加一 */
export const MIGRATIONS: Migration[] = [v1to2];

/** 从 from 到 to 依次要执行的迁移；缺某一步时返回缺的版本号 */
export function migrationChain(from: number, to: number, list: readonly Migration[] = MIGRATIONS): { steps: Migration[]; missing: number | null } {
  const steps: Migration[] = [];
  for (let v = from; v < to; v++) {
    const m = list.find((x) => x.from === v);
    if (!m) return { steps, missing: v };
    steps.push(m);
  }
  return { steps, missing: null };
}
