#!/usr/bin/env node
/**
 * 开发态：并行起 API 与 Vite dev server（技术设计文档 §13.1）
 *
 * 两个进程分工明确，互不代理业务：
 *   · Vite（默认 5173）—— 提供前端，**数据来自离线 fixture**，改样式/组件即时热更；
 *   · API （默认 5174）—— 提供 /api，供 `?data=http` 时联调真实端点。
 *
 * 为什么 Step 3 仍以 fixture 为主：这一阶段的验收是「视觉等价」，
 * 离线源能做到「首帧即完整」，不会因为请求慢一拍而截到半个页面。
 *
 * 用法：
 *   npm run dev
 *   API_PORT=5274 WEB_PORT=5273 npm run dev
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverNodeArgs } from '../lib/server-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const API_PORT = process.env.API_PORT || '5174';
const WEB_PORT = process.env.WEB_PORT || '5173';

const children = [];

function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  child.on('exit', code => {
    if (stopping) return;
    process.stderr.write(`\n[${name}] 退出（code=${code}），正在停止其余进程\n`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.stdout.write(
  `\n  开发态启动\n` +
    `    前端（Vite）  http://127.0.0.1:${WEB_PORT}/#home\n` +
    `    API           http://127.0.0.1:${API_PORT}/api/health\n` +
    `  \n` +
    `  前端默认走真实 API；但 dev 下的 Vite 代理不带访问令牌，\n` +
    `  界面会显示「需要访问令牌」引导页 —— 日常联调请用 npm start（服务端会打印带令牌的地址）。\n` +
    `  只想看离线快照（只读）：http://127.0.0.1:${WEB_PORT}/?data=fixture#home\n\n`
);

start('api', process.execPath, serverNodeArgs(join(ROOT, 'app/server/src/main.ts')), {
  env: {
    ...process.env,
    /* 不传 DATA_DIR：默认已是仓库内 `./.data`（`config/env.ts`），与 `npm start` 同一份。
       这里显式传会压过 `.env` 里的 `DATA_DIR`（`--env-file` 不覆盖已有环境变量）。 */
    PORT: API_PORT,
    HOST: '127.0.0.1',
    // 让 API 侧也允许 Vite 开发端口发来的请求
    HTTP_LOG: process.env.HTTP_LOG ?? 'false'
  }
});

start(
  'web',
  process.execPath,
  [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', WEB_PORT, '--strictPort'],
  {
    cwd: join(ROOT, 'app/web'),
    env: { ...process.env }
  }
);
