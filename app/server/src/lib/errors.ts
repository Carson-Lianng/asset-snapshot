/**
 * 类型化错误体系（技术设计文档 §8.2）
 *
 * 对外只给「可读信息 + 错误码 + 追踪 ID」，绝不返回堆栈或 SQL 细节。
 */
import type { ErrorCode } from '@app/shared';

const STATUS_OF: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  RULE_VIOLATION: 422,
  INTERNAL: 500
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_OF[code];
    this.details = details;
  }
}

export const fail = {
  validation: (message = '请求参数不合法', details?: unknown) => new AppError('VALIDATION_FAILED', message, details),
  unauthorized: (message = '缺少或无效的访问令牌', details?: unknown) => new AppError('UNAUTHORIZED', message, details),
  forbidden: (message = '请求来源不被允许', details?: unknown) => new AppError('FORBIDDEN', message, details),
  notFound: (message = '资源不存在', details?: unknown) => new AppError('NOT_FOUND', message, details),
  methodNotAllowed: (message = '该资源不支持此方法', details?: unknown) => new AppError('METHOD_NOT_ALLOWED', message, details),
  conflict: (message = '资源冲突', details?: unknown) => new AppError('CONFLICT', message, details),
  rule: (message = '违反了业务规则', details?: unknown) => new AppError('RULE_VIOLATION', message, details),
  internal: (message = '服务内部错误', details?: unknown) => new AppError('INTERNAL', message, details)
};
