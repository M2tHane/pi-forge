// 极简路由：handle(method, path, body) → { status, body }。不开端口，测试直接调用；main.ts 把它挂到 node:http 上。
import { createBoard, listBoards } from './boards.ts';
import { ERROR_CODES, errorResponse } from '../shared/errors.ts';

export interface Response { status: number; body: unknown }

export function handle(method: string, path: string, body?: unknown): Response {
  if (method === 'POST' && path === '/boards') return createBoard((body as { name?: unknown } | undefined)?.name);
  if (method === 'GET' && path === '/boards') return listBoards();
  return { status: 404, body: errorResponse(ERROR_CODES.NOT_FOUND, `没有 ${method} ${path}`) };
}
