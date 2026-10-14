// 共享错误码与统一错误响应。新增错误码在对象末尾追加一行，不改已有条目。
export const ERROR_CODES = {
  VALIDATION: 'E_VALIDATION',
  NOT_FOUND: 'E_NOT_FOUND',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorResponse {
  error: { code: ErrorCode; message: string };
}

export const errorResponse = (code: ErrorCode, message: string): ErrorResponse => ({ error: { code, message } });
