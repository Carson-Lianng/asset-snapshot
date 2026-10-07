/**
 * 数据库连接（技术设计文档 §6.5）
 *
 * better-sqlite3 的同步 API 在单进程本机场景最简单也最快，且自带在线备份 API。
 * PRAGMA 必须在打开连接后立即设置 —— 尤其 `foreign_keys`，SQLite 默认为 **关**。
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export interface Db {
  raw: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
}

export function openDb(file: string): Db {
  const raw = new Database(file);
  applyPragmas(raw);
  const orm = drizzle(raw, { schema });
  return { raw, orm };
}

/**
 * **只读**打开一个 sqlite 文件（读备份文件用）。
 *
 * 刻意不调 `applyPragmas`：`journal_mode = WAL` 会**改写备份文件本身**
 * （生成 `-wal` / `-shm`），而我们只是要把它读出来恢复。
 * 备份件应当保持原样 —— 它是用户手里那份「出事时能退回」的东西。
 */
export function openReadonly(file: string): Db {
  const raw = new Database(file, { readonly: true, fileMustExist: true });
  const orm = drizzle(raw, { schema });
  return { raw, orm };
}

export function applyPragmas(raw: Database.Database): void {
  // 读写并发：盘点过程中查询不会被写事务阻塞
  raw.pragma('journal_mode = WAL');
  // 外键约束默认是关的，必须显式打开，否则 0001_init.sql 里的 REFERENCES 形同注释
  raw.pragma('foreign_keys = ON');
  // WAL 下的安全 / 性能平衡点
  raw.pragma('synchronous = NORMAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('temp_store = MEMORY');
}

export function closeDb(db: Db): void {
  try {
    db.raw.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* 关闭前尽力收敛 WAL，失败不影响关闭 */
  }
  db.raw.close();
}
