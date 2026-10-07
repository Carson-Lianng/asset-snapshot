#!/usr/bin/env node
/**
 * CLI：只执行迁移。用法 `npm run db:migrate`
 */
import { loadEnv } from '../config/env.ts';
import { closeDb, openDb } from './client.ts';
import { applyPragmas } from './client.ts';
import { currentVersion, migrate } from './migrate.ts';

const env = loadEnv();
const db = openDb(env.dbFile);
applyPragmas(db.raw);

const before = currentVersion(db.raw);
const res = migrate(db.raw);
const after = currentVersion(db.raw);

if (res.applied.length === 0) {
  process.stdout.write(`数据库已是最新版本（user_version = ${after}），无需迁移。\n`);
} else {
  process.stdout.write(
    `迁移完成：${before} → ${after}\n已应用：${res.applied.join(', ')}\n库文件：${env.dbFile}\n`
  );
}

closeDb(db);
