/**
 * 令牌与端口（技术设计文档 §10.2）
 *
 * 令牌用 URL fragment（`#t=...`）传给前端一次：fragment 不会发送给服务器，
 * 因此不会进入浏览器历史之外的任何日志；随后前端存 sessionStorage 并以
 * `X-App-Token` 头回传。**不放 localStorage**（XSS 可长期窃取）、
 * **不放查询参数**（会进日志）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadOrCreateToken(tokenFile: string, forceNew = false): string {
  if (!forceNew && existsSync(tokenFile)) {
    const t = readFileSync(tokenFile, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  try {
    chmodSync(tokenFile, 0o600);
  } catch {
    /* 非 POSIX 平台无权限位，忽略 */
  }
  return token;
}

/** 定长比对，避免按字符提前返回造成的时间侧信道 */
export function tokenMatches(expected: string, received: string | undefined | null): boolean {
  if (!received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hostAllowed(hostHeader: string | undefined, port: number, extra: string[] = []): boolean {
  if (!hostHeader) return false;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...extra
  ]);
  return allowed.has(hostHeader.toLowerCase());
}
