/**
 * compare.ts —— 两期快照对比（PRD §3.5.1 / 规则 8）
 *
 * 两条易错规则：
 *   1. 按 ID 匹配（account_id / platform_id_snapshot / category_id_snapshot / tag.id），
 *      不是按名称 —— 否则账户一改名，两期就被当成两个对象，静默错位且不报错。
 *   2. 变化率仅在基准为正时才有直观意义；基准非正（负债主导）时留空，
 *      避免出现「-108%」这类误导数字。
 */
import { Money } from './money.ts';
import type { Dim, Snapshot, ViewMode } from './types.ts';
import { compareSnapshot, type SnapshotSeries } from './trend.ts';
import { itemValueIn, snapTotalsIn, type FxContext, type TotalsIn } from './fx.ts';
import { returnsPanel, seriesOf, type ReturnsPanel } from './returns.ts';

export interface CompareRow {
  key: string;
  name: string;
  /** 早期口径净额；null 表示该项在早期不存在 */
  a: Money | null;
  b: Money | null;
  aAsset: Money | null;
  aLiability: Money | null;
  bAsset: Money | null;
  bLiability: Money | null;
  diff: Money;
  rate: number | null;
  isNew: boolean;
  isGone: boolean;
}

export interface ReturnCompare {
  aPrincipal: Money;
  bPrincipal: Money;
  aCum: Money;
  bCum: Money;
  aRate: number | null;
  bRate: number | null;
}

export interface CompareResult {
  early: Snapshot;
  late: Snapshot;
  dim: Dim;
  mode: ViewMode;
  /** 两期本位币不同 —— 此时必须走折算，否则相减没有意义 */
  crossCur: boolean;
  totalsEarly: TotalsIn;
  totalsLate: TotalsIn;
  dTa: Money | null;
  dTl: Money | null;
  dNw: Money | null;
  rateNw: number | null;
  rows: CompareRow[];
  ret: ReturnCompare;
}

interface Bucket { name: string; asset: bigint; liability: bigint }

const RATE_EPSILON = 0.0000001;

function collect(snapshot: Snapshot, dim: Dim, mode: ViewMode, ctx: FxContext): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  const add = (key: string, name: string, v: Money, isAsset: boolean) => {
    let b = map.get(key);
    if (!b) { b = { name, asset: 0n, liability: 0n }; map.set(key, b); }
    if (isAsset) b.asset += v.micro; else b.liability += v.micro;
  };

  for (const it of snapshot.items) {
    if (!it.include_in_net_worth) continue;
    const v = itemValueIn(it, snapshot, mode, ctx);
    if (v === null) continue;
    const isAsset = it.type === 'asset';
    if (dim === 'tag') {
      for (const t of it.tags_snapshot ?? []) add(t.id, t.name, v, isAsset);
    } else if (dim === 'currency') {
      add(it.currency, it.currency, v, isAsset);
    } else if (dim === 'account') {
      add(it.account_id || it.account_name_snapshot, it.account_name_snapshot, v, isAsset);
    } else if (dim === 'platform') {
      add(it.platform_id_snapshot || 'none', it.platform_name_snapshot || '未指定平台', v, isAsset);
    } else {
      add(it.category_id_snapshot || 'none', it.category_name_snapshot, v, isAsset);
    }
  }
  return map;
}

export function compareSnapshots(
  series: SnapshotSeries,
  aId: string,
  bId: string,
  dim: Dim,
  mode: ViewMode,
  ctx: FxContext
): CompareResult | null {
  const a = series.snapshots.find(s => s.id === aId);
  const b = series.snapshots.find(s => s.id === bId);
  if (!a || !b) return null;

  const [early, late] = compareSnapshot(a, b) <= 0 ? [a, b] : [b, a];

  const ma = collect(early, dim, mode, ctx);
  const mb = collect(late, dim, mode, ctx);
  const keys = Array.from(new Set([...ma.keys(), ...mb.keys()]));

  const rows: CompareRow[] = keys.map(k => {
    const x = ma.get(k);
    const y = mb.get(k);
    const ax = x ? x.asset - x.liability : null;
    const by = y ? y.asset - y.liability : null;
    const A = ax === null ? 0n : ax;
    const B = by === null ? 0n : by;
    const An = Number(A) / 1e6;
    const Bn = Number(B) / 1e6;
    return {
      key: k,
      name: y ? y.name : (x as Bucket).name,
      a: ax === null ? null : Money.fromMicro(ax),
      b: by === null ? null : Money.fromMicro(by),
      aAsset: x ? Money.fromMicro(x.asset) : null,
      aLiability: x ? Money.fromMicro(x.liability) : null,
      bAsset: y ? Money.fromMicro(y.asset) : null,
      bLiability: y ? Money.fromMicro(y.liability) : null,
      diff: Money.fromMicro(B - A),
      rate: An > RATE_EPSILON && Bn >= 0 ? (Bn - An) / An : null,
      isNew: !x && !!y,
      isGone: !!x && !y
    };
  });
  rows.sort((p, q) => q.diff.abs().cmp(p.diff.abs()));

  const totalsEarly = snapTotalsIn(early, mode, ctx);
  const totalsLate = snapTotalsIn(late, mode, ctx);
  const crossCur = early.base_currency !== late.base_currency;

  const rpA = returnsPanel(series, early);
  const rpB = returnsPanel(series, late);
  const ret: ReturnCompare = {
    aPrincipal: rpA.principal, bPrincipal: rpB.principal,
    aCum: rpA.cum, bCum: rpB.cum,
    aRate: rpA.principal.isPos() ? rpA.cum.toNumber() / rpA.principal.toNumber() : null,
    bRate: rpB.principal.isPos() ? rpB.cum.toNumber() / rpB.principal.toNumber() : null
  };

  const diffOf = (x: Money | null, y: Money | null): Money | null =>
    x === null || y === null ? null : y.sub(x);
  const dTa = diffOf(totalsEarly.ta, totalsLate.ta);
  const dTl = diffOf(totalsEarly.tl, totalsLate.tl);
  const dNw = diffOf(totalsEarly.nw, totalsLate.nw);

  return {
    early, late, dim, mode, crossCur,
    totalsEarly, totalsLate,
    dTa, dTl, dNw,
    rateNw: (totalsEarly.nw && totalsLate.nw && Math.abs(totalsEarly.nw.toNumber()) > RATE_EPSILON)
      ? (dNw as Money).toNumber() / Math.abs(totalsEarly.nw.toNumber())
      : null,
    rows, ret
  };
}

/** 便捷入口：直接传快照数组 */
export function compareByIds(
  snapshots: Snapshot[],
  aId: string,
  bId: string,
  dim: Dim,
  mode: ViewMode,
  ctx: FxContext
): CompareResult | null {
  return compareSnapshots(seriesOf(snapshots), aId, bId, dim, mode, ctx);
}

export type { ReturnsPanel };
