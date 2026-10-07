/**
 * 迁移机制（技术设计文档 §6.3）
 *
 *   - 版本号用 SQLite 内置的 `PRAGMA user_version`，不引入额外元数据表。
 *   - 文件命名 `0001_init.sql`，按序号顺序执行，只应用「未应用」的部分。
 *   - **每个迁移文件是一个独立事务**：任一步失败即回滚并以非零码退出，
 *     绝不带着半迁移的库继续跑。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, 'migrations');

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter(f => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const list = files.map(f => ({
    version: Number(f.slice(0, 4)),
    name: f,
    sql: readFileSync(join(dir, f), 'utf8')
  }));
  for (let i = 0; i < list.length; i++) {
    if (list[i].version !== i + 1) {
      throw new Error(`迁移序号不连续：期望 ${i + 1}，实际 ${list[i].version}（${list[i].name}）`);
    }
  }
  return list;
}

export function currentVersion(raw: Database.Database): number {
  const row = raw.pragma('user_version') as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

/**
 * 顺序应用未执行的迁移。返回最终版本号。
 * 幂等：已是最新版本时不做任何写入。
 */
export function migrate(raw: Database.Database, dir: string = MIGRATIONS_DIR): { from: number; to: number; applied: string[] } {
  const all = loadMigrations(dir);
  const from = currentVersion(raw);
  const applied: string[] = [];

  for (const m of all) {
    if (m.version <= from) continue;
    raw.exec('BEGIN');
    try {
      raw.exec(m.sql);
      // user_version 的赋值本身也是事务性写入
      raw.pragma(`user_version = ${m.version}`);
      raw.exec('COMMIT');
      applied.push(m.name);
    } catch (err) {
      raw.exec('ROLLBACK');
      throw new Error(
        `迁移 ${m.name} 执行失败，已回滚（库仍处于版本 ${currentVersion(raw)}）：${(err as Error).message}`
      );
    }
  }

  return { from, to: currentVersion(raw), applied };
}

/** 是否已具备业务表（用于就绪探针与首启判断） */
export function isInitialized(raw: Database.Database): boolean {
  const row = raw
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'snapshot'")
    .get() as { n: number };
  return row.n > 0;
}
