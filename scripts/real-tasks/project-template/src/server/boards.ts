import type { Board } from '../shared/types.ts';
import { ERROR_CODES, errorResponse, type ErrorResponse } from '../shared/errors.ts';

const boards = new Map<string, Board>();
let seq = 0;

export type Result<T> = { status: number; body: T | ErrorResponse };

export function createBoard(name: unknown): Result<Board> {
  if (typeof name !== 'string' || !name.trim()) return { status: 400, body: errorResponse(ERROR_CODES.VALIDATION, '名称不能为空') };
  const board: Board = { id: `b-${++seq}`, name: name.trim(), createdAt: new Date().toISOString() };
  boards.set(board.id, board);
  return { status: 201, body: board };
}

export function listBoards(): Result<Board[]> {
  return { status: 200, body: [...boards.values()] };
}

export function getBoard(id: string): Board | undefined {
  return boards.get(id);
}

/** 测试用：清空内存数据 */
export function resetBoards(): void {
  boards.clear();
  seq = 0;
}
