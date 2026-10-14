// 验收测试入口：只经 handle() 调用接口，不开端口。
import { handle } from '../../../src/server/http.ts';
import { resetBoards } from '../../../src/server/boards.ts';

export const api = (method: string, path: string, body?: unknown) => handle(method, path, body);
export const reset = () => resetBoards();
