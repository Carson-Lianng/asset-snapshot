/**
 * series.ts —— 快照序列的展示侧派生
 *
 * 只有「排序」与「同日取最后一张」（PRD 规则 16），不含任何金额口径计算：
 * 单点数值一律来自端点返回的 DTO，这里只决定「顺序」和「取哪一张」。
 * 这与原型 cmpSnap / sortedSnapshots / lastSnapshot / dailySeries 的规则一致。
 */
import type { SnapshotSummaryDTO } from '@app/shared';

function cmp(a: SnapshotSummaryDTO, b: SnapshotSummaryDTO): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 升序（日期 → 创建时间 → ID） */
export function snapsAsc(list: readonly SnapshotSummaryDTO[]): SnapshotSummaryDTO[] {
  return [...list].sort(cmp);
}

/** 降序 */
export function snapsDesc(list: readonly SnapshotSummaryDTO[]): SnapshotSummaryDTO[] {
  return [...list].sort((a, b) => cmp(b, a));
}

/** 最新一张（同期取最后一张） */
export function lastSnapshot(list: readonly SnapshotSummaryDTO[]): SnapshotSummaryDTO | null {
  const asc = snapsAsc(list);
  return asc.length ? asc[asc.length - 1] : null;
}

/** 每日取当日最后一张，按日期升序 —— 趋势图与按日期对比使用 */
export function dailySeries(list: readonly SnapshotSummaryDTO[]): SnapshotSummaryDTO[] {
  const byDate = new Map<string, SnapshotSummaryDTO>();
  for (const s of list) {
    const cur = byDate.get(s.date);
    if (!cur || cmp(cur, s) < 0) byDate.set(s.date, s);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 同一天有几张快照（用于「同日多张」标记） */
export function duplicateCount(list: readonly SnapshotSummaryDTO[], date: string): number {
  return list.filter(s => s.date === date).length;
}

/** 升序序列中某张快照的前一张（同日期口径） */
export function previousInDaily(
  daily: readonly SnapshotSummaryDTO[],
  id: string
): SnapshotSummaryDTO | null {
  const idx = daily.findIndex(d => d.id === id);
  return idx > 0 ? daily[idx - 1] : null;
}

/* ============================================================
   时间筛选（2026-10-05 视觉迭代 · 快照列表）
   ============================================================

   后端 `/snapshots` 支持 `from` / `to`，但**离线 fixture 里只有裸键 `/snapshots`**
   （`app/web/public/fixture.json` 没有 `?from=&to=` 变体）。走服务端筛选会让
   `?data=fixture` 取不到数据，而 Step 3 的 11 张基准图全部走 fixture ⇒ 筛选必须在
   页面内对已取的快照列表做，零新请求。

   边界口径放在这里而不是页面组件里，是因为 `verify-pack-ui.mjs` 要拿它算期望值：
   脚本无法 import `.tsx`（Node 的类型擦除不认 JSX），放 `.tsx` 里就只能让脚本
   把口径**抄第二份** —— 本项目已经栽过一次「抄成两份，迟早有一份先被改掉」。 */

/** 快照列表的时间筛选档 */
export type SnapRange = 'all' | 'year' | '6m' | '3m' | 'custom';

/**
 * N 个月前的今天，`YYYY-MM-DD`。
 *
 * 刻意不用 `toISOString()`：那是 **UTC** 日期，在东八区会把凌晨的时刻挪到前一天，
 * 于是「近 3 个月」的边界在不同时段取到不同的日子。用本地字段拼装。
 */
export function monthsAgoISO(n: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 某一档的**闭区间**边界（含端点）。`null` = 该侧不设界。
 *
 * `custom` 档由用户填，可能只有一侧 —— 两侧都空就等于「全部」，这是刻意的：
 * 让「自定义」在没填之前不会把列表清空。
 */
export function snapRangeBounds(
  range: SnapRange,
  custom: { from: string; to: string } = { from: '', to: '' },
  now: Date = new Date()
): { from: string | null; to: string | null } {
  if (range === 'year') return { from: `${now.getFullYear()}-01-01`, to: null };
  if (range === '6m') return { from: monthsAgoISO(6, now), to: null };
  if (range === '3m') return { from: monthsAgoISO(3, now), to: null };
  if (range === 'custom') return { from: custom.from || null, to: custom.to || null };
  return { from: null, to: null };
}

/** 按时间档筛选（含端点）。列表已是倒序，筛选不改顺序。 */
export function filterBySnapRange<T extends { date: string }>(
  list: readonly T[],
  range: SnapRange,
  custom: { from: string; to: string } = { from: '', to: '' },
  now: Date = new Date()
): T[] {
  const { from, to } = snapRangeBounds(range, custom, now);
  return list.filter(s => (!from || s.date >= from) && (!to || s.date <= to));
}
