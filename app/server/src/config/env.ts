/**
 * 环境变量集中校验（技术设计文档 §8.5 第 1 步：启动即失败）
 *
 * 任何非法取值都在进程启动的第一秒抛出，而不是等到某个请求触发时才暴露。
 */
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { REPO_ROOT } from './paths.ts';
import { parseFxSource, type FxSource } from '../lib/fx-source.ts';

export interface AppEnv {
  /** 监听端口；0 表示由系统分配（§10.2 随机端口） */
  port: number;
  /** 监听地址；恒为回环地址，绝不 0.0.0.0 */
  host: string;
  /** 数据目录：data.sqlite / .token / backups / logs */
  dataDir: string;
  /** 数据库文件绝对路径 */
  dbFile: string;
  /** 日志级别 */
  logLevel: string;
  /** 数据目录不存在时是否自动创建（首启需要，测试需要） */
  autoCreateDataDir: boolean;
  /** 启动后自动打开浏览器 */
  openBrowser: boolean;
  /** 令牌文件路径 */
  tokenFile: string;
  /** 是否把请求日志打到控制台（测试时关掉） */
  httpLog: boolean;
  /**
   * 前端静态产物目录（ADR-12 单端口形态）。
   * 显式给出即启用；未给出时由启动流程决定「默认目录是否存在」。
   */
  webDist: string | null;
  /** 备份保留份数（§6.6，默认 30） */
  backupKeep: number;
  /** 每次成功保存快照后是否自动备份（§6.6，默认开） */
  backupOnSnapshot: boolean;
  /**
   * 「获取实时汇率」用哪个公开源（第三批 #1 / #2）。
   *
   * 缺省 `frankfurter`（能用）；显式写 `off` 才是关掉 —— 见 `lib/fx-source.ts`
   * 的第 1 条硬约束：源必须走白名单，绝不接受「由请求参数决定地址」。
   * 这里只**解析**取值，不做任何网络动作（PRD §14：手动刷新，没有定时器）。
   */
  fxSource: FxSource;
}

/**
 * 数据目录的默认值 = **仓库内的 `./.data`**（不是平台默认目录）。
 *
 * 原先 `darwin` 走 `~/Library/Application Support/asset-snapshot`，带来一个实测到的坑：
 * `npm run dev` 在 `app/tools/run/dev.mjs` 里显式用 `<repo>/.data`，而 `npm start` 不设 `DATA_DIR`
 * 就落到平台目录 —— **两条启动路径各有一份数据**。在 dev 下建的账户用 `npm start` 打开会
 * 「不见了」，首次 `npm start` 还会在一个没人想到的位置新建库并灌入演示数据（实测该目录
 * 当时并不存在，2026-10-04）。
 *
 * 这是本机单用户的记账工具，数据位置必须**可发现、可拷贝**：备份就是拷一个文件夹，
 * 换机器就是搬一个文件夹。仓库内的 `./.data` 比深藏在用户目录里更符合这个用法。
 *
 * 仍然可以被 `DATA_DIR` 覆盖（`.env` 里写 `DATA_DIR=` 亦可，见 §15）。
 */
function defaultDataDir(): string {
  return join(REPO_ROOT, '.data');
}

function intOf(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`环境变量 ${name} 必须是非负整数，实际为 ${raw}`);
  return n;
}

function boolOf(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  return fallback;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const dataDir = resolve(source.DATA_DIR && source.DATA_DIR.trim() !== '' ? source.DATA_DIR : defaultDataDir());
  const autoCreateDataDir = boolOf(source.AUTO_CREATE_DATA_DIR, true);
  if (autoCreateDataDir) mkdirSync(dataDir, { recursive: true });

  const host = source.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `HOST 只允许回环地址（127.0.0.1 / localhost / ::1），实际为 ${host}。` +
        '绑定非回环地址会让同网段设备访问到你的资产数据（技术设计文档 §10.2）。'
    );
  }

  return {
    port: intOf(source.PORT, 0, 'PORT'),
    host,
    dataDir,
    dbFile: source.DB_FILE ? resolve(source.DB_FILE) : join(dataDir, 'data.sqlite'),
    logLevel: source.LOG_LEVEL ?? 'info',
    autoCreateDataDir,
    openBrowser: boolOf(source.OPEN_BROWSER, false),
    tokenFile: source.TOKEN_FILE ? resolve(source.TOKEN_FILE) : join(dataDir, '.token'),
    httpLog: boolOf(source.HTTP_LOG, true),
    webDist: source.WEB_DIST && source.WEB_DIST.trim() !== '' ? resolve(source.WEB_DIST) : null,
    // 0 会让 pruneBackups 早退、等于永不清理，所以下限取 1（要关掉清理请用大数，而不是 0）
    backupKeep: Math.max(1, intOf(source.BACKUP_KEEP, 30, 'BACKUP_KEEP')),
    backupOnSnapshot: boolOf(source.BACKUP_ON_SNAPSHOT, true),
    fxSource: parseFxSource(source.FX_SOURCE)
  };
}
