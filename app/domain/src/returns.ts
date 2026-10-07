/**
 * returns.ts —— 理财本金与收益（PRD §3.4.4 与规则 18–21）
 *
 * 两条口径必须分清（最容易错的地方）：
 *   累计收益 = 市值 − 本金                → 「这笔钱总共赚了多少」
 *   本期收益 = 本期市值 − 上期市值 − 本期净投入  → 「这期赚了多少」
 * 其中「上期市值」取该账户**最近一次被写入快照**的市值，不要求那一期记过本金（规则 20）。
 *
 * 收益指标是派生值：实时计算、不落库，避免与快照冗余字段不一致。
 */
import { Money } from './money.ts';
import type { Dim, Snapshot, SnapshotItem } from './types.ts';
import { compareSnapshot, sortAsc, type SnapshotSeries } from './trend.ts';

export type ReturnStatus =
  /** 指标可用 */
  | 'ok'
  /** 该账户未开启本金跟踪（存款、信用卡等）—— 不得显示为「未填本金」 */
  | 'not-tracked'
  /** 已开启跟踪但本期未填本金 */
  | 'no-principal'
  /** 首次出现，无上期基准 */
  | 'first'
  /** 有上期快照，但上期未记录本金 —— 口径断了，与「首期」是两回事 */
  | 'base-missing';

export const RETURN_STATUS_LABEL: Record<ReturnStatus, string | null> = {
  'ok': null,
  'not-tracked': null,
  'first': '首期',
  'base-missing': '基准缺失',
  'no-principal': '未填本金'
};

export interface PrevRef {
  snapshot: Snapshot;
  item: SnapshotItem;
}

export interface ReturnMetrics {
  status: ReturnStatus;
  cum: Money | null;
  cumRate: number | null;
  per: Money | null;
  perRate: number | null;
  netInvest: Money | null;
  prevAmount: Money | null;
  prevPrincipal: Money | null;
}

function emptyMetrics(status: ReturnStatus): ReturnMetrics {
  return {
    status,
    cum: null, cumRate: null, per: null, perRate: null,
    netInvest: null, prevAmount: null, prevPrincipal: null
  };
}

const RATE_EPSILON = 0.0000001;

/** 某账户在指定快照之前、最近一次被写入快照的明细（规则 20） */
export function prevItemOf(
  series: SnapshotSeries,
  accountId: string,
  snapshot: Snapshot
): PrevRef | null {
  let prev: PrevRef | null = null;
  for (const s of series.snapshots) {
    if (compareSnapshot(s, snapshot) >= 0) break;
    const it = s.items.find(x => x.account_id === accountId);
    if (it) prev = { snapshot: s, item: it };
  }
  return prev;
}

/** 账户「最近快照金额」：不限于最近一期，而是最近一次**被写入过**的那期 */
export function recentItemOf(series: SnapshotSeries, accountId: string): PrevRef | null {
  for (let i = series.snapshots.length - 1; i >= 0; i--) {
    const s = series.snapshots[i];
    const it = s.items.find(x => x.account_id === accountId);
    if (it) return { snapshot: s, item: it };
  }
  return null;
}

/* ============================================================
   原币口径
   ============================================================ */

export function returnsOf(item: SnapshotItem, prev: PrevRef | null): ReturnMetrics {
  if (!item || !item.tracks_principal) return emptyMetrics('not-tracked');
  if (item.principal === null || item.principal === undefined) return emptyMetrics('no-principal');

  const out = emptyMetrics('ok');
  out.cum = item.original_amount.sub(item.principal);
  out.cumRate = item.principal.isPos() ? out.cum.toNumber() / item.principal.toNumber() : null;

  if (!prev) {
    out.status = 'first';
    return out;
  }
  const prevPrincipal = prev.item.principal;
  if (prevPrincipal === null || prevPrincipal === undefined) {
    out.status = 'base-missing';
    return out;
  }

  out.prevAmount = prev.item.original_amount;
  out.prevPrincipal = prevPrincipal;
  out.netInvest = item.principal.sub(prevPrincipal);
  out.per = item.original_amount.sub(prev.item.original_amount).sub(out.netInvest);

  const denom = prev.item.original_amount.add(out.netInvest);
  out.perRate = Math.abs(denom.toNumber()) > RATE_EPSILON ? out.per.toNumber() / denom.toNumber() : null;
  return out;
}

/* ============================================================
   本位币口径（收益面板与收益汇总都用这一套）
   ============================================================ */

export interface ReturnMetricsBase {
  status: ReturnStatus;
  cum: Money | null;
  per: Money | null;
  netInvest: Money | null;
}

export function returnsBaseOf(item: SnapshotItem, prev: PrevRef | null): ReturnMetricsBase {
  if (!item || !item.tracks_principal) {
    return { status: 'not-tracked', cum: null, per: null, netInvest: null };
  }
  if (item.principal_in_base === null || item.principal_in_base === undefined) {
    return { status: 'no-principal', cum: null, per: null, netInvest: null };
  }
  const cum = item.amount_in_base.sub(item.principal_in_base);
  if (!prev || prev.item.principal_in_base === null || prev.item.principal_in_base === undefined) {
    return { status: prev ? 'base-missing' : 'first', cum, per: null, netInvest: null };
  }
  const netInvest = item.principal_in_base.sub(prev.item.principal_in_base);
  const per = item.amount_in_base.sub(prev.item.amount_in_base).sub(netInvest);
  return { status: 'ok', cum, per, netInvest };
}

export interface ReturnsPanel {
  count: number;
  principal: Money;
  market: Money;
  cum: Money;
  cumRate: number | null;
  per: Money;
  perRate: number | null;
  /** 已开启跟踪但本期未填本金的账户数 */
  noPrincipal: number;
  first: number;
  missingBase: number;
  /** 是否存在可用的本期收益（无任何账户产出本期收益时为 false） */
  hasPer: boolean;
}

/** 快照收益面板：仅纳入「跟踪本金且本期记录了本金」的账户 */
export function returnsPanel(series: SnapshotSeries, snapshot: Snapshot): ReturnsPanel {
  const r: ReturnsPanel = {
    count: 0,
    principal: Money.zero(), market: Money.zero(),
    cum: Money.zero(), cumRate: null,
    per: Money.zero(), perRate: null,
    noPrincipal: 0, first: 0, missingBase: 0, hasPer: false
  };
  if (!snapshot) return r;

  let perDenom = 0n;
  for (const it of snapshot.items) {
    if (!it.tracks_principal) continue;
    if (it.principal_in_base === null || it.principal_in_base === undefined) {
      r.noPrincipal++;
      continue;
    }
    const prev = prevItemOf(series, it.account_id, snapshot);
    const rb = returnsBaseOf(it, prev);
    /* 「首期」「基准缺失」缺的都是**上期**基准；而累计收益 = 本期市值 − 本期本金，
       与上期无关（PRD §2.3 v1.3）——只记标记，继续并入累计口径。 */
    if (rb.status === 'first') r.first++;
    else if (rb.status === 'base-missing') r.missingBase++;

    r.count++;
    r.principal = r.principal.add(it.principal_in_base);
    r.market = r.market.add(it.amount_in_base);
    r.cum = r.cum.add(rb.cum as Money);
    if (rb.per !== null) {
      r.per = r.per.add(rb.per);
      perDenom += (prev as PrevRef).item.amount_in_base.add(rb.netInvest as Money).micro;
      r.hasPer = true;
    }
  }
  r.cumRate = r.principal.isPos() ? r.cum.toNumber() / r.principal.toNumber() : null;
  r.perRate = r.hasPer && Math.abs(Number(perDenom) / 1e6) > RATE_EPSILON
    ? r.per.toNumber() / (Number(perDenom) / 1e6)
    : null;
  return r;
}

/** 某一组的「本期收益」状态：`ok` 表示有值，另两个表示不可用及原因 */
export type PerStatus = 'ok' | 'first' | 'base-missing';

export interface ReturnsBreakdownRow {
  key: string;
  name: string;
  n: number;
  principal: Money;
  market: Money;
  cum: Money;
  cumRate: number | null;
  per: Money | null;
  /** `per === null` 时区分「首期」与「基准缺失」——两者都可能，但标记不同（PRD §10） */
  perStatus: PerStatus;
}

/** 收益多维度汇总（PRD §3.4.4）：账户 / 平台 / 分类 / 币种 */
export function returnsBreakdown(
  series: SnapshotSeries,
  snapshot: Snapshot,
  dim: Exclude<Dim, 'tag'>
): ReturnsBreakdownRow[] {
  interface Acc {
    key: string; name: string; n: number;
    principal: bigint; market: bigint; cum: bigint; per: bigint; hasPer: boolean;
    perStatus: PerStatus;
  }
  const map = new Map<string, Acc>();

  for (const it of snapshot.items) {
    if (!it.tracks_principal) continue;
    if (it.principal_in_base === null || it.principal_in_base === undefined) continue;
    const prev = prevItemOf(series, it.account_id, snapshot);
    const rb = returnsBaseOf(it, prev);
    /* 同上：首期 / 基准缺失不排除在累计口径之外，只影响本期收益 */

    let key: string;
    let name: string;
    if (dim === 'account') { key = it.account_id; name = it.account_name_snapshot; }
    else if (dim === 'platform') { key = it.platform_id_snapshot || 'none'; name = it.platform_name_snapshot || '未指定平台'; }
    else if (dim === 'category') { key = it.category_id_snapshot || 'none'; name = it.category_name_snapshot; }
    else { key = it.currency; name = it.currency; }

    let g = map.get(key);
    if (!g) {
      g = { key, name, n: 0, principal: 0n, market: 0n, cum: 0n, per: 0n, hasPer: false, perStatus: 'ok' };
      map.set(key, g);
    }
    g.n++;
    g.principal += it.principal_in_base.micro;
    g.market += it.amount_in_base.micro;
    g.cum += (rb.cum as Money).micro;
    if (rb.per !== null) {
      g.per += rb.per.micro;
      g.hasPer = true;
      g.perStatus = 'ok';
    } else if (!g.hasPer) {
      /* 该组本期收益不可用：记下原因（首期 / 基准缺失），供界面区分标注 */
      g.perStatus = rb.status === 'first' ? 'first' : 'base-missing';
    }
  }

  const rows: ReturnsBreakdownRow[] = Array.from(map.values()).map(g => {
    const principal = Money.fromMicro(g.principal);
    const cum = Money.fromMicro(g.cum);
    return {
      key: g.key,
      name: g.name,
      n: g.n,
      principal,
      market: Money.fromMicro(g.market),
      cum,
      cumRate: principal.isPos() ? cum.toNumber() / principal.toNumber() : null,
      per: g.hasPer ? Money.fromMicro(g.per) : null,
      perStatus: g.perStatus
    };
  });
  rows.sort((a, b) => b.market.cmp(a.market));
  return rows;
}

/** 便于测试与调用方构造升序序列 */
export function seriesOf(snapshots: Snapshot[]): SnapshotSeries {
  return { snapshots: sortAsc(snapshots) };
}
