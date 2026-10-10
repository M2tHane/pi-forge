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
export const SCHEMA_VERSION = 1;

/** 版本链；新格式在此追加一步并把 SCHEMA_VERSION 加一 */
export const MIGRATIONS: Migration[] = [];

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
