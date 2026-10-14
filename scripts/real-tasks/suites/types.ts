// 真实模型 task 实验的项目套件：项目文件、命令、S1 的 task 清单。
import type { TaskInput } from '../../../src/core/state/state-store.ts';

export interface SeededTask { task: TaskInput; brief: string }

export interface Suite {
  name: string;
  /** workflow.yaml 的 project 名 */
  project: string;
  /** 流程标题 */
  title: string;
  stageGoal: string;
  commands: Record<string, string>;
  /** 把项目文件放进 dir（dir 已存在且为空；之后由驱动 git init 并提交） */
  prepare(dir: string): void;
  tasks: SeededTask[];
  /** M 号 task 的时间预算（分钟） */
  runMinutes: number;
}
