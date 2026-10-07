#!/usr/bin/env node
/**
 * CLI：把库重置为**空白账本** —— 清掉账户与快照，保留现成的字典。用法 `npm run reset`
 *
 * 这是**破坏性**操作：账户、快照、盘点草稿、本位币变更史全部清掉且不可撤销。
 * 默认要求显式确认（照 `cli-seed.ts` 的模式）。
 *   npm run reset              打印影响范围与目标库路径，要求 --yes
 *   npm run reset -- --yes     直接执行
 *
 * 为什么需要它：首启会自动灌入演示数据（7 期快照 + 22 个账户）。想从零开始记
 * 自己的真实资产时，用它清掉演示数据 —— 币种 / 汇率 / 平台 / 分类 / 标签会保留，
 * 不必从空字典重建。库文件不存在时它顺带完成「建库 + 迁移 + 灌字典」，
 * 因此全新启用只需 `npm run reset -- --yes` 一条命令。
 */
import { loadEnv } from '../config/env.ts';
import { FIXTURE_FILE } from '../config/paths.ts';
import { closeDb, openDb } from './client.ts';
import { migrate } from './migrate.ts';
import { resetToDictionary } from './seed.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const env = loadEnv();
const file = flag('--file') ?? FIXTURE_FILE;

if (!args.includes('--yes')) {
  process.stderr.write(
    '\nreset 会清空全部账户与快照（含盘点草稿与本位币变更史），且**不可撤销**。\n' +
      '保留了币种 / 汇率 / 平台 / 分类 / 标签。\n\n' +
      `  目标库：${env.dbFile}\n` +
      `  建议先备份：cp "${env.dbFile}" "${env.dbFile}.bak"\n\n` +
      '确认后执行：npm run reset -- --yes\n\n'
  );
  process.exit(2);
}

const db = openDb(env.dbFile);
migrate(db.raw);
const stats = resetToDictionary(db.raw, file);
closeDb(db);

process.stdout.write(
  `\n已重置为空白账本（字典来源 ${stats.source}）\n` +
    `  保留：币种 ${stats.currencies} / 汇率 ${stats.rates} / 平台 ${stats.platforms} / ` +
    `分类 ${stats.categories} / 标签 ${stats.tags}\n` +
    `  清空：账户 / 快照 / 明细 / 盘点草稿 / 本位币变更史\n` +
    `  本位币已回到默认值（如需更改，在设置页操作）\n` +
    `  库文件：${env.dbFile}\n` +
    '\n  下一步：npm start —— 首启不会再灌入演示数据。\n\n'
);
