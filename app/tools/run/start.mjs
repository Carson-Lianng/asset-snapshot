#!/usr/bin/env node
/**
 * 单端口启动（技术设计文档 §13.1 / §13.3 v1.0 形态 / ADR-12）
 *
 * 一个 Node 进程同时提供：
 *   · `/api/*`     —— Hono 业务接口（需 X-App-Token）
 *   · 其余路径      —— `app/web/dist` 的静态产物（前端外壳，无需令牌）
 * 因此浏览器只需要访问一个地址，用户不需要理解「前端/后端」这层概念。
 *
 * 用法：
 *   npm start                     # 端口与数据目录来自 .env（无 .env 则 PORT=0 随机端口）
 *   PORT=5199 npm start           # 临时换端口（压过 .env）
 *   PORT=0 npm start              # 系统随机端口，每次地址都变
 *   DATA_DIR=~/w/asset npm start  # 临时换数据目录（默认 <repo>/.data）
 *   WEB_DIST=./some/dist npm start# 指定静态根（默认 app/web/dist）
 *
 * 前置：`npm run build`（未构建时会明确提示，并退化为「只提供 API」）。
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverEnv, serverNodeArgs } from '../lib/server-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIST = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : join(ROOT, 'app/web/dist');

if (!existsSync(join(DIST, 'index.html'))) {
  process.stderr.write(
    `\n  未找到前端产物：${DIST}/index.html\n` +
      `  请先运行 npm run build（本进程将继续启动，但只提供 /api）。\n\n`
  );
}

/* 剔除 `NODE_OPTIONS`：宿主环境（IDE / 沙箱包装器）预载的 shim 会让服务子进程
   停在「活着、不监听、不打日志」的状态，用户看到的就是「npm start 卡住」。
   原因与实测见 app/tools/lib/server-env.mjs —— 该判定只有那一份实现。 */
/* 数据目录**不在这里传**：默认值由服务端 `config/env.ts` 的 `defaultDataDir()` 决定
   （= 仓库内 `./.data`，与 `npm run dev` 同一份）。在这里显式传反而会压过 `.env` 里的
   `DATA_DIR` —— `--env-file` 不覆盖已是环境变量的值，而调用点显式传进去的正是环境变量。 */
const child = spawn(process.execPath, serverNodeArgs(join(ROOT, 'app/server/src/main.ts')), {
  cwd: ROOT,
  env: serverEnv({ WEB_DIST: DIST }),
  stdio: 'inherit'
});

const forward = signal => () => child.kill(signal);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('exit', code => process.exit(code ?? 0));
