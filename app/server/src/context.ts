/**
 * 中间件上下文装配
 */
import { createMiddleware } from 'hono/factory';
import type { Logger } from 'pino';
import type { AppEnv, BootInfo } from './middleware.ts';

export function contextMiddleware(logger: Logger, boot: BootInfo) {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set('logger', logger);
    c.set('boot', boot);
    await next();
  });
}
