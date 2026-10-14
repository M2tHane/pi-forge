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
  /** 返回 true 的任务整个删除（文件一并删掉），在 task 之前判断 */
  drop?: (t: Json) => boolean;
}

/** 当前格式版本 */
export const SCHEMA_VERSION = 3;

const omit = (o: Json, keys: readonly string[]): Json => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const isAcctestId = (id: unknown) => typeof id === 'string' && /\.at(-\d+)?$/.test(id);

/** 1 → 2：删除 feature/lean 模式、test-author（.at 任务）、争议、规格修订留下的字段 */
const v1ToV2: Migration = {
  from: 1,
  description: '去掉 feature 与精简模式、验收测试任务（.at）、争议与规格修订的字段',
  flow: (f) => {
    const next = omit(f, ['plan_mode']);
    if (next['mode'] === 'feature') next['mode'] = 'build';
    if (next['spec'] && typeof next['spec'] === 'object') next['spec'] = omit(next['spec'] as Json, ['permission_changes']);
    return next;
  },
  drop: (t) => t['kind'] === 'acctest' || isAcctestId(t['id']),
  task: (t) => {
    const next = omit(t, ['acctest_round', 'changed_tests', 'waits_for', 'disputes']);
    if (Array.isArray(next['depends_on'])) next['depends_on'] = (next['depends_on'] as Json[]).filter((d) => !isAcctestId(d['task']));
    if (next['status'] === 'disputed') {
      next['status'] = 'blocked';
      next['blocked_by'] = 'dispatcher';
      next['blocked_reason'] = '争议流程已删除：任务原本在等待验收测试争议的裁决，请 /forge unblock 重新派发';
    } else if (next['blocked_by'] === 'dispute') next['blocked_by'] = 'dispatcher';
    return next;
  },
};

/** 2 → 3：删除范围申请机制（worker 不再有写入范围限制）留下的 task 字段 */
const v2ToV3: Migration = {
  from: 2,
  description: '去掉范围申请（scope_request）与范围批准记录（scope_grants）',
  task: (t) => omit(t, ['scope_request', 'scope_grants']),
};

/** 版本链；新格式在此追加一步并把 SCHEMA_VERSION 加一 */
export const MIGRATIONS: Migration[] = [v1ToV2, v2ToV3];

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
