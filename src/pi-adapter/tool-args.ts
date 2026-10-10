// 注册工具时挂上 prepareArguments（Pi 1.1.0 ToolDefinition.prepareArguments：在 schema 校验之前调用）：
// 把模型填在可选参数里的占位值（''、'N/A'、null 等）当作没传（偏离 82）。
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { withoutPlaceholders } from '../core/tool-params.ts';

export const tolerantArgs = (def: ToolDefinition): ToolDefinition => ({ ...def, prepareArguments: (args: unknown) => withoutPlaceholders(def.parameters, args) });
