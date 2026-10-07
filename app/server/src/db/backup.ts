/**
 * SQLite 在线备份（技术设计文档 §6.6）
 *
 * 用 better-sqlite3 的备份 API —— 它底层是 SQLite Online Backup API，
 * **不需要停服务、不阻塞正常读写**。这一点很关键：库开了 WAL，
 * 直接 `cp data.sqlite` 会漏掉还在 `-wal` 文件里的最新写入，
 * 而「备份文件比实际数据旧」是那种平时看不出来、真要恢复时才发现的坑。
 *
 * 命名 `backup-YYYY-MM-DD.sqlite`（一天一份，同日覆盖），保留最近 `BACKUP_KEEP` 份。
 *
 * ## 失败绝不向上抛
 *
 * 备份是**兜底**手段，不是主流程的一部分：保存快照时顺带备份，如果备份失败
 * 却让保存也看起来失败，用户会以为数据没存下来 —— 那比没有备份更糟。
 * 所以调用方一律 catch 并只记日志（见 `safeBackup`）。
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from './client.ts';

export interface BackupEntry {
  name: string;
  /** 字节数 */
  size: number;
  /** 文件修改时间（ISO-8601） */
  created_at: string;
}

/**
 * 结构化日志出口。
 *
 * 备份是「顺带做的事」，它的失败不该影响主流程，所以它需要一条**只记日志**的
 * 上报通道 —— 调用方不必为它准备返回值或错误分支。
 */
export type BackupLog = (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;

const FILE_RE = /^backup-(\d{4}-\d{2}-\d{2})\.sqlite$/;

export function backupsDir(dataDir: string): string {
  return resolve(dataDir, 'backups');
}

/** 本地日期的 `YYYY-MM-DD`（与文件名一致，不用 UTC —— 用户看的是本地日历） */
export function dateStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function backupNameFor(d: Date = new Date()): string {
  return `backup-${dateStamp(d)}.sqlite`;
}

/** 备份文件列表，按日期倒序（最新在前）。目录不存在时返回空数组。 */
export function listBackups(dataDir: string): BackupEntry[] {
  const dir = backupsDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(n => FILE_RE.test(n))
    .map(name => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/**
 * 立即备份。
 *
 * @throws 备份失败时抛出（由 `safeBackup` 兜住）
 */
export async function runBackup(db: Db, dataDir: string, now: Date = new Date()): Promise<BackupEntry> {
  const dir = backupsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const name = backupNameFor(now);
  const target = join(dir, name);

  // 同日重复备份会覆盖同名文件：文档的命名规则就是「一天一份」，
  // 保留当天最后一次的状态即可，不必为每次备份生成新名字。
  await db.raw.backup(target);

  const st = statSync(target);
  return { name, size: st.size, created_at: st.mtime.toISOString() };
}

/** 保留最近 `keep` 份，返回被删掉的文件名 */
export function pruneBackups(dataDir: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep <= 0) return [];
  const all = listBackups(dataDir); // 已按日期倒序
  const doomed = all.slice(keep).map(b => b.name);
  for (const name of doomed) {
    try {
      rmSync(join(backupsDir(dataDir), name));
    } catch {
      /* 删不掉不致命：下次还会再试 */
    }
  }
  return doomed;
}

/**
 * 备份 + 清理，**任何失败都只记日志**。
 *
 * 这是给「启动时」与「保存快照后」两个自动触发点用的包装。
 */
export async function safeBackup(
  db: Db,
  dataDir: string,
  keep: number,
  onLog: BackupLog
): Promise<BackupEntry | null> {
  try {
    const entry = await runBackup(db, dataDir);
    const removed = pruneBackups(dataDir, keep);
    onLog('info', 'backup_done', { file: entry.name, size: entry.size, pruned: removed.length });
    return entry;
  } catch (err) {
    onLog('warn', 'backup_failed', { error_message: (err as Error).message });
    return null;
  }
}

/** 今天是否已经备份过（启动时判断「当日首次」） */
export function hasBackupToday(dataDir: string, now: Date = new Date()): boolean {
  const name = backupNameFor(now);
  return listBackups(dataDir).some(b => b.name === name);
}
