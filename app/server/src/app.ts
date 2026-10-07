/**
 * 应用装配（技术设计文档 §8.1 中间件顺序 / §8.2 错误体系）
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { ApiErrorBody, ErrorCode } from '@app/shared';
import type { Logger } from 'pino';
import type { Db } from './db/client.ts';
import { AppError } from './lib/errors.ts';
import {
  accessLogMiddleware,
  contentTypeGuardMiddleware,
  hostGuard,
  originGuard,
  requestIdMiddleware,
  securityHeadersMiddleware,
  tokenGuard,
  type AppEnv,
  type BootInfo
} from './middleware.ts';
import { contextMiddleware } from './context.ts';
import { staticMiddleware } from './lib/static.ts';
import type { FxSource } from './lib/fx-source.ts';
import { createMetaRoutes } from './modules/meta.ts';
import { createCatalogRoutes } from './modules/catalog.ts';
import { createAccountRoutes } from './modules/accounts.ts';
import { createInventoryRoutes } from './modules/inventory.ts';
import { createSnapshotRoutes } from './modules/snapshots.ts';
import { createReportRoutes } from './modules/reports.ts';
import { createDataRoutes } from './modules/data.ts';

const BODY_LIMIT_BYTES = 5 * 1024 * 1024;

export interface CreateAppOptions {
  db: Db;
  token: string;
  logger: Logger;
  boot: BootInfo;
  /**
   * 前端静态产物目录（ADR-12 的单端口形态）。
   * 为空表示只提供 API —— 开发态前端由 Vite dev server 提供（§13.1）。
   */
  webDist?: string | null;
  /**
   * 数据目录：备份文件落在它的 `backups/` 下（§6.6）。
   *
   * 单独传而不是从 `boot` 里取 —— `boot` 是「给前端看的信息」（含端口、版本），
   * 让它同时充当配置来源，会让「谁决定备份写到哪」变得说不清。
   */
  dataDir: string;
  /** 备份保留份数（§6.6，默认 30） */
  backupKeep?: number;
  /** 每次成功保存快照后是否自动备份（§6.6，默认开） */
  backupOnSnapshot?: boolean;
  /**
   * 「获取实时汇率」用哪个公开源（PRD §14）。
   *
   * 由启动层从 `FX_SOURCE` 解析后传进来；编程式调用方（验收脚本）不传即视为
   * `'off'` —— 见 `routes/catalog.ts` 的 `CatalogOptions.fxSource`。
   */
  fxSource?: FxSource;
}

export function createApp(opts: CreateAppOptions): Hono<AppEnv> {
  const { db, token, logger, boot, webDist, dataDir } = opts;
  const backupKeep = opts.backupKeep ?? 30;
  const app = new Hono<AppEnv>();

  const guardOpts = { boot, token };

  // 1. requestId → 2. 上下文（logger / boot）→ 3. 结构化访问日志（进入）
  app.use('*', requestIdMiddleware);
  app.use('*', contextMiddleware(logger, boot));
  app.use('*', accessLogMiddleware);

  // 3. Host 校验（防 DNS rebinding，必须早于任何业务处理）
  app.use('*', hostGuard(guardOpts));
  // 4. Origin 白名单（防跨站发起）
  app.use('*', originGuard(guardOpts));
  // 5. 前端静态产物：受 3/4 约束，但**不**要求令牌（见 lib/static.ts 的说明）
  if (webDist) app.use('*', staticMiddleware(webDist));
  // 6. 访问令牌（X-App-Token）—— 仅约束 /api
  app.use('*', tokenGuard(guardOpts));
  // 7. 安全响应头
  app.use('*', securityHeadersMiddleware);
  // 8. 写操作必须 JSON（触发预检，防简单请求绕过）+ 请求体上限
  app.use('*', contentTypeGuardMiddleware);
  app.use('*', bodyLimit({ maxSize: BODY_LIMIT_BYTES }));

  // 9. 路由分发
  const api = new Hono<AppEnv>();
  /** 结构性日志出口：备份相关的事件（含失败）都从这里出去 */
  const backupLog = (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void => {
    logger[level](extra ?? {}, msg);
  };

  api.route('/', createMetaRoutes(db, boot.version));
  api.route('/', createCatalogRoutes(db, { fxSource: opts.fxSource }));
  api.route('/', createAccountRoutes(db));
  api.route(
    '/',
    createInventoryRoutes(db, {
      // 关闭自动备份时传 null：盘点模块据此完全不做备份动作
      backup: opts.backupOnSnapshot === false ? null : { dataDir, keep: backupKeep, log: backupLog }
    })
  );
  api.route('/', createSnapshotRoutes(db));
  api.route('/', createReportRoutes(db));
  api.route('/', createDataRoutes(db, { dataDir, backupKeep, log: backupLog }));
  app.route('/api', api);

  // 10. 404 兜底
  app.notFound(c =>
    c.json<ApiErrorBody>(
      {
        error: {
          code: 'NOT_FOUND',
          message: `未知接口：${c.req.method} ${c.req.path}`,
          request_id: c.get('requestId') ?? 'unknown'
        }
      },
      404
    )
  );

  // 11. 全局错误处理：类型化错误 → 规范化 JSON
  app.onError((err, c) => {
    const requestId = (() => {
      try {
        return c.get('requestId');
      } catch {
        return 'unknown';
      }
    })();

    if (err instanceof AppError) {
      return c.json<ApiErrorBody>(
        {
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
            request_id: requestId
          }
        },
        err.status as ContentfulStatusCode
      );
    }

    if (err instanceof ZodError) {
      return c.json<ApiErrorBody>(
        {
          error: {
            code: 'VALIDATION_FAILED' satisfies ErrorCode,
            message: '请求参数不合法',
            details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
            request_id: requestId
          }
        },
        400
      );
    }

    // 未预期异常：日志留完整堆栈，响应只给追踪 ID
    const e = err as Error;
    logger.error(
      { request_id: requestId, error_name: e.name, error_message: e.message, stack: e.stack },
      'unhandled_error'
    );
    return c.json<ApiErrorBody>(
      {
        error: {
          code: 'INTERNAL',
          message: '服务内部错误，请凭 request_id 查看日志',
          request_id: requestId
        }
      },
      500
    );
  });

  return app;
}
