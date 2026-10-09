// pi-forge M0：pi-flow @ 31f3f15 的包内容（agents、skills、rules、templates、prompts）放在夹具里，
// 运行时测试引用它，与 pi-forge 自己的 v3 角色、技能和模板解耦（随 M1 以后的改编逐步迁移）。
import path from 'node:path';

export const PKG_CONTENT = path.join(import.meta.dirname, '../fixtures/pi-flow-package');
