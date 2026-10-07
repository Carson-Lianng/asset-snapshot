#!/usr/bin/env node
/**
 * CLI：把演示数据（或指定文件）导入库。用法 `npm run db:seed`
 *
 * 这是**破坏性**操作：会清空全部业务表。默认要求显式确认。
 *   npm run db:seed -- --yes            使用 app/fixtures/demo-seed.json
 *   npm run db:seed -- --file xxx.json --yes
 */
import { loadEnv } from '../config/env.ts';
import { FIXTURE_FILE } from '../config/paths.ts';
import { closeDb, openDb } from './client.ts';
import { migrate } from './migrate.ts';
import { seedFromFixture } from './seed.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!args.includes('--yes')) {
  process.stderr.write(
    '种子导入会清空当前数据库的全部业务表。确认请追加 --yes。\n' +
      '例：npm run db:seed -- --yes\n'
  );
  process.exit(2);
}

const env = loadEnv();
const file = flag('--file') ?? FIXTURE_FILE;

const db = openDb(env.dbFile);
migrate(db.raw);
const stats = seedFromFixture(db.raw, file);
closeDb(db);

process.stdout.write(
  `种子导入完成（来源 ${stats.source}）\n` +
    `  币种 ${stats.currencies} / 汇率 ${stats.rates} / 平台 ${stats.platforms} / ` +
    `分类 ${stats.categories} / 标签 ${stats.tags} / 账户 ${stats.accounts}\n` +
    `  快照 ${stats.snapshots} / 明细 ${stats.snapshot_items} / 快照汇率 ${stats.snapshot_rates}\n`
);
