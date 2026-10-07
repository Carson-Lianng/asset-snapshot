/**
 * 启动与优雅停机（技术设计文档 §8.5）
 *
 * 启动顺序：环境变量 → 开库 + PRAGMA + 迁移 → 基础数据完整性 → 令牌 →
 * 绑定端口 → 输出带令牌的访问地址。
 * 任一步失败立即退出并打印可读原因（快速失败，不带着半迁移的库继续跑）。
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { loadEnv } from './config/env.ts';
import { APP_VERSION, FIXTURE_FILE, WEB_DIST } from './config/paths.ts';
import { createLogger } from './lib/logger.ts';
import { loadOrCreateToken } from './lib/token.ts';
import { closeDb, openDb } from './db/client.ts';
import { currentVersion, isInitialized, migrate } from './db/migrate.ts';
import { ensureDataMode, ensureInitMarker, isSeeded, seedFromFixture } from './db/seed.ts';
import { hasBackupToday, safeBackup } from './db/backup.ts';
import { createApp } from './app.ts';
import type { BootInfo } from './middleware.ts';

async function main(): Promise<void> {
  // 1. 环境变量
  const env = loadEnv();
  const logger = createLogger({ level: env.logLevel, pretty: env.httpLog });

  // 2. 开库 + PRAGMA + 迁移
  const db = openDb(env.dbFile);
  const mig = migrate(db.raw);
  if (mig.applied.length) {
    logger.info({ applied: mig.applied, from: mig.from, to: mig.to }, 'schema_migrated');
  }
  if (!isInitialized(db.raw)) throw new Error('迁移执行后仍未找到业务表，数据库状态异常');

  // 3. 基础数据完整性：只在**从未初始化过**的库上用冻结的演示数据种子化。
  //    判据是显式标记，不是「快照表非空」—— 后者会把「用户删空快照」误判成全新库，
  //    而种子化的第一步是清空全部业务表，于是自己建的账户/平台/分类全被演示数据覆盖。
  //    成因与实测见 db/seed.ts 的 `isSeeded`。
  if (ensureInitMarker(db.raw)) {
    logger.info('init_marker_backfilled —— 判据换代前的库，已补记初始化标记（不触碰任何业务数据）');
  }
  /* 老库兼容：`data_mode` 也是后加的键。只有能**证明**库里就是夹具那几行时才补记
     `'demo'`；证明不了就什么都不写，按 `'live'` 处理（见 `ensureDataMode` 的取舍）。 */
  if (ensureDataMode(db.raw, FIXTURE_FILE)) {
    logger.info('data_mode_backfilled —— 账户与演示夹具完全一致，已补记 data_mode=demo');
  }
  if (!isSeeded(db.raw)) {
    if (existsSync(FIXTURE_FILE)) {
      const stats = seedFromFixture(db.raw, FIXTURE_FILE);
      logger.info(
        { snapshots: stats.snapshots, accounts: stats.accounts, items: stats.snapshot_items },
        'seeded_from_fixture'
      );
    } else {
      logger.warn(
        { fixture: FIXTURE_FILE },
        'empty_database_and_no_fixture —— 库为空且未找到演示数据，接口将返回空报表'
      );
    }
  }

  // 4. 访问令牌
  const token = loadOrCreateToken(env.tokenFile);

  // 5. 前端静态产物：显式 WEB_DIST 优先；否则用仓库内已构建的 app/web/dist（若存在）。
  //    没构建过就退回「只提供 API」，开发态由 Vite dev server 提供前端。
  const webDist = env.webDist ?? (existsSync(join(WEB_DIST, 'index.html')) ? WEB_DIST : null);

  // 6–8. 绑定端口（PORT=0 由系统分配）后输出访问地址
  const boot: BootInfo = {
    version: APP_VERSION,
    startedAt: Date.now(),
    dataDir: env.dataDir,
    port: 0,
    allowedOrigins: []
  };

  const app = createApp({
    db,
    token,
    logger,
    boot,
    webDist,
    dataDir: env.dataDir,
    backupKeep: env.backupKeep,
    backupOnSnapshot: env.backupOnSnapshot,
    fxSource: env.fxSource
  });

  const server = serve(
    { fetch: app.fetch, hostname: env.host, port: env.port },
    info => {
      boot.port = info.port;
      boot.allowedOrigins = [
        `http://127.0.0.1:${info.port}`,
        `http://localhost:${info.port}`,
        // 开发态 Vite dev server
        'http://127.0.0.1:5173',
        'http://localhost:5173'
      ];
      const url = `http://127.0.0.1:${info.port}/#t=${token}`;
      logger.info(
        {
          url,
          host: env.host,
          port: info.port,
          schema_version: currentVersion(db.raw),
          data_dir: env.dataDir,
          db_file: env.dbFile,
          web_dist: webDist
        },
        'server_listening'
      );
      // 令牌只在此处出现一次：URL fragment 不会发送给服务器
      process.stdout.write(
        '\n  家底快照已启动（仅本机可访问）\n' +
          `  ${url}\n` +
          (webDist
            ? `  前端静态产物：${webDist}\n`
            : '  未发现前端构建产物：本进程只提供 /api（开发态请用 npm run dev）\n') +
          '\n'
      );

      /* 7. 当日首次启动时自动备份一次（§6.6）。
         放在端口就绪之后、且**不 await**：备份不该拖慢启动，
         而它失败也只记日志（safeBackup 内部吞异常），不影响服务可用。 */
      if (!hasBackupToday(env.dataDir)) {
        void safeBackup(db, env.dataDir, env.backupKeep, (level, msg, extra) =>
          logger[level](extra ?? {}, msg)
        );
      }

      if (env.openBrowser) openBrowser(url);
    }
  );

  /* 监听失败是 **error 事件**，不会被下面的 `main().catch` 接住 —— 不处理就会甩出
     一段 uncaught 堆栈。固定端口之后「端口被占用」是最常见的一次性故障，
     这里换成一句可执行的下一步。 */
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `\n  启动失败：端口 ${env.port} 已被占用。\n` +
          '    换一个端口：PORT=5199 npm start\n' +
          '    或每次用系统随机端口：PORT=0 npm start\n\n'
      );
    } else {
      process.stderr.write(`\n  启动失败：${err.message}\n\n`);
    }
    process.exit(1);
  });

  // 9. 优雅停机：先停止接受新连接，等在途请求，再关库
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting_down');
    const force = setTimeout(() => {
      logger.warn('graceful_shutdown_timeout');
      process.exit(1);
    }, 5000);
    force.unref();
    server.close(() => {
      closeDb(db);
      logger.info('shutdown_complete');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * 启动后自动打开浏览器（`OPEN_BROWSER=true`，见 §15）。
 *
 * 在此之前这个变量被 `loadEnv` 解析、写在 `.env.example` 里，却**从未被任何代码读取**
 * （2026-10-04 核对时发现）—— 一个「配置项写了但没接线」的缺口。
 *
 * 失败一律吞掉：打不开浏览器不是服务的问题，终端里已经打印了可点的地址。
 * 用 detached + unref 是为了不把子进程绑在当前进程的退出上（关服务时不必管它）。
 */
function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // 命令不存在时是 `error` 事件而不是抛异常；不接住会变成 unhandled error。
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* 忽略：打开浏览器失败不影响服务 */
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  process.stderr.write(`\n启动失败：${e.message}\n${e.stack ?? ''}\n\n`);
  process.exit(1);
});
