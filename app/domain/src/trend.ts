/**
 * trend.ts —— 快照序列的排序与查找（PRD 规则 16：同日多快照取最后一张）
 */
import type { Snapshot } from './types.ts';

/**
 * 快照序列。
 *
 * 收益与对比类口径都需要「上期基准」与「最近一次被写入快照的明细」，
 * 这要求入参是**整个序列**而不是单张快照（技术设计文档 §1.4 I-04）。
 * 约定：`snapshots` 必须按 `compareSnapshot` 升序 —— 用 `seriesOf()` 构造即可。
 */
export interface SnapshotSeries {
  snapshots: Snapshot[];
}

/**
 * 快照全序：先日期、再 created_at、最后 id。
 * 这是全系统唯一的「哪一张更晚」判定，趋势图、上期基准、对比页都依赖它。
 */
export function compareSnapshot(a: Snapshot, b: Snapshot): -1 | 0 | 1 {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 时间升序 */
export function sortAsc(snapshots: Snapshot[]): Snapshot[] {
  return snapshots.slice().sort(compareSnapshot);
}

/** 时间降序（列表展示用） */
export function sortDesc(snapshots: Snapshot[]): Snapshot[] {
  return snapshots.slice().sort((a, b) => compareSnapshot(b, a));
}

/** 最新一张（全序意义上的最后） */
export function lastSnapshot(snapshots: Snapshot[]): Snapshot | null {
  const asc = sortAsc(snapshots);
  return asc.length ? asc[asc.length - 1] : null;
}

/**
 * 每日最后一张（趋势图与「按日期」对比使用）。
 * PRD 规则 16：同一天存在多张快照时，趋势图取当日最后一张，列表全展示。
 */
export function dailySeries(snapshots: Snapshot[]): Snapshot[] {
  const byDate = new Map<string, Snapshot>();
  for (const s of snapshots) {
    const kept = byDate.get(s.date);
    if (!kept || kept.created_at < s.created_at ||
      (kept.created_at === s.created_at && compareSnapshot(kept, s) < 0)) {
      byDate.set(s.date, s);
    }
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 指定日期及之前、该账户最近一次被写入快照的明细（盘点时的「上次金额」） */
export function prevItemForInventory(
  snapshots: Snapshot[],
  accountId: string,
  date: string
): { snapshot: Snapshot; item: Snapshot['items'][number] } | null {
  const list = sortAsc(snapshots).filter(s => s.date <= date);
  let prev: { snapshot: Snapshot; item: Snapshot['items'][number] } | null = null;
  for (const s of list) {
    const it = s.items.find(x => x.account_id === accountId);
    if (it) prev = { snapshot: s, item: it };
  }
  return prev;
}
