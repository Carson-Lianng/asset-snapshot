/**
 * 仓储层 —— 唯一做 `Money ↔ INTEGER(微元)` 转换的地方（技术设计文档 §5.5 第 2 条）
 *
 * 上层（Service / Route）只见领域形态与 Money，永远看不到定点整数。
 */
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  Money,
  type Account,
  type AccountType,
  type BaseCurrencyChange,
  type Category,
  type Currency,
  type Platform,
  type Snapshot,
  type SnapshotItem,
  type SnapshotSeries,
  type Tag,
  type TagSnapshot
} from '@app/domain';
import * as t from './schema.ts';
import type { Db } from './client.ts';

export const moneyOf = (micro: number | null | undefined): Money | null =>
  micro === null || micro === undefined ? null : Money.fromMicro(BigInt(micro));

export const moneyReq = (micro: number): Money => Money.fromMicro(BigInt(micro));

/** 微元整数 → 「元」的 number（仅用于领域层要求 number 的场合，如 rates） */
const yuan = (micro: number): number => Number(micro) / 1_000_000;

/* ============================================================
   设置 / 币种 / 汇率
   ============================================================ */

export function getSettings(db: Db): Record<string, string> {
  const rows = db.orm.select().from(t.setting).all();
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function getBaseCurrency(db: Db): string {
  const row = db.orm.select().from(t.setting).where(eq(t.setting.key, 'base_currency')).get();
  return row?.value ?? 'CNY';
}

export interface CurrencyRow extends Currency {
  rate_to_base_micro: number | null;
  rate_updated_at: string | null;
}

export function listCurrencies(db: Db): CurrencyRow[] {
  const rows = db.orm
    .select({
      code: t.currency.code,
      name: t.currency.name,
      symbol: t.currency.symbol,
      sort: t.currency.sort,
      enabled: t.currency.enabled,
      rate: t.exchangeRate.rateToBase,
      updatedAt: t.exchangeRate.updatedAt
    })
    .from(t.currency)
    .leftJoin(t.exchangeRate, eq(t.exchangeRate.currencyCode, t.currency.code))
    .orderBy(asc(t.currency.sort), asc(t.currency.code))
    .all();

  return rows.map(r => ({
    code: r.code,
    name: r.name,
    symbol: r.symbol,
    sort: r.sort,
    enabled: r.enabled,
    rate_to_base_micro: r.rate ?? null,
    rate_updated_at: r.updatedAt ?? null
  }));
}

export function listBaseHistory(db: Db): BaseCurrencyChange[] {
  return db.orm
    .select()
    .from(t.baseCurrencyHistory)
    .orderBy(asc(t.baseCurrencyHistory.changedAt))
    .all()
    .map(r => ({
      from_currency: r.fromCurrency,
      to_currency: r.toCurrency,
      conversion_rate: yuan(r.conversionRate),
      changed_at: r.changedAt
    }));
}

export function listBaseHistoryRows(db: Db) {
  return db.orm
    .select()
    .from(t.baseCurrencyHistory)
    .orderBy(asc(t.baseCurrencyHistory.changedAt))
    .all();
}

/* ============================================================
   基础资料（含引用计数，供删除前的 409 判定）
   ============================================================ */

export function listPlatforms(db: Db): Array<Platform & { account_count: number }> {
  const counts = countMap(db, t.account.platformId);
  return db.orm
    .select()
    .from(t.platform)
    .orderBy(asc(t.platform.sort), asc(t.platform.name))
    .all()
    .map(r => ({
      id: r.id, name: r.name, type: r.type, note: r.note,
      sort: r.sort, enabled: r.enabled,
      account_count: counts.get(r.id) ?? 0
    }));
}

export function listCategories(db: Db): Array<Category & { account_count: number }> {
  const counts = countMap(db, t.account.categoryId);
  return db.orm
    .select()
    .from(t.category)
    .orderBy(asc(t.category.type), asc(t.category.sort), asc(t.category.name))
    .all()
    .map(r => ({
      id: r.id, name: r.name, type: r.type as AccountType,
      default_track_principal: r.defaultTrackPrincipal,
      sort: r.sort, enabled: r.enabled,
      account_count: counts.get(r.id) ?? 0
    }));
}

export function listTags(db: Db): Array<Tag & { account_count: number }> {
  const rows = db.orm
    .select({ tagId: t.accountTag.tagId, n: sql<number>`COUNT(*)` })
    .from(t.accountTag)
    .groupBy(t.accountTag.tagId)
    .all();
  const counts = new Map(rows.map(r => [r.tagId, r.n]));
  return db.orm
    .select()
    .from(t.tag)
    .orderBy(asc(t.tag.sort), asc(t.tag.name))
    .all()
    .map(r => ({
      id: r.id, name: r.name, sort: r.sort, enabled: r.enabled,
      account_count: counts.get(r.id) ?? 0
    }));
}

function countMap(db: Db, column: AnySQLiteColumn): Map<string, number> {
  const rows = db.orm
    .select({ key: column, n: sql<number>`COUNT(*)` })
    .from(t.account)
    .groupBy(column)
    .all();
  const m = new Map<string, number>();
  for (const r of rows) if (r.key !== null) m.set(r.key, r.n);
  return m;
}

/* ============================================================
   账户
   ============================================================ */

export interface AccountFilter {
  platform_id?: string;
  category_id?: string;
  tag_id?: string;
  archived?: boolean;
  q?: string;
}

export function listAccounts(db: Db, filter: AccountFilter = {}): Account[] {
  const where = [];
  if (filter.platform_id) where.push(eq(t.account.platformId, filter.platform_id));
  if (filter.category_id) where.push(eq(t.account.categoryId, filter.category_id));
  if (filter.archived !== undefined) where.push(eq(t.account.archived, filter.archived));
  if (filter.tag_id) {
    where.push(
      sql`EXISTS (SELECT 1 FROM account_tag at WHERE at.account_id = ${t.account.id} AND at.tag_id = ${filter.tag_id})`
    );
  }
  if (filter.q) {
    const like = `%${filter.q}%`;
    where.push(sql`(${t.account.name} LIKE ${like} OR ${t.account.note} LIKE ${like})`);
  }

  const base = db.orm.select().from(t.account);
  const rows = (where.length ? base.where(and(...where)) : base)
    .orderBy(asc(t.account.sort), asc(t.account.id))
    .all();

  const tagRows = rows.length
    ? db.orm
        .select()
        .from(t.accountTag)
        .where(inArray(t.accountTag.accountId, rows.map(r => r.id)))
        .all()
    : [];
  const byAccount = new Map<string, string[]>();
  for (const r of tagRows) {
    const list = byAccount.get(r.accountId) ?? [];
    list.push(r.tagId);
    byAccount.set(r.accountId, list);
  }

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    platform_id: r.platformId,
    category_id: r.categoryId,
    type: r.type as AccountType,
    currency: r.currency,
    tags: byAccount.get(r.id) ?? [],
    note: r.note,
    include_in_net_worth: r.includeInNetWorth,
    track_principal: r.trackPrincipal,
    sort: r.sort,
    archived: r.archived,
    created_at: r.createdAt,
    updated_at: r.updatedAt
  }));
}

/* ============================================================
   快照
   ============================================================ */

export interface SnapshotCounts {
  item_count: number;
  carried_over: number;
  tracked: number;
  no_principal: number;
}

export function snapshotCounts(db: Db): Map<string, SnapshotCounts> {
  const rows = db.orm
    .select({
      snapshotId: t.snapshotItem.snapshotId,
      itemCount: sql<number>`COUNT(*)`,
      carriedOver: sql<number>`SUM(${t.snapshotItem.isCarriedOver})`,
      tracked: sql<number>`SUM(${t.snapshotItem.tracksPrincipal})`,
      noPrincipal: sql<number>`SUM(CASE WHEN ${t.snapshotItem.tracksPrincipal} = 1 AND ${t.snapshotItem.principal} IS NULL THEN 1 ELSE 0 END)`
    })
    .from(t.snapshotItem)
    .groupBy(t.snapshotItem.snapshotId)
    .all();

  return new Map(
    rows.map(r => [
      r.snapshotId,
      {
        item_count: Number(r.itemCount),
        carried_over: Number(r.carriedOver ?? 0),
        tracked: Number(r.tracked ?? 0),
        no_principal: Number(r.noPrincipal ?? 0)
      }
    ])
  );
}

/** 快照元信息（不含明细），按时间升序 */
export function listSnapshotMeta(db: Db, range: { from?: string; to?: string } = {}) {
  const where = [];
  if (range.from) where.push(gte(t.snapshot.date, range.from));
  if (range.to) where.push(lte(t.snapshot.date, range.to));
  const base = db.orm.select().from(t.snapshot);
  return (where.length ? base.where(and(...where)) : base)
    .orderBy(asc(t.snapshot.date), asc(t.snapshot.createdAt), asc(t.snapshot.id))
    .all();
}

export function loadSeries(db: Db): SnapshotSeries {
  const metas = listSnapshotMeta(db);
  if (metas.length === 0) return { snapshots: [] };

  const ids = metas.map(m => m.id);
  const itemRows = db.orm
    .select()
    .from(t.snapshotItem)
    .where(inArray(t.snapshotItem.snapshotId, ids))
    .orderBy(asc(t.snapshotItem.snapshotId), asc(t.snapshotItem.sort), asc(t.snapshotItem.id))
    .all();

  const rateRows = db.orm
    .select()
    .from(t.snapshotRate)
    .where(inArray(t.snapshotRate.snapshotId, ids))
    .all();

  const itemsBySnap = new Map<string, SnapshotItem[]>();
  for (const r of itemRows) {
    const list = itemsBySnap.get(r.snapshotId) ?? [];
    list.push(toItem(r));
    itemsBySnap.set(r.snapshotId, list);
  }
  const ratesBySnap = new Map<string, Record<string, number>>();
  for (const r of rateRows) {
    const rec = ratesBySnap.get(r.snapshotId) ?? {};
    rec[r.currency] = yuan(r.rateToBase);
    ratesBySnap.set(r.snapshotId, rec);
  }

  const snapshots: Snapshot[] = metas.map(m => ({
    id: m.id,
    date: m.date,
    note: m.note,
    base_currency: m.baseCurrency,
    rates: ratesBySnap.get(m.id) ?? {},
    total_assets: moneyReq(m.totalAssets),
    total_liabilities: moneyReq(m.totalLiabilities),
    net_worth: moneyReq(m.netWorth),
    created_at: m.createdAt,
    items: itemsBySnap.get(m.id) ?? []
  }));

  return { snapshots };
}

export type ItemRow = typeof t.snapshotItem.$inferSelect;

export function toItem(r: ItemRow): SnapshotItem {
  return {
    id: r.id,
    snapshot_id: r.snapshotId,
    account_id: r.accountId ?? '',
    account_name_snapshot: r.accountNameSnapshot,
    platform_id_snapshot: r.platformIdSnapshot ?? null,
    platform_name_snapshot: r.platformNameSnapshot ?? '',
    category_id_snapshot: r.categoryIdSnapshot,
    category_name_snapshot: r.categoryNameSnapshot,
    type: r.type as AccountType,
    currency: r.currency,
    original_amount: moneyReq(r.originalAmount),
    exchange_rate: moneyReq(r.exchangeRate),
    amount_in_base: moneyReq(r.amountInBase),
    include_in_net_worth: r.includeInNetWorth,
    tracks_principal: r.tracksPrincipal,
    principal: moneyOf(r.principal),
    principal_in_base: moneyOf(r.principalInBase),
    is_carried_over: r.isCarriedOver,
    tags_snapshot: (r.tagsSnapshot ?? []) as TagSnapshot[],
    sort: r.sort
  };
}

export function findSnapshot(db: Db, id: string): Snapshot | null {
  return loadSeries(db).snapshots.find(s => s.id === id) ?? null;
}

/** 币种元信息查询器（供 platformCurrencyBreakdown / currencyBreakdown 使用） */
export function currencyMetaLookup(db: Db): (code: string) => { name: string; symbol: string } {
  const rows = db.orm.select().from(t.currency).all();
  const m = new Map(rows.map(r => [r.code, { name: r.name, symbol: r.symbol }]));
  return (code: string) => m.get(code) ?? { name: code, symbol: '' };
}

function tableCount(db: Db, table: CountableTable): number {
  const row = db.orm.select({ n: sql<number>`COUNT(*)` }).from(table).get();
  return Number(row?.n ?? 0);
}

/** 需要统计行数的表：用精确联合而不是宽泛基类，避免类型断言 */
type CountableTable =
  | typeof t.currency | typeof t.platform | typeof t.category
  | typeof t.tag | typeof t.account | typeof t.snapshot;

export function tableCounts(db: Db): {
  currencies: number; platforms: number; categories: number;
  tags: number; accounts: number; snapshots: number;
} {
  return {
    currencies: tableCount(db, t.currency),
    platforms: tableCount(db, t.platform),
    categories: tableCount(db, t.category),
    tags: tableCount(db, t.tag),
    accounts: tableCount(db, t.account),
    snapshots: tableCount(db, t.snapshot)
  };
}
