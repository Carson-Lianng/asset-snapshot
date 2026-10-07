/**
 * categoryMix.ts —— 分类 × 币种聚合（首页 #8 / 报表 #12 的饼图悬浮明细共用）
 *
 * 为什么在前端算：现有端点里没有「某分类的币种构成」这个组合，而快照明细本来就随
 * `/snapshots/:id` 一起返回，所以直接在前端按 `category_id_snapshot` × `currency` 聚合。
 *
 * ⚠ 聚合口径必须与 `/reports/breakdown?dim=category` **逐项一致**，否则悬浮里的
 * 「分类合计」会和扇区上的数字对不上。三处对齐（对照 domain/networth.ts 的 breakdown）：
 *   1. 只纳入 `include_in_net_worth`（breakdown 第一行就把不纳入的 `continue` 掉了）；
 *   2. 分类 key = `category_id_snapshot || 'none'`（与 breakdown 的分类分支逐字相同）；
 *   3. `origin` 口径下 `itemValueIn` 返回的就是 `amount_in_base`（见 domain/fx.ts）。
 *
 * 另：只取与饼图同侧的那一类。扇区值分别取 `row.asset` / `row.liability`，
 * 所以「资产配置」要资产项、「负债结构」要负债项，混入另一侧就会对不上。
 */
import type { SnapshotItemDTO } from '@app/shared';

export type MixSide = 'asset' | 'liability';

export function categoryCurrencyMix(
  items: readonly SnapshotItemDTO[] | undefined,
  side: MixSide
): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const it of items ?? []) {
    if (!it.include_in_net_worth || it.type !== side) continue;
    const k = it.category_id_snapshot || 'none';
    let inner = m.get(k);
    if (!inner) {
      inner = new Map<string, number>();
      m.set(k, inner);
    }
    inner.set(it.currency, (inner.get(it.currency) ?? 0) + Number(it.amount_in_base));
  }
  return m;
}
