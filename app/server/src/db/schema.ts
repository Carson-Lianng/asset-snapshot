/**
 * Drizzle schema —— 13 张表的类型镜像（技术设计文档 §6.2）
 *
 * 约定：
 *   - 金额 / 汇率 / 本金列一律 `INTEGER`，单位微元（×10^6）。JS number 在 9.007e15
 *     以内精确，微元上限 90 亿元，安全。
 *   - `date` / `datetime` 用 TEXT（`YYYY-MM-DD` / ISO-8601），字典序即时序，
 *     外部工具直接打开 .sqlite 也可读 —— 符合「数据本地可控」的定位。
 *   - CHECK 约束与索引写在 `migrations/0001_init.sql`：迁移是权威 DDL，
 *     本文件是它的 TypeScript 镜像，仅用于类型推导与查询构造。
 */
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
});

export const currency = sqliteTable('currency', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  symbol: text('symbol').notNull(),
  sort: integer('sort').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true)
});

export const exchangeRate = sqliteTable('exchange_rate', {
  currencyCode: text('currency_code').primaryKey(),
  rateToBase: integer('rate_to_base').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const baseCurrencyHistory = sqliteTable('base_currency_history', {
  id: text('id').primaryKey(),
  fromCurrency: text('from_currency').notNull(),
  toCurrency: text('to_currency').notNull(),
  conversionRate: integer('conversion_rate').notNull(),
  changedAt: text('changed_at').notNull()
});

export const platform = sqliteTable('platform', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().default('other'),
  note: text('note').notNull().default(''),
  sort: integer('sort').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true)
});

export const category = sqliteTable('category', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  defaultTrackPrincipal: integer('default_track_principal', { mode: 'boolean' }).notNull().default(false),
  sort: integer('sort').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true)
});

export const tag = sqliteTable('tag', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true)
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platformId: text('platform_id'),
  categoryId: text('category_id').notNull(),
  type: text('type').notNull(),
  currency: text('currency').notNull(),
  note: text('note').notNull().default(''),
  includeInNetWorth: integer('include_in_net_worth', { mode: 'boolean' }).notNull().default(true),
  trackPrincipal: integer('track_principal', { mode: 'boolean' }).notNull().default(false),
  sort: integer('sort').notNull().default(0),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const accountTag = sqliteTable('account_tag', {
  accountId: text('account_id').notNull(),
  tagId: text('tag_id').notNull()
}, t => [primaryKey({ columns: [t.accountId, t.tagId] })]);

export const snapshot = sqliteTable('snapshot', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  note: text('note').notNull().default(''),
  baseCurrency: text('base_currency').notNull(),
  totalAssets: integer('total_assets').notNull(),
  totalLiabilities: integer('total_liabilities').notNull(),
  netWorth: integer('net_worth').notNull(),
  createdAt: text('created_at').notNull()
});

export const snapshotItem = sqliteTable('snapshot_item', {
  id: text('id').primaryKey(),
  snapshotId: text('snapshot_id').notNull(),
  /** 仅作参考：账户删除后置空，历史展示完全依赖下方冗余字段 */
  accountId: text('account_id'),
  accountNameSnapshot: text('account_name_snapshot').notNull(),
  platformIdSnapshot: text('platform_id_snapshot'),
  platformNameSnapshot: text('platform_name_snapshot'),
  categoryIdSnapshot: text('category_id_snapshot').notNull(),
  categoryNameSnapshot: text('category_name_snapshot').notNull(),
  type: text('type').notNull(),
  currency: text('currency').notNull(),
  originalAmount: integer('original_amount').notNull(),
  exchangeRate: integer('exchange_rate').notNull(),
  amountInBase: integer('amount_in_base').notNull(),
  includeInNetWorth: integer('include_in_net_worth', { mode: 'boolean' }).notNull(),
  tracksPrincipal: integer('tracks_principal', { mode: 'boolean' }).notNull().default(false),
  principal: integer('principal'),
  principalInBase: integer('principal_in_base'),
  isCarriedOver: integer('is_carried_over', { mode: 'boolean' }).notNull().default(false),
  tagsSnapshot: text('tags_snapshot', { mode: 'json' }).notNull().$type<Array<{ id: string; name: string }>>().default([]),
  sort: integer('sort').notNull().default(0)
});

export const snapshotRate = sqliteTable('snapshot_rate', {
  snapshotId: text('snapshot_id').notNull(),
  currency: text('currency').notNull(),
  rateToBase: integer('rate_to_base').notNull()
}, t => [primaryKey({ columns: [t.snapshotId, t.currency] })]);

/**
 * 盘点草稿：全局唯一一行（id 恒为 'current'）。
 * `version` 做乐观锁，防多标签页覆盖（ADR-10）。
 */
export const inventoryDraft = sqliteTable('inventory_draft', {
  id: text('id').primaryKey(),
  version: integer('version').notNull().default(1),
  data: text('data', { mode: 'json' }).notNull().$type<unknown>(),
  updatedAt: text('updated_at').notNull()
});
