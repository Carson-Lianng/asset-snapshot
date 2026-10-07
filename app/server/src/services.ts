/**
 * Service 层 —— 业务规则与派生指标组装（技术设计文档 §3.2）
 *
 * 这一层只做三件事：取数（Repository）、调口径（@app/domain）、组装结果。
 * 不碰 HTTP Request/Response，也不写 SQL。
 */
import {
  breakdown,
  compareSnapshots,
  currencyBreakdown,
  dailySeries,
  itemValueIn,
  lastSnapshot,
  makeFxContext,
  platformCurrencyBreakdown,
  prevItemOf,
  returnsBreakdown,
  returnsOf,
  returnsPanel,
  seriesOf,
  snapTotalsIn,
  sortDesc,
  type BreakdownRow,
  type CompareResult,
  type CurrencyRow,
  type Dim,
  type FxContext,
  type PlatformCurrencyRow,
  type ReturnMetrics,
  type ReturnsBreakdownRow,
  type ReturnsPanel,
  type Snapshot,
  type SnapshotItem,
  type SnapshotSeries,
  type TotalsIn,
  type ViewMode
} from '@app/domain';
import type { Db } from './db/client.ts';
import * as repo from './db/repo.ts';
import { fail } from './lib/errors.ts';

/* ============================================================
   上下文
   ============================================================ */

export interface QueryContext {
  baseCurrency: string;
  ctx: FxContext;
}

export function queryContext(db: Db): QueryContext {
  const baseCurrency = repo.getBaseCurrency(db);
  return { baseCurrency, ctx: makeFxContext(baseCurrency, repo.listBaseHistory(db)) };
}

export function loadSeries(db: Db): SnapshotSeries {
  return repo.loadSeries(db);
}

function requireSnapshot(series: SnapshotSeries, id: string): Snapshot {
  const s = series.snapshots.find(x => x.id === id);
  if (!s) throw fail.notFound(`快照不存在：${id}`);
  return s;
}

/* ============================================================
   基础资料
   ============================================================ */

export function platformService(db: Db, includeDisabled: boolean) {
  const all = repo.listPlatforms(db);
  return includeDisabled ? all : all.filter(p => p.enabled);
}

export function categoryService(db: Db, includeDisabled: boolean) {
  const all = repo.listCategories(db);
  return includeDisabled ? all : all.filter(c => c.enabled);
}

export function tagService(db: Db, includeDisabled: boolean) {
  const all = repo.listTags(db);
  return includeDisabled ? all : all.filter(t => t.enabled);
}

export function currencyService(db: Db, includeDisabled: boolean) {
  const all = repo.listCurrencies(db);
  return includeDisabled ? all : all.filter(c => c.enabled);
}

/* ============================================================
   快照
   ============================================================ */

export interface SnapshotListEntry {
  snapshot: Snapshot;
  counts: repo.SnapshotCounts;
}

const ZERO_COUNTS: repo.SnapshotCounts = { item_count: 0, carried_over: 0, tracked: 0, no_principal: 0 };

export function snapshotListService(db: Db, range: { from?: string; to?: string } = {}): SnapshotListEntry[] {
  const counts = repo.snapshotCounts(db);
  const metas = repo.listSnapshotMeta(db, range);
  const wanted = new Set(metas.map(m => m.id));
  const series = repo.loadSeries(db);
  // 保持「时间倒序」——列表展示用（趋势等其他场景一律显式升序）
  return sortDesc(series.snapshots.filter(s => wanted.has(s.id)))
    .map(snapshot => ({ snapshot, counts: counts.get(snapshot.id) ?? { ...ZERO_COUNTS } }));
}

export function snapshotDetailService(db: Db, id: string): SnapshotListEntry {
  const series = repo.loadSeries(db);
  const snapshot = requireSnapshot(series, id);
  const counts = repo.snapshotCounts(db).get(id) ?? { ...ZERO_COUNTS };
  return { snapshot, counts };
}

export function compareService(
  db: Db, aId: string, bId: string, dim: Dim, mode: ViewMode
): { result: CompareResult; early: SnapshotListEntry; late: SnapshotListEntry } {
  const series = repo.loadSeries(db);
  const { ctx } = queryContext(db);
  const result = compareSnapshots(series, aId, bId, dim, mode, ctx);
  if (!result) throw fail.notFound(`参与对比的快照不存在：${aId} / ${bId}`);
  const counts = repo.snapshotCounts(db);
  const entry = (s: Snapshot): SnapshotListEntry => ({
    snapshot: s,
    counts: counts.get(s.id) ?? { ...ZERO_COUNTS }
  });
  return { result, early: entry(result.early), late: entry(result.late) };
}

export interface ItemReturnEntry {
  account_id: string;
  account_name_snapshot: string;
  item_id: string;
  item: SnapshotItem;
  metrics: ReturnMetrics;
}

export function itemReturnsService(db: Db, snapshotId: string): ItemReturnEntry[] {
  const series = repo.loadSeries(db);
  const snapshot = requireSnapshot(series, snapshotId);
  return snapshot.items.map(it => ({
    account_id: it.account_id,
    account_name_snapshot: it.account_name_snapshot,
    item_id: it.id,
    item: it,
    metrics: returnsOf(it, prevItemOf(series, it.account_id, snapshot))
  }));
}

/* ============================================================
   报表
   ============================================================ */

export type Metric = 'net_worth' | 'total_assets' | 'total_liabilities';

export function trendService(
  db: Db, metric: Metric, mode: ViewMode
): { baseCurrency: string; points: Array<{ snapshot: Snapshot; totals: TotalsIn }>; baseChanges: ReturnType<typeof repo.listBaseHistoryRows> } {
  const { baseCurrency, ctx } = queryContext(db);
  const series = repo.loadSeries(db);
  // PRD 规则 16：同一日期取最后一张
  const points = dailySeries(series.snapshots).map(snapshot => ({
    snapshot,
    totals: snapTotalsIn(snapshot, mode, ctx)
  }));
  void metric;
  return { baseCurrency, points, baseChanges: repo.listBaseHistoryRows(db) };
}

export function breakdownService(
  db: Db, snapshotId: string, dim: Dim, mode: ViewMode
): { snapshot: Snapshot; rows: BreakdownRow[]; ref: boolean; baseCurrency: string } {
  const series = repo.loadSeries(db);
  const snapshot = requireSnapshot(series, snapshotId);
  const { baseCurrency, ctx } = queryContext(db);
  const totals = snapTotalsIn(snapshot, mode, ctx);
  return {
    snapshot,
    rows: breakdown(snapshot, dim, mode, ctx),
    ref: totals.ref,
    baseCurrency
  };
}

export function platformCurrencyService(
  db: Db, snapshotId: string, mode: ViewMode
): { snapshot: Snapshot; rows: PlatformCurrencyRow[]; baseCurrency: string } {
  const series = repo.loadSeries(db);
  const snapshot = requireSnapshot(series, snapshotId);
  const { baseCurrency, ctx } = queryContext(db);
  return {
    snapshot,
    rows: platformCurrencyBreakdown(snapshot, mode, ctx, repo.currencyMetaLookup(db)),
    baseCurrency
  };
}

export function currencyBreakdownService(
  db: Db, snapshotId: string, mode: ViewMode
): { snapshot: Snapshot; rows: CurrencyRow[]; baseCurrency: string } {
  const series = repo.loadSeries(db);
  const snapshot = requireSnapshot(series, snapshotId);
  const { baseCurrency, ctx } = queryContext(db);
  return {
    snapshot,
    rows: currencyBreakdown(snapshot, mode, ctx, repo.currencyMetaLookup(db)),
    baseCurrency
  };
}

export function returnsPanelService(db: Db, snapshotId: string): { snapshot: Snapshot; panel: ReturnsPanel } {
  const series = repo.loadSeries(db);
  const snapshot = requireSnapshot(series, snapshotId);
  return { snapshot, panel: returnsPanel(series, snapshot) };
}

export function returnsBreakdownService(
  db: Db, snapshotId: string, dim: Exclude<Dim, 'tag'>
): { snapshot: Snapshot; rows: ReturnsBreakdownRow[] } {
  const series = repo.loadSeries(db);
  const snapshot = requireSnapshot(series, snapshotId);
  return { snapshot, rows: returnsBreakdown(series, snapshot, dim) };
}

export function returnsTrendService(db: Db): Array<{ snapshot: Snapshot; panel: ReturnsPanel }> {
  const series = repo.loadSeries(db);
  return series.snapshots.map(snapshot => ({ snapshot, panel: returnsPanel(series, snapshot) }));
}

/** 「最新一张」——首页与大多数报表的默认目标 */
export function latestSnapshotId(db: Db): string | null {
  const s = lastSnapshot(repo.loadSeries(db).snapshots);
  return s ? s.id : null;
}

export { seriesOf, itemValueIn };
