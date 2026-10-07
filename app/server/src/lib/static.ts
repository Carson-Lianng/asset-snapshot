/**
 * static.ts —— 前端静态产物托管（ADR-12：单进程同时提供 API 与前端）
 *
 * **注册位置有安全含义**，见 app.ts：它在 hostGuard / originGuard 之后、tokenGuard 之前。
 *   · 放在两道守卫之后：静态资源同样受「仅回环 Host」「Origin 白名单」约束，
 *     本机服务最现实的攻击面（DNS rebinding，§10.1）不会被静态层绕开；
 *   · 放在令牌守卫之前：页面外壳与哈希资源不含业务数据，而浏览器在**文档请求**里
 *     无法携带 X-App-Token（令牌在 URL fragment 里，根本不会到服务端）。
 *     **API 仍然要求令牌** —— 数据侧的边界没有放宽。
 *
 * 没有引入 `@hono/node-server/serve-static`：这里需要的是「命中文件才接管，
 * 否则交回后续中间件」的语义（缺文件时由 API 的 404 兜底给出可读 JSON 错误），
 * 自己实现反而更短、更明确。路径穿越用 `resolve` + 前缀比较挡住。
 */
import { createReadStream, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createMiddleware } from 'hono/factory';
import { CONTENT_SECURITY_POLICY, type AppEnv } from '../middleware.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

export function staticMiddleware(rootDir: string) {
  const root = resolve(rootDir);

  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return next();

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return next();
    }
    if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html';

    const file = resolve(root, '.' + normalize(pathname));
    if (file !== root && !file.startsWith(root + sep)) return next();

    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) return next();
      size = st.size;
    } catch {
      return next();
    }

    /* /assets/ 下是带内容哈希的文件名，可以长缓存；入口与其它的每次校验 */
    const immutable = pathname.startsWith('/assets/');
    const headers: Record<string, string> = {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(size),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin'
    };

    if (method === 'HEAD') return c.body(null, 200, headers);
    const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
    return c.body(stream, 200, headers);
  });
}
