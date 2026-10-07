/**
 * DTO 装配 —— 领域形态 → HTTP 响应形态（Controller 的职责，§3.2）
 *
 * 金额一律转成**微元整数**（`Micro`）。这是与前端约定的唯一传输形态：
 * 无损、与 `Money.fromMicro()` 精确对应，前端在 API 边界一次性还原。
 */
import {
  Money,
  platformCurrencyBreakdown,
  currencyBreakdown,
  returnsOf,
  prevItemOf,
  RETURN_STATUS_LABEL,
  type EntryDraft,
  type InventoryTotals,
  type PlanResult,
  type ReturnMetrics,
  type Snapshot,
  type SnapshotItem,
  type SnapshotSeries,
  type BreakdownRow,
  type CompareResult,
  type Account,
  type ReturnsPanel,
  type ReturnsBreakdownRow,
  type PlatformCurrencyRow,
  type CurrencyRow,
  type FxContext,
  type TotalsIn,
  type ValidationIssue
} from '@app/domain';
import type {
  AccountDTO, AccountType, BaseCurrencyChangeDTO, BreakdownDTO, BreakdownRowDTO,
  CategoryDTO, CompareDTO, CompareRowDTO, CurrencyDTO, CurrencyRowDTO, HealthDTO,
  InventoryAccountRef, InventoryDraftDTO, InventoryEntryDTO, InventoryPreviewDTO,
  InventorySaveDTO,
  ItemReturnDTO, PlatformCurrencyRowDTO, PlatformDTO, ReadyDTO, ReturnsBreakdownDTO,
  ReturnsBreakdownRowDTO, ReturnsPanelDTO, ReturnsTrendDTO, ReturnsTrendPointDTO,
  SettingsDTO, SnapshotDTO, SnapshotItemDTO, SnapshotSummaryDTO, TagDTO, TrendDTO,
  TrendPointDTO, ViewMode, Dim
} from '@app/shared';

export const mic = (m: Money | null | undefined): number | null =>
  m === null || m === undefined ? null : Number(m.toMicro());

export const micReq = (m: Money): number => Number(m.toMicro());

/** 「元」的 number → 微元整数。仅用于盘点录入这类由 number 进入的边界。 */
export const microNum = (n: number | null | undefined): number | null =>
  n === null || n === undefined ? null : Number(Money.fromNumber(n).toMicro());

/** 比率的统一展示精度：12 位小数（与黄金值的记录口径一致） */
export const rate = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(12));

/* ---------- 基础资料 ---------- */

export function toCurrencyDTO(r: {
  code: string; name: string; symbol: string; sort: number; enabled: boolean;
  rate_to_base_micro: number | null; rate_updated_at: string | null;
}): CurrencyDTO {
  return {
    code: r.code, name: r.name, symbol: r.symbol, sort: r.sort, enabled: r.enabled,
    rate_to_base: r.rate_to_base_micro ?? 0,
    rate_updated_at: r.rate_updated_at
  };
}

export function toPlatformDTO(r: {
  id: string; name: string; type: string; note: string; sort: number;
  enabled: boolean; account_count: number;
}): PlatformDTO {
  return { ...r };
}

export function toCategoryDTO(r: {
  id: string; name: string; type: AccountType; default_track_principal: boolean;
  sort: number; enabled: boolean; account_count: number;
}): CategoryDTO {
  return { ...r };
}

export function toTagDTO(r: {
  id: string; name: string; sort: number; enabled: boolean; account_count: number;
}): TagDTO {
  return { ...r };
}

/* ---------- 设置 ---------- */

export function toSettingsDTO(
  settings: Record<string, string>,
  schemaVersion: number
): SettingsDTO {
  return {
    base_currency: settings.base_currency ?? 'CNY',
    schema_version: schemaVersion,
    app_version: settings.app_version ?? 'unknown',
    /* 直接从设置表读 —— `data_mode` 本就是 `setting` 里的一行。不另开一条查询，
       也就不可能出现「界面显示的模式」与「门禁判断的模式」来自两个地方。 */
    data_mode: settings.data_mode === 'demo' ? 'demo' : 'live'
  };
}

export function toBaseHistoryDTO(r: {
  id: string; fromCurrency: string; toCurrency: string; conversionRate: number; changedAt: string;
}): BaseCurrencyChangeDTO {
  return {
    id: r.id,
    from_currency: r.fromCurrency,
    to_currency: r.toCurrency,
    conversion_rate: Number(r.conversionRate) / 1_000_000,
    changed_at: r.changedAt
  };
}

/* ---------- 快照 ---------- */

export function toSnapshotSummaryDTO(
  s: Snapshot,
  counts: { item_count: number; carried_over: number; tracked: number; no_principal: number }
): SnapshotSummaryDTO {
  return {
    id: s.id,
    date: s.date,
    note: s.note,
    base_currency: s.base_currency,
    total_assets: micReq(s.total_assets),
    total_liabilities: micReq(s.total_liabilities),
    net_worth: micReq(s.net_worth),
    created_at: s.created_at,
    item_count: counts.item_count,
    carried_over: counts.carried_over,
    tracked: counts.tracked,
    no_principal: counts.no_principal
  };
}

export function toItemDTO(it: SnapshotItem): SnapshotItemDTO {
  return {
    id: it.id,
    snapshot_id: it.snapshot_id,
    account_id: it.account_id,
    account_name_snapshot: it.account_name_snapshot,
    platform_id_snapshot: it.platform_id_snapshot,
    platform_name_snapshot: it.platform_name_snapshot,
    category_id_snapshot: it.category_id_snapshot,
    category_name_snapshot: it.category_name_snapshot,
    type: it.type,
    currency: it.currency,
    original_amount: micReq(it.original_amount),
    exchange_rate: micReq(it.exchange_rate),
    amount_in_base: micReq(it.amount_in_base),
    include_in_net_worth: it.include_in_net_worth,
    tracks_principal: it.tracks_principal,
    principal: mic(it.principal),
    principal_in_base: mic(it.principal_in_base),
    is_carried_over: it.is_carried_over,
    tags_snapshot: it.tags_snapshot.map(t => ({ id: t.id, name: t.name })),
    sort: it.sort
  };
}

export function toSnapshotDTO(
  s: Snapshot,
  counts: { item_count: number; carried_over: number; tracked: number; no_principal: number }
): SnapshotDTO {
  const rates: Record<string, number> = {};
  for (const [code, v] of Object.entries(s.rates)) rates[code] = Math.round(v * 1_000_000);
  return {
    ...toSnapshotSummaryDTO(s, counts),
    rates,
    items: s.items.map(toItemDTO)
  };
}

/* ---------- 报表 ---------- */

export function toTrendDTO(
  metric: 'net_worth' | 'total_assets' | 'total_liabilities',
  mode: ViewMode,
  baseCurrency: string,
  points: Array<{ snapshot: Snapshot; totals: TotalsIn }>,
  baseChanges: BaseCurrencyChangeDTO[]
): TrendDTO {
  const pick = (t: TotalsIn): Money | null =>
    metric === 'net_worth' ? t.nw : metric === 'total_assets' ? t.ta : t.tl;

  const dtos: TrendPointDTO[] = points.map(({ snapshot, totals }) => ({
    snapshot_id: snapshot.id,
    date: snapshot.date,
    created_at: snapshot.created_at,
    base_currency: snapshot.base_currency,
    total_assets: mic(totals.ta),
    total_liabilities: mic(totals.tl),
    net_worth: mic(totals.nw),
    ref: totals.ref
  }));
  // pick 仅用于断言口径一致，避免「选了 metric 却返回全量」的静默错误
  void pick;

  return { metric, mode, base_currency: baseCurrency, points: dtos, base_changes: baseChanges };
}

export function toBreakdownDTO(
  snapshotId: string, dim: Dim, mode: ViewMode, baseCurrency: string,
  ref: boolean, rows: BreakdownRow[]
): BreakdownDTO {
  return {
    snapshot_id: snapshotId, dim, mode, base_currency: baseCurrency, ref,
    rows: rows.map<BreakdownRowDTO>(r => ({
      key: r.key, name: r.name,
      asset: micReq(r.asset), liability: micReq(r.liability), net: micReq(r.net),
      count: r.count
    }))
  };
}

export function toPlatformCurrencyDTO(rows: PlatformCurrencyRow[]): PlatformCurrencyRowDTO[] {
  return rows.map(r => ({
    key: r.key, name: r.name,
    asset: micReq(r.asset), liability: micReq(r.liability), total: micReq(r.total),
    accounts: r.accounts, currencies: r.currencies,
    by_currency: r.byCur.map(c => ({
      code: c.code, name: c.name, symbol: c.symbol,
      orig: micReq(c.orig), base: micReq(c.base),
      asset: micReq(c.asset), liability: micReq(c.liability), n: c.n
    }))
  }));
}

export function toCurrencyRowDTO(rows: CurrencyRow[]): CurrencyRowDTO[] {
  return rows.map(c => ({
    code: c.code, name: c.name, symbol: c.symbol,
    orig: micReq(c.orig), base: micReq(c.base), n: c.n
  }));
}

export function toReturnsPanelDTO(snapshotId: string, p: ReturnsPanel): ReturnsPanelDTO {
  return {
    snapshot_id: snapshotId,
    count: p.count,
    principal: micReq(p.principal),
    market: micReq(p.market),
    cum: micReq(p.cum),
    cum_rate: rate(p.cumRate),
    per: micReq(p.per),
    per_rate: rate(p.perRate),
    no_principal: p.noPrincipal,
    first: p.first,
    missing_base: p.missingBase,
    has_per: p.hasPer
  };
}

export function toReturnsBreakdownDTO(
  snapshotId: string, dim: Exclude<Dim, 'tag'>, rows: ReturnsBreakdownRow[]
): ReturnsBreakdownDTO {
  return {
    snapshot_id: snapshotId, dim,
    rows: rows.map<ReturnsBreakdownRowDTO>(r => ({
      key: r.key, name: r.name, n: r.n,
      principal: micReq(r.principal), market: micReq(r.market), cum: micReq(r.cum),
      cum_rate: rate(r.cumRate), per: mic(r.per), per_status: r.perStatus
    }))
  };
}

export function toReturnsTrendDTO(
  points: Array<{ snapshot: Snapshot; panel: ReturnsPanel }>
): ReturnsTrendDTO {
  const dtos: ReturnsTrendPointDTO[] = points.map(({ snapshot, panel }) => ({
    snapshot_id: snapshot.id,
    date: snapshot.date,
    count: panel.count,
    principal: micReq(panel.principal),
    market: micReq(panel.market),
    cum: micReq(panel.cum),
    per: micReq(panel.per),
    per_available: panel.hasPer
  }));
  return { points: dtos };
}

/* ---------- 单条明细的收益指标 ---------- */

export function metricsOf(m: ReturnMetrics): {
  status: ReturnMetrics['status']; cum: number | null; cum_rate: number | null;
  per: number | null; per_rate: number | null; net_invest: number | null;
  prev_amount: number | null; prev_principal: number | null;
} {
  return {
    status: m.status,
    cum: mic(m.cum),
    cum_rate: rate(m.cumRate),
    per: mic(m.per),
    per_rate: rate(m.perRate),
    net_invest: mic(m.netInvest),
    prev_amount: mic(m.prevAmount),
    prev_principal: mic(m.prevPrincipal)
  };
}

export function toItemReturnDTO(it: SnapshotItem, m: ReturnMetrics): ItemReturnDTO {
  return {
    item_id: it.id,
    account_id: it.account_id,
    account_name_snapshot: it.account_name_snapshot,
    tracks_principal: it.tracks_principal,
    original_amount: micReq(it.original_amount),
    principal: mic(it.principal),
    ...metricsOf(m)
  };
}

export function toItemReturns(series: SnapshotSeries, snapshot: Snapshot): ItemReturnDTO[] {
  return snapshot.items.map(it =>
    toItemReturnDTO(it, returnsOf(it, prevItemOf(series, it.account_id, snapshot)))
  );
}

export function toCompareDTO(c: CompareResult, early: SnapshotSummaryDTO, late: SnapshotSummaryDTO): CompareDTO {
  return {
    dim: c.dim,
    mode: c.mode,
    cross_currency: c.crossCur,
    early,
    late,
    totals_early: {
      total_assets: mic(c.totalsEarly.ta), total_liabilities: mic(c.totalsEarly.tl),
      net_worth: mic(c.totalsEarly.nw), ref: c.totalsEarly.ref
    },
    totals_late: {
      total_assets: mic(c.totalsLate.ta), total_liabilities: mic(c.totalsLate.tl),
      net_worth: mic(c.totalsLate.nw), ref: c.totalsLate.ref
    },
    delta_total_assets: mic(c.dTa),
    delta_total_liabilities: mic(c.dTl),
    delta_net_worth: mic(c.dNw),
    rate_net_worth: rate(c.rateNw),
    rows: c.rows.map<CompareRowDTO>(r => ({
      key: r.key, name: r.name,
      a: mic(r.a), b: mic(r.b),
      a_asset: mic(r.aAsset), a_liability: mic(r.aLiability),
      b_asset: mic(r.bAsset), b_liability: mic(r.bLiability),
      diff: micReq(r.diff), rate: rate(r.rate),
      is_new: r.isNew, is_gone: r.isGone
    })),
    returns: {
      a_principal: micReq(c.ret.aPrincipal), b_principal: micReq(c.ret.bPrincipal),
      a_cum: micReq(c.ret.aCum), b_cum: micReq(c.ret.bCum),
      a_rate: rate(c.ret.aRate), b_rate: rate(c.ret.bRate)
    }
  };
}

/* ---------- 账户 ---------- */

export function toAccountDTO(a: Account): AccountDTO {
  return {
    id: a.id,
    name: a.name,
    platform_id: a.platform_id,
    category_id: a.category_id,
    type: a.type,
    currency: a.currency,
    tags: a.tags,
    note: a.note,
    include_in_net_worth: a.include_in_net_worth,
    track_principal: a.track_principal,
    sort: a.sort,
    archived: a.archived,
    created_at: a.created_at,
    updated_at: a.updated_at ?? a.created_at
  };
}

/* ---------- 盘点（Step 4 写路径） ---------- */

export function toInventoryEntryDTO(e: EntryDraft): InventoryEntryDTO {
  return { amount: microNum(e.amount), principal: microNum(e.principal), state: e.state };
}

/** `row` 用结构化类型而不是 import 仓储层：dto 属于 lib 层，不该依赖 db 层 */
export function toInventoryDraftDTO(
  row: { version: number; data: unknown } | null
): InventoryDraftDTO | null {
  if (!row) return null;
  const data = (row.data ?? {}) as {
    date?: string | null;
    note?: string;
    entries?: Record<string, EntryDraft>;
    rates?: Record<string, number>;
  };
  const entries: Record<string, InventoryEntryDTO> = {};
  for (const [id, e] of Object.entries(data.entries ?? {})) {
    entries[id] = toInventoryEntryDTO(e);
  }
  return {
    version: row.version,
    date: data.date ?? null,
    note: data.note ?? '',
    entries,
    /* 缺省时不补空对象：让「没改过汇率」与「改成了空表」在协议上区分得开 */
    ...(data.rates ? { rates: data.rates } : {})
  };
}

export function toInventoryPreviewDTO(args: {
  date: string;
  baseCurrency: string;
  plan: PlanResult;
  totals: InventoryTotals;
  issues: ValidationIssue[];
  platformName: (id: string | null) => string;
  excludedFromNetWorth: number;
  duplicateDate: boolean;
}): InventoryPreviewDTO {
  const refOf = (a: { id: string; name: string; platform_id: string | null }): InventoryAccountRef => ({
    account_id: a.id,
    account_name: a.name,
    platform_name: args.platformName(a.platform_id)
  });
  return {
    date: args.date,
    base_currency: args.baseCurrency,
    totals: {
      total_assets: micReq(args.totals.totalAssets),
      total_liabilities: micReq(args.totals.totalLiabilities),
      net_worth: micReq(args.totals.netWorth)
    },
    counts: {
      written: args.plan.planned.length,
      filled: args.totals.filled,
      carry: args.totals.carry,
      unfilled: args.totals.unfilled,
      no_principal: args.totals.noPrincipal,
      excluded_from_net_worth: args.excludedFromNetWorth
    },
    unfilled: args.plan.unfilled.map(refOf),
    no_principal: args.plan.noPrincipal.map(refOf),
    issues: args.issues.map(i => ({
      account_id: i.accountId,
      account_name: i.accountName,
      code: i.code,
      message: i.message
    })),
    duplicate_date: args.duplicateDate
  };
}

export function toInventorySaveDTO(
  summary: SnapshotSummaryDTO,
  counts: { written: number; carried_over: number; unfilled: number; no_principal: number }
): InventorySaveDTO {
  return { snapshot: summary, ...counts };
}

/* ---------- 系统 ---------- */

export function toHealthDTO(version: string, uptimeS: number): HealthDTO {
  return { status: 'ok', version, uptime_s: Number(uptimeS.toFixed(3)) };
}

export function toReadyDTO(
  schemaVersion: number, dataDir: string,
  counts: ReadyDTO['counts']
): ReadyDTO {
  return { status: 'ready', schema_version: schemaVersion, data_dir: dataDir, counts };
}

export { RETURN_STATUS_LABEL };
