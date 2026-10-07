/**
 * 写入层（技术设计文档 §8.3 写路径 · §8.4 事务边界）
 *
 * 与 `repo.ts` 的分工：`repo.ts` 只读，本文件只写。两者遵守同一条纪律 ——
 * **只有这一层做 `Money ↔ INTEGER(微元)` 的转换**，上层只见领域形态。
 *
 * 为什么单独开一个文件而不是塞进 repo.ts：写入是 Step 4 新增的一整层，
 * 独立文件让「写路径引入了什么」在 diff 里一眼可见（迁移纪律要求每处改动可归因）。
 *
 * 事务：better-sqlite3 是同步 API，`db.raw.transaction(fn)()` 同步执行；
 * 多个写语句必须包在同一个 `tx()` 里，中途抛错由 SQLite 整体回滚。
 */
import { eq, inArray, sql } from 'drizzle-orm';
import {
  Money,
  type Account,
  type AccountType,
  type BaseCurrencyChange,
  type Category,
  type Platform,
  type Snapshot,
  type SnapshotItem,
  type Tag
} from '@app/domain';
import * as t from './schema.ts';
import type { Db } from './client.ts';

/* ============================================================
   通用
   ============================================================ */

/** 与 seed.ts 相同的时刻形态：`YYYY-MM-DD HH:mm:ss`（字典序即时序） */
export function nowIso(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 短 ID：前缀 + base36 时间戳 + 4 位随机，保证同毫秒内不撞 */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${prefix}-${ts}${rand}`;
}

/** 单事务执行。回调内任一步抛错 → 整体回滚。 */
export function tx<T>(db: Db, fn: () => T): T {
  return db.raw.transaction(fn)();
}

const micro = (m: Money | null | undefined): number | null =>
  m === null || m === undefined ? null : Number(m.toMicro());

/**
 * **元/比值 → 微元**。只用于「来源是领域形态」的地方：变更历史的 conversion_rate、
 * 快照汇率表（`ratesYuan`）。**API 入参不要用它** —— 那些已经是微元。
 */
const microNum = (n: number): number => Number(Money.fromNumber(n).toMicro());

/* ============================================================
   设置
   ============================================================ */

export function upsertSetting(db: Db, key: string, value: string): void {
  db.orm
    .insert(t.setting)
    .values({ key, value })
    .onConflictDoUpdate({ target: t.setting.key, set: { value } })
    .run();
}

/* ============================================================
   币种
   ============================================================ */

export function findCurrency(db: Db, code: string) {
  return db.orm.select().from(t.currency).where(eq(t.currency.code, code)).get() ?? null;
}

export function insertCurrency(db: Db, row: { code: string; name: string; symbol: string; sort: number; enabled: boolean }): void {
  db.orm.insert(t.currency).values(row).run();
}

export function updateCurrency(
  db: Db,
  code: string,
  patch: Partial<{ name: string; symbol: string; sort: number; enabled: boolean }>
): void {
  db.orm.update(t.currency).set(patch).where(eq(t.currency.code, code)).run();
}

export function deleteCurrency(db: Db, code: string): void {
  // exchange_rate 上有 ON DELETE CASCADE，汇率随币种一并清理
  db.orm.delete(t.currency).where(eq(t.currency.code, code)).run();
}

/**
 * 引用该币种的两处来源：**账户**（当前定义）与**快照明细**（历史事实）。
 *
 * 为什么不能只数账户：原型 `delCurrency` 的判定是
 * `accounts.some(a => a.currency === code) || snapshots.some(s => s.items.some(i => i.currency === code))`，
 * 设置页「使用中」那一列用的也是同一并集。只数账户会出现
 * 「界面上写着使用中＝是，点删却删掉了」的自相矛盾 —— 停用是唯一出口，这是 PRD 规则 12 的本意。
 */
export function currencyRefCount(db: Db, code: string): { accounts: number; snapshot_items: number } {
  const acc = db.orm
    .select({ n: sql<number>`COUNT(*)` })
    .from(t.account)
    .where(eq(t.account.currency, code))
    .get();
  const items = db.orm
    .select({ n: sql<number>`COUNT(*)` })
    .from(t.snapshotItem)
    .where(eq(t.snapshotItem.currency, code))
    .get();
  return { accounts: Number(acc?.n ?? 0), snapshot_items: Number(items?.n ?? 0) };
}

/* ============================================================
   汇率
   ============================================================ */

/** 写一条汇率（本位币自身固定为 1，由调用方保证） */
export function upsertRate(db: Db, code: string, rateMicro: number, updatedAt = nowIso()): void {
  db.orm
    .insert(t.exchangeRate)
    .values({ currencyCode: code, rateToBase: rateMicro, updatedAt })
    .onConflictDoUpdate({
      target: t.exchangeRate.currencyCode,
      set: { rateToBase: rateMicro, updatedAt }
    })
    .run();
}

/**
 * 批量更新汇率表（单事务）。
 *
 * ⚠ 这里的入参**已经是微元整数** —— `ratesPutSchema` 用的是 `microSchema`，
 * 边界上就要求 `z.number().int()`。写成 `microNum(value)` 会把 7.28 元
 * 变成 7.28×10¹²，是一条「看起来在换算、实际在二次放大」的静默错误
 * （Step 4 验收 F 组抓到过）。**凡是从 API 边界进来的金额/汇率，一律不再换算。**
 */
export function putRates(db: Db, rates: Record<string, number>, updatedAt = nowIso()): number {
  const entries = Object.entries(rates);
  tx(db, () => {
    for (const [code, value] of entries) {
      upsertRate(db, code, value, updatedAt);
    }
  });
  return entries.length;
}

export function insertBaseHistory(
  db: Db,
  row: BaseCurrencyChange & { id?: string }
): string {
  const id = row.id ?? newId('bch');
  db.orm
    .insert(t.baseCurrencyHistory)
    .values({
      id,
      fromCurrency: row.from_currency,
      toCurrency: row.to_currency,
      conversionRate: microNum(row.conversion_rate),
      changedAt: row.changed_at
    })
    .run();
  return id;
}

/* ============================================================
   平台 / 分类 / 标签
   ============================================================ */

export function findPlatform(db: Db, id: string): Platform | null {
  const r = db.orm.select().from(t.platform).where(eq(t.platform.id, id)).get();
  return r ? { id: r.id, name: r.name, type: r.type, note: r.note, sort: r.sort, enabled: r.enabled } : null;
}

export function insertPlatform(db: Db, row: Platform): void {
  db.orm.insert(t.platform).values(row).run();
}

export function updatePlatform(db: Db, id: string, patch: Partial<Omit<Platform, 'id'>>): void {
  db.orm.update(t.platform).set(patch).where(eq(t.platform.id, id)).run();
}

export function deletePlatform(db: Db, id: string): void {
  // account.platform_id 是 ON DELETE SET NULL，账户不会被连带删除（PRD 规则 6）
  db.orm.delete(t.platform).where(eq(t.platform.id, id)).run();
}

export function findCategory(db: Db, id: string): Category | null {
  const r = db.orm.select().from(t.category).where(eq(t.category.id, id)).get();
  return r
    ? {
        id: r.id,
        name: r.name,
        type: r.type as AccountType,
        default_track_principal: r.defaultTrackPrincipal,
        sort: r.sort,
        enabled: r.enabled
      }
    : null;
}

export function insertCategory(db: Db, row: Category): void {
  db.orm
    .insert(t.category)
    .values({
      id: row.id,
      name: row.name,
      type: row.type,
      defaultTrackPrincipal: row.default_track_principal,
      sort: row.sort,
      enabled: row.enabled
    })
    .run();
}

export function updateCategory(db: Db, id: string, patch: Partial<Omit<Category, 'id'>>): void {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.default_track_principal !== undefined) set.defaultTrackPrincipal = patch.default_track_principal;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (Object.keys(set).length) db.orm.update(t.category).set(set).where(eq(t.category.id, id)).run();
}

export function deleteCategory(db: Db, id: string): void {
  // account.category_id 是 REFERENCES category(id)（无 ON DELETE），
  // 被引用时由 SQLite 外键直接拒绝 —— 但调用方会先用 account_count 判 409，
  // 这里只作为最后一道防线。
  db.orm.delete(t.category).where(eq(t.category.id, id)).run();
}

export function findTag(db: Db, id: string): Tag | null {
  const r = db.orm.select().from(t.tag).where(eq(t.tag.id, id)).get();
  return r ? { id: r.id, name: r.name, sort: r.sort, enabled: r.enabled } : null;
}

export function insertTag(db: Db, row: Tag): void {
  db.orm.insert(t.tag).values(row).run();
}

export function updateTag(db: Db, id: string, patch: Partial<Omit<Tag, 'id'>>): void {
  db.orm.update(t.tag).set(patch).where(eq(t.tag.id, id)).run();
}

export function deleteTag(db: Db, id: string): void {
  db.orm.delete(t.tag).where(eq(t.tag.id, id)).run();
}

export function nextSort(db: Db, kind: SortableKind): number {
  const row = maxSortRow(db, kind);
  return Number(row ?? 0) + 1;
}

/**
 * 引用计数 —— 删除基础资料前的 409 判定（PRD 规则 12）。
 * 「被引用就不许删」比「删了以后明细变孤儿」对用户友好得多。
 *
 * **币种不走这里**：它要多数一处「快照明细」，见 `currencyRefCount`。
 * 刻意不在这里开一个 `'currency'` 分支 —— 同一个判定有两份实现，
 * 迟早会有一份先被改掉。
 */
export function refCount(
  db: Db,
  kind: 'platform' | 'category' | 'tag',
  id: string
): number {
  switch (kind) {
    case 'platform': {
      const r = db.orm
        .select({ n: sql<number>`COUNT(*)` })
        .from(t.account)
        .where(eq(t.account.platformId, id))
        .get();
      return Number(r?.n ?? 0);
    }
    case 'category': {
      const r = db.orm
        .select({ n: sql<number>`COUNT(*)` })
        .from(t.account)
        .where(eq(t.account.categoryId, id))
        .get();
      return Number(r?.n ?? 0);
    }
    case 'tag': {
      const r = db.orm
        .select({ n: sql<number>`COUNT(*)` })
        .from(t.accountTag)
        .where(eq(t.accountTag.tagId, id))
        .get();
      return Number(r?.n ?? 0);
    }
  }
}

/* ============================================================
   排序
   ============================================================ */

export type SortableKind = 'platform' | 'category' | 'tag' | 'currency' | 'account';

function maxSortRow(db: Db, kind: SortableKind): number | null {
  switch (kind) {
    case 'platform': {
      const r = db.orm.select({ v: sql<number>`MAX(${t.platform.sort})` }).from(t.platform).get();
      return r?.v ?? null;
    }
    case 'category': {
      const r = db.orm.select({ v: sql<number>`MAX(${t.category.sort})` }).from(t.category).get();
      return r?.v ?? null;
    }
    case 'tag': {
      const r = db.orm.select({ v: sql<number>`MAX(${t.tag.sort})` }).from(t.tag).get();
      return r?.v ?? null;
    }
    case 'currency': {
      const r = db.orm.select({ v: sql<number>`MAX(${t.currency.sort})` }).from(t.currency).get();
      return r?.v ?? null;
    }
    case 'account': {
      const r = db.orm.select({ v: sql<number>`MAX(${t.account.sort})` }).from(t.account).get();
      return r?.v ?? null;
    }
  }
}

/**
 * 批量排序：按给定 id 顺序把 sort 写成 1..n（单事务）。
 * 只影响列表顺序，不改任何业务字段。
 */
export function reorder(db: Db, kind: SortableKind, ids: readonly string[]): number {
  tx(db, () => {
    ids.forEach((id, i) => {
      const sort = i + 1;
      switch (kind) {
        case 'platform':
          db.orm.update(t.platform).set({ sort }).where(eq(t.platform.id, id)).run();
          break;
        case 'category':
          db.orm.update(t.category).set({ sort }).where(eq(t.category.id, id)).run();
          break;
        case 'tag':
          db.orm.update(t.tag).set({ sort }).where(eq(t.tag.id, id)).run();
          break;
        case 'currency':
          db.orm.update(t.currency).set({ sort }).where(eq(t.currency.code, id)).run();
          break;
        case 'account':
          db.orm.update(t.account).set({ sort }).where(eq(t.account.id, id)).run();
          break;
      }
    });
  });
  return ids.length;
}

/* ============================================================
   账户
   ============================================================ */

export interface AccountWriteInput {
  id: string;
  name: string;
  platform_id: string | null;
  category_id: string;
  type: AccountType;
  currency: string;
  note: string;
  include_in_net_worth: boolean;
  track_principal: boolean;
  sort: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export function insertAccount(db: Db, a: AccountWriteInput, tags: readonly string[]): void {
  tx(db, () => {
    db.orm
      .insert(t.account)
      .values({
        id: a.id,
        name: a.name,
        platformId: a.platform_id,
        categoryId: a.category_id,
        type: a.type,
        currency: a.currency,
        note: a.note,
        includeInNetWorth: a.include_in_net_worth,
        trackPrincipal: a.track_principal,
        sort: a.sort,
        archived: a.archived,
        createdAt: a.created_at,
        updatedAt: a.updated_at
      })
      .run();
    replaceAccountTags(db, a.id, tags);
  });
}

export function updateAccount(db: Db, id: string, patch: Partial<Omit<AccountWriteInput, 'id' | 'created_at'>>): void {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.platform_id !== undefined) set.platformId = patch.platform_id;
  if (patch.category_id !== undefined) set.categoryId = patch.category_id;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.currency !== undefined) set.currency = patch.currency;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.include_in_net_worth !== undefined) set.includeInNetWorth = patch.include_in_net_worth;
  if (patch.track_principal !== undefined) set.trackPrincipal = patch.track_principal;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.archived !== undefined) set.archived = patch.archived;
  set.updatedAt = patch.updated_at ?? nowIso();
  db.orm.update(t.account).set(set).where(eq(t.account.id, id)).run();
}

/**
 * 删除账户。
 *
 * 历史快照**不受影响** —— `snapshot_item.account_id` 刻意没有外键（PRD 规则 6），
 * 明细靠 `account_name_snapshot` 等冗余字段自洽。
 */
export function deleteAccount(db: Db, id: string): void {
  tx(db, () => {
    db.orm.delete(t.accountTag).where(eq(t.accountTag.accountId, id)).run();
    db.orm.delete(t.account).where(eq(t.account.id, id)).run();
  });
}

export function replaceAccountTags(db: Db, id: string, tagIds: readonly string[]): void {
  db.orm.delete(t.accountTag).where(eq(t.accountTag.accountId, id)).run();
  for (const tagId of tagIds) {
    db.orm.insert(t.accountTag).values({ accountId: id, tagId }).run();
  }
}

/** 该账户是否有明细引用（仅用于提示，不阻止删除） */
export function accountItemCount(db: Db, id: string): number {
  const row = db.orm
    .select({ n: sql<number>`COUNT(*)` })
    .from(t.snapshotItem)
    .where(eq(t.snapshotItem.accountId, id))
    .get();
  return Number(row?.n ?? 0);
}

/* ============================================================
   盘点草稿（全局唯一一行，ADR-10 乐观锁）
   ============================================================ */

export interface DraftRow {
  version: number;
  data: unknown;
  updated_at: string;
}

export function getDraft(db: Db): DraftRow | null {
  const r = db.orm.select().from(t.inventoryDraft).where(eq(t.inventoryDraft.id, 'current')).get();
  return r ? { version: r.version, data: r.data, updated_at: r.updatedAt } : null;
}

/**
 * 写入草稿。
 *
 * `expectedVersion` 为 null 表示「允许覆盖任何版本」（首次创建）；
 * 否则必须与库中版本相等，否则抛 409 —— 防多标签页互相覆盖（ADR-10）。
 * 返回新的版本号。
 */
export function putDraft(db: Db, data: unknown, expectedVersion: number | null): number {
  const cur = getDraft(db);
  if (cur && expectedVersion !== null && cur.version !== expectedVersion) {
    return -1; // 由调用方转成 409（此处不抛，保持本层无 HTTP 语义）
  }
  const next = (cur?.version ?? 0) + 1;
  const updatedAt = nowIso();
  if (cur) {
    db.orm
      .update(t.inventoryDraft)
      .set({ version: next, data, updatedAt })
      .where(eq(t.inventoryDraft.id, 'current'))
      .run();
  } else {
    db.orm.insert(t.inventoryDraft).values({ id: 'current', version: next, data, updatedAt }).run();
  }
  return next;
}

export function deleteDraft(db: Db): void {
  db.orm.delete(t.inventoryDraft).where(eq(t.inventoryDraft.id, 'current')).run();
}

/* ============================================================
   快照
   ============================================================ */

/** 下一个可用的 `snap-<n>`（沿用演示数据的编号风格） */
export function nextSnapshotId(db: Db): string {
  const rows = db.orm.select({ id: t.snapshot.id }).from(t.snapshot).all();
  let max = 0;
  for (const r of rows) {
    const m = /^snap-(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let candidate = `snap-${max + 1}`;
  const taken = new Set(rows.map(r => r.id));
  while (taken.has(candidate)) {
    max++;
    candidate = `snap-${max + 1}`;
  }
  return candidate;
}

/**
 * 保存快照（单事务）。
 *
 * 三个汇总列由调用方按**冻结口径**传入（即 `planItems` + `inventoryTotals` 算出的值），
 * 本层只负责落库，绝不重算 —— 重算会随汇率表变化漂移（PRD 规则 3 / 4）。
 *
 * `items` 的 `id` 用与演示数据一致的 `si-<snapshotId>-<accountId>` 形态，
 * 由领域层的 `toSnapshotItems` 生成，这里不重新发明。
 */
export function insertSnapshotTx(
  db: Db,
  snap: Pick<Snapshot, 'id' | 'date' | 'note' | 'base_currency' | 'created_at'> & {
    total_assets: Money;
    total_liabilities: Money;
    net_worth: Money;
  },
  items: readonly SnapshotItem[],
  rates: Record<string, number>
): void {
  tx(db, () => {
    db.orm
      .insert(t.snapshot)
      .values({
        id: snap.id,
        date: snap.date,
        note: snap.note,
        baseCurrency: snap.base_currency,
        totalAssets: micro(snap.total_assets) ?? 0,
        totalLiabilities: micro(snap.total_liabilities) ?? 0,
        netWorth: micro(snap.net_worth) ?? 0,
        createdAt: snap.created_at
      })
      .run();

    for (const [code, rate] of Object.entries(rates)) {
      db.orm
        .insert(t.snapshotRate)
        .values({ snapshotId: snap.id, currency: code, rateToBase: microNum(rate) })
        .run();
    }

    for (const it of items) {
      db.orm
        .insert(t.snapshotItem)
        .values({
          id: it.id,
          snapshotId: snap.id,
          accountId: it.account_id || null,
          accountNameSnapshot: it.account_name_snapshot,
          platformIdSnapshot: it.platform_id_snapshot,
          platformNameSnapshot: it.platform_name_snapshot,
          categoryIdSnapshot: it.category_id_snapshot,
          categoryNameSnapshot: it.category_name_snapshot,
          type: it.type,
          currency: it.currency,
          originalAmount: micro(it.original_amount) ?? 0,
          exchangeRate: micro(it.exchange_rate) ?? 0,
          amountInBase: micro(it.amount_in_base) ?? 0,
          includeInNetWorth: it.include_in_net_worth,
          tracksPrincipal: it.tracks_principal,
          principal: micro(it.principal),
          principalInBase: micro(it.principal_in_base),
          isCarriedOver: it.is_carried_over,
          tagsSnapshot: it.tags_snapshot,
          sort: it.sort
        })
        .run();
    }
  });
}

export function findSnapshotRow(db: Db, id: string) {
  return db.orm.select().from(t.snapshot).where(eq(t.snapshot.id, id)).get() ?? null;
}

export function deleteSnapshot(db: Db, id: string): void {
  tx(db, () => {
    // 明细与汇率有 ON DELETE CASCADE，但显式删除更清楚，也不依赖 PRAGMA 状态
    db.orm.delete(t.snapshotItem).where(eq(t.snapshotItem.snapshotId, id)).run();
    db.orm.delete(t.snapshotRate).where(eq(t.snapshotRate.snapshotId, id)).run();
    db.orm.delete(t.snapshot).where(eq(t.snapshot.id, id)).run();
  });
}

/**
 * 上一次录入的金额（「沿用上次」的原料）。
 *
 * 返回**微元整数**（与传输形态一致，前端在边界还原）—— 读的就是 INTEGER 列，
 * 这里不做任何换算，避免在无意中引入一次 元↔微元 的往返。
 * 排序按「日期升序 → 创建时刻升序」，因此后写的覆盖先写的，最终留下的是最后一次。
 */
export function lastAmountsByAccount(db: Db): Record<string, number> {
  const rows = db.orm
    .select({ accountId: t.snapshotItem.accountId, amount: t.snapshotItem.originalAmount })
    .from(t.snapshotItem)
    .innerJoin(t.snapshot, eq(t.snapshot.id, t.snapshotItem.snapshotId))
    .orderBy(t.snapshot.date, t.snapshot.createdAt)
    .all();

  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.accountId) out[r.accountId] = Number(r.amount);
  }
  return out;
}

/**
 * 上一次录入的本金（「沿用上次」的另一半原料）。
 *
 * 与 `lastAmountsByAccount` 同序同源，但**保留 null**：原型 `invFresh()` 取的是
 * 「最近一期含该账户的快照」里的 `principal`，那一期没填本金就是 null，
 * 不能沿用更早的期数 —— 否则会把用户明确清空过的本金又找回来。
 */
export function lastPrincipalsByAccount(db: Db): Record<string, number | null> {
  const rows = db.orm
    .select({ accountId: t.snapshotItem.accountId, principal: t.snapshotItem.principal })
    .from(t.snapshotItem)
    .innerJoin(t.snapshot, eq(t.snapshot.id, t.snapshotItem.snapshotId))
    .orderBy(t.snapshot.date, t.snapshot.createdAt)
    .all();

  const out: Record<string, number | null> = {};
  for (const r of rows) {
    if (r.accountId) out[r.accountId] = r.principal === null ? null : Number(r.principal);
  }
  return out;
}

/** 批量按 id 取账户（草稿校验用） */
export function accountsByIds(db: Db, ids: readonly string[]) {
  if (!ids.length) return [];
  return db.orm.select().from(t.account).where(inArray(t.account.id, [...ids])).all();
}
