/**
 * 中间件装配（技术设计文档 §8.1）
 *
 * 顺序有安全含义，不能随意调整：
 *   1. requestId 生成 → 2. 结构化日志（进入） → 3. Host 校验 → 4. Origin 白名单
 *   → 5. 访问令牌 → 6. 安全响应头 → 7. 请求体大小上限 → 8. 路由
 *   → 9. 404 → 10. onError → 11. 结构化日志（完成）
 *
 * 第 3/4/5 条都必须早于任何业务处理：DNS rebinding 与跨站探测是本机服务
 * 最现实的攻击面（§10.1）。
 */
import { randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Logger } from 'pino';
import { fail } from './lib/errors.ts';
import { hostAllowed, tokenMatches } from './lib/token.ts';

/** 启动期已知信息。`port` 与 `allowedOrigins` 在端口绑定完成后再补写 —— 
 *  中间件只在请求到达时读取它们，而请求必然发生在监听之后。 */
export interface BootInfo {
  version: string;
  startedAt: number;
  dataDir: string;
  port: number;
  allowedOrigins: string[];
}

export interface AppVars {
  requestId: string;
  logger: Logger;
  boot: BootInfo;
}

export type AppEnv = { Variables: AppVars };

const REQ_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const requestIdMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && REQ_ID_RE.test(incoming) ? incoming : randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
});

export const accessLogMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const logger = c.get('logger');
  const start = performance.now();
  await next();
  logger.info(
    {
      request_id: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Number((performance.now() - start).toFixed(1))
    },
    'http'
  );
});

export interface GuardOptions {
  /** 启动信息（含端口与 Origin 白名单，二者在绑定端口后补写） */
  boot: BootInfo;
  /** 访问令牌 */
  token: string;
  /** 无需令牌即可访问的路径（仅存活探针） */
  tokenExemptPaths?: string[];
}

export function hostGuard(opts: GuardOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const host = c.req.header('host');
    if (!hostAllowed(host, opts.boot.port)) {
      throw fail.forbidden('请求的 Host 不被允许（仅接受回环地址）', { host: host ?? null });
    }
    await next();
  });
}

export function originGuard(opts: GuardOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !opts.boot.allowedOrigins.includes(origin)) {
      throw fail.forbidden('请求来源不在白名单内', { origin });
    }
    // 无 Origin 头（curl / 同源 GET / 部分客户端）：由令牌中间件兜底强制要求令牌
    await next();
  });
}

export function tokenGuard(opts: GuardOptions) {
  const exempt = new Set(opts.tokenExemptPaths ?? ['/api/health']);
  return createMiddleware<AppEnv>(async (c, next) => {
    if (exempt.has(c.req.path)) {
      await next();
      return;
    }
    // 只认请求头：绝不接受查询参数（会进入浏览器历史与服务端日志，§10.2）
    const header = c.req.header('x-app-token');
    if (!tokenMatches(opts.token, header)) {
      throw fail.unauthorized('缺少或无效的访问令牌（X-App-Token）');
    }
    await next();
  });
}

/**
 * 前端与 API 同源，无需放开任何外部资源。
 * 静态托管层（lib/static.ts）也复用同一份策略 —— 两条出口的安全头必须一致，
 * 否则「构建产物直出」会绕开 CSP / nosniff。
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const securityHeadersMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
});

/**
 * 写操作要求 JSON Content-Type：跨站 HTML 表单只能发出 `application/x-www-form-urlencoded`，
 * 因此「要求 JSON」等于「要求一次预检」，把 CSRF 挡在门外（§10.2）。
 *
 * **管辖范围是「带请求体的写操作」。**
 *
 * 「有没有请求体」只看 HTTP 分帧：`content-length > 0` 或存在 `transfer-encoding`。
 * 曾经用过的第三个信号 `c.req.raw.body !== null` 已删除 —— 它在两个运行时的语义相反：
 *   · `@hono/node-server` 上，**无请求体**的 POST / DELETE 到达 handler 时
 *     `c.req.raw.body` 也是非 null 的（一个空流）；
 *   · Hono 的合成请求（`app.request(...)`）无体时是 null。
 * 于是「无体的写操作」在真实服务端被 403，而用 `app.request` 写的用例照样通过 ——
 * 测试替真实运行撒了谎。踩过的实例：`POST /inventory/session`（盘点向导开局）与
 * 所有 `DELETE`（快照 / 账户 / 基础资料）在浏览器里全部 403，向导永远停在「正在准备盘点数据…」。
 *
 * 那个信号原本是为了拦住「有体但两个帧头都没带」的合成请求。代价与收益不成比例：
 * HTTP/1.1 不允许「有体却既无 content-length 也无 transfer-encoding」的报文，
 * 真实客户端造不出这种请求。因此改为按分帧判定。
 *
 * 另有一条独立的收紧：`Content-Type` **非空但非 JSON** 一律拒绝。
 * 这样「`Content-Length: 0` + `application/x-www-form-urlencoded`」这种空表单提交也进不来，
 * 不受上面那条放宽的影响。真实浏览器发出的无体 POST / DELETE 不带 Content-Type，正常放行。
 */
export const contentTypeGuardMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const m = c.req.method;
  if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    if (!ct.includes('application/json')) {
      const declaredBody =
        Number(c.req.header('content-length') ?? '0') > 0 || !!c.req.header('transfer-encoding');
      if (declaredBody || ct !== '') {
        throw fail.forbidden('写操作必须使用 application/json', { content_type: ct });
      }
    }
  }
  await next();
});

export type { Context, Next, Logger };
