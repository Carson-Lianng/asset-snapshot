/**
 * api/problem.ts —— 服务端错误 → 界面文案
 *
 * 服务端的错误体是 `{ error: { code, message, details } }`（见 app/server/src/lib/errors.ts），
 * 由 `DataSourceError.detail` 原样带到前端。这里把它解出来，
 * 让每个调用点都能拿到「错误码 + 服务端原话 + 结构化细节」，
 * 而不是各自去 `err.message` 里猜。
 *
 * 为什么要按 `code` 分派而不是按 HTTP 状态：状态码只有 422 一个笼统的「业务规则不满足」，
 * 而 `details` 里才藏着「是哪条规则、涉及哪些账户」。界面要提示到那一层。
 */
import { DataSourceError } from './source.ts';

export interface ApiProblem {
  /** 服务端的 `ErrorCode`，如 CONFLICT / RULE_VIOLATION；取不到时为空串 */
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** 解出服务端错误体；不是服务端给的错误（网络失败等）返回 null */
export function problemOf(err: unknown): ApiProblem | null {
  if (!(err instanceof DataSourceError)) return null;
  const d = err.detail;
  if (!d || typeof d !== 'object' || !('error' in d)) return null;
  const e = (d as { error?: Record<string, unknown> }).error;
  if (!e) return null;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : err.message;
  const details =
    e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  return { code, message, details };
}

/** 给用户看的一句话：优先服务端的原话，取不到才退回 Error.message */
export function messageOf(err: unknown): string {
  return problemOf(err)?.message ?? (err instanceof Error ? err.message : String(err));
}
