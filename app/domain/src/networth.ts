/**
 * networth.ts —— 汇总口径（PRD §3.4.1 核心公式 / §3.4.2 汇总维度 / §3.4.3 计算规则 / 规则 9）
 *
 * 铁律：只有「计入净值」的账户参与汇总；本金与收益一律不参与净资产计算。
 */
import { Money } from './money.ts';
import type { Dim, Snapshot, SnapshotItem, ViewMode } from './types.ts';
import { itemValueIn, type FxContext } from './fx.ts';

export interface Totals {
  totalAssets: Money;
  totalLiabilities: Money;
  netWorth: Money;
}

/**
 * 快照核心公式。
 * 注意口径：总资产 = Σ「计入净值」的资产账户市值（不是所有资产账户，见 PRD §3.4.1）。
 * 负债一律以正数入账，因此净资产 = 总资产 − 总负债。
 */
export function computedTotals(items: SnapshotItem[]): Totals {
  let assets = 0n;
  let liabilities = 0n;
  for (const it of items) {
    if (!it.include_in_net_worth) continue;
    if (it.type === 'asset') assets += it.amount_in_base.micro;
    else liabilities += it.amount_in_base.micro;
  }
  return {
    totalAssets: Money.fromMicro(assets),
    totalLiabilities: Money.fromMicro(liabilities),
    netWorth: Money.fromMicro(assets - liabilities)
  };
}

export interface BreakdownRow {
  key: string;
  name: string;
  asset: Money;
  liability: Money;
  net: Money;
  count: number;
}

const DIM_NAME: Record<Exclude<Dim, 'tag' | 'currency'>, (it: SnapshotItem) => string> = {
  account: it => it.account_name_snapshot,
  platform: it => it.platform_name_snapshot || '未指定平台',
  category: it => it.category_name_snapshot
};

/**
 * 多维分布汇总（PRD §3.4.2）。
 * 口径与核心公式一致：只纳入「计入净值」的账户；标签维度按「归类」处理，不重复计算金额。
 */
export function breakdown(
  snapshot: Snapshot,
  dim: Dim,
  mode: ViewMode,
  ctx: FxContext
): BreakdownRow[] {
  const map = new Map<string, BreakdownRow>();

  const ensure = (key: string): BreakdownRow => {
    let row = map.get(key);
    if (!row) {
      row = { key, name: '', asset: Money.zero(), liability: Money.zero(), net: Money.zero(), count: 0 };
      map.set(key, row);
    }
    return row;
  };

  for (const it of snapshot.items) {
    if (!it.include_in_net_worth) continue;
    const v = itemValueIn(it, snapshot, mode, ctx);
    if (v === null) continue;

    if (dim === 'tag') {
      for (const t of it.tags_snapshot ?? []) {
        const row = ensure(t.id);
        row.name = t.name;
        row.count++;
        if (it.type === 'asset') row.asset = row.asset.add(v);
        else row.liability = row.liability.add(v);
      }
      continue;
    }

    if (dim === 'currency') {
      const row = ensure(it.currency);
      row.name = it.currency;
      row.count++;
      if (it.type === 'asset') row.asset = row.asset.add(v);
      else row.liability = row.liability.add(v);
      continue;
    }

    const key = dim === 'account'
      ? (it.account_id || it.account_name_snapshot)
      : dim === 'platform'
        ? (it.platform_id_snapshot || 'none')
        : (it.category_id_snapshot || 'none');
    const row = ensure(key);
    row.name = DIM_NAME[dim](it);
    row.count++;
    if (it.type === 'asset') row.asset = row.asset.add(v);
    else row.liability = row.liability.add(v);
  }

  const rows = Array.from(map.values());
  for (const r of rows) r.net = r.asset.sub(r.liability);
  rows.sort((a, b) => b.asset.add(b.liability).cmp(a.asset.add(a.liability)));
  return rows;
}

/* ============================================================
   平台 × 币种分解（首页 / 报表「平台分布」的堆叠与悬浮明细）
   base 用于堆叠比例与右侧指标（保持各平台可比）；orig 用于按各自币种展示
   ============================================================ */

export interface PlatformCurrencyRow {
  key: string;
  name: string;
  asset: Money;
  liability: Money;
  total: Money;
  accounts: number;
  currencies: number;
  byCur: Array<{
    code: string;
    name: string;
    symbol: string;
    orig: Money;
    base: Money;
    asset: Money;
    liability: Money;
    n: number;
  }>;
}

export function platformCurrencyBreakdown(
  snapshot: Snapshot,
  mode: ViewMode,
  ctx: FxContext,
  currencyMeta: (code: string) => { name: string; symbol: string }
): PlatformCurrencyRow[] {
  const map = new Map<string, PlatformCurrencyRow>();

  for (const it of snapshot.items) {
    if (!it.include_in_net_worth) continue;
    const v = itemValueIn(it, snapshot, mode, ctx);
    if (v === null) continue;

    const pk = it.platform_id_snapshot || 'none';
    let row = map.get(pk);
    if (!row) {
      row = {
        key: pk,
        name: it.platform_name_snapshot || '未指定平台',
        asset: Money.zero(), liability: Money.zero(), total: Money.zero(),
        accounts: 0, currencies: 0, byCur: []
      };
      map.set(pk, row);
    }
    row.accounts++;
    if (it.type === 'asset') row.asset = row.asset.add(v);
    else row.liability = row.liability.add(v);

    let cur = row.byCur.find(c => c.code === it.currency);
    if (!cur) {
      const meta = currencyMeta(it.currency);
      cur = {
        code: it.currency, name: meta.name, symbol: meta.symbol,
        orig: Money.zero(), base: Money.zero(),
        asset: Money.zero(), liability: Money.zero(), n: 0
      };
      row.byCur.push(cur);
    }
    cur.n++;
    cur.orig = cur.orig.add(it.original_amount);
    cur.base = cur.base.add(v);
    if (it.type === 'asset') cur.asset = cur.asset.add(v);
    else cur.liability = cur.liability.add(v);
  }

  const rows = Array.from(map.values());
  for (const r of rows) {
    r.total = r.asset.add(r.liability);
    r.byCur.sort((a, b) => b.asset.add(b.liability).cmp(a.asset.add(a.liability)));
    r.currencies = r.byCur.length;
  }
  rows.sort((a, b) => b.total.cmp(a.total));
  return rows;
}

export interface CurrencyRow {
  code: string;
  name: string;
  symbol: string;
  orig: Money;
  base: Money;
  n: number;
}

/** 币种维度：原币合计 + 折本位币 */
export function currencyBreakdown(
  snapshot: Snapshot,
  mode: ViewMode,
  ctx: FxContext,
  currencyMeta: (code: string) => { name: string; symbol: string }
): CurrencyRow[] {
  const map = new Map<string, CurrencyRow>();
  for (const it of snapshot.items) {
    if (!it.include_in_net_worth) continue;
    const v = itemValueIn(it, snapshot, mode, ctx);
    if (v === null) continue;
    let row = map.get(it.currency);
    if (!row) {
      const meta = currencyMeta(it.currency);
      row = {
        code: it.currency, name: meta.name, symbol: meta.symbol,
        orig: Money.zero(), base: Money.zero(), n: 0
      };
      map.set(it.currency, row);
    }
    row.n++;
    row.orig = row.orig.add(it.original_amount);
    row.base = row.base.add(v);
  }
  const rows = Array.from(map.values());
  rows.sort((a, b) => b.base.abs().cmp(a.base.abs()));
  return rows;
}
