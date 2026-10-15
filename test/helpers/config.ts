import { readFileSync } from 'node:fs';
import path from 'node:path';
/** 运行时测试固定使用 v3 配置与 pi-forge 角色；真实模板单独验证 */
export const TEMPLATE_YAML = readFileSync(path.join(import.meta.dirname, '../fixtures/workflow-runtime.yaml'), 'utf8');
export const REAL_TEMPLATE_YAML = readFileSync(path.join(import.meta.dirname, '../../templates/workflow.yaml'), 'utf8');

/** 并发保持 2，测试中的调度顺序不随模板默认值变化；自动派发关闭：测试显式调用 engine.next，派发顺序可控（自动派发有单独的测试） */
export const TEST_YAML = TEMPLATE_YAML.replace(/^  max_parallel: 3\b[^\n]*$/m, '  max_parallel: 2').replace(/^  auto_dispatch: true\b[^\n]*$/m, '  auto_dispatch: false');
