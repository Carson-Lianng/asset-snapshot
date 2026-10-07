/**
 * drill.ts —— 「维度分布」按分类下钻（第三批 #4）
 *
 * 点「资产配置 / 负债结构」饼图里的一个扇区，下方的**平台分布 / 币种分布 / 标签分布**
 * 就只统计该分类内的项；再点同一片、或点面包屑的「← 返回整体」恢复。
 *
 * ── 为什么在前端算，而且必须调用领域层同一份函数 ──
 * 服务端的 `/reports/platform-currency` 与 `/reports/currency` 只接受 `snapshot_id`，
 * 没有「再加一个分类过滤」的参数。可选的只有三条路：
 *   1. 给两个端点加过滤参数 —— 动服务端契约、动缓存键、动 Step 2 的黄金值；
 *   2. 在前端把聚合逻辑**重写一遍** —— 这是这个项目反复栽过的坑：把口径抄成两份，
 *      迟早有一份先被改掉（当初「上次金额」与「收益预览」就是靠直接调用
 *      `@app/domain` 才没有漂）；
 *   3. 在前端**收窄明细**，再调用领域层那两个函数 —— 本文件的做法。
 * 选 3：算出来的行与服务端整体视图是**同一份代码**的产物，只要收窄口径对得上就不会漂。
 *
 * ── 收窄口径 ──
 * 与 `categoryMix.ts` / `/reports/breakdown?dim=category` 逐字一致：
 *   · 只取 `type === drill.side` 的一侧（资产配置取资产项，负债结构取负债项）；
 *   · 分类 key = `category_id_snapshot || 'none'`。
 * 这里**不判** `include_in_net_worth` —— 领域层的三个函数自己会跳过，这里再判一次
 * 等于把同一条规则写成两份。
 *
 * ── 一个预期行为 ──
 * 在资产侧下钻时，负债项的被过滤掉是**有意的**：下钻问的是「这个分类里有什么」，
 * 而一个资产分类里的负债项（信用卡溢缴那种）不属于它。所以下钻后「平台分布」的行
 * 只统计该分类内的资产。
 *
 * ── 返回的是 DTO 而不是领域行 ──
 * 界面组件（`PlatformBars` / `CurrencyPie`）吃的是 DTO。转换写成一份，
 * 与 `app/server/src/lib/dto.ts` 的同名转换逐字段对应 —— 那三个函数本来就把
 * 「领域 Money → 微元整数」的边界收在一处，这里是它在浏览器里的对侧。
 */
import {
  breakdown,
  currencyBreakdown,
  platformCurrencyBreakdown,
  type Money,
  type Snapshot,
  type SnapshotItem
} from '@app/domain';
import type { CurrencyRowDTO, Micro, PlatformCurrencyRowDTO, ViewMode } from '@app/shared';
import type { MixSide } from './categoryMix.ts';
import type { FxContext } from '@app/domain';

/** 下钻范围：哪一侧的哪个分类 */
export interface Drill {
  side: MixSide;
  /** 分类 key，与 `/reports/breakdown` 的分类分支一致（`category_id_snapshot || 'none'`） */
  key: string;
  /** 展示名（面包屑要显示它，而明细里只有 key） */
  name: string;
}

const mic = (m: Money): Micro => Number(m.toMicro());

/** 分类 key 的取法 —— 与 `categoryMix.ts`、领域层 `breakdown` 的分类分支逐字相同 */
export function categoryKeyOf(it: SnapshotItem): string {
  return it.category_id_snapshot || 'none';
}

/**
 * 按「某一侧 + 某一分类」收窄一份领域快照。
 *
 * 返回新对象（`{...snap, items: [...]}`），不改入参 —— 领域函数只读 `items` 与
 * `base_currency`，所以浅拷贝足够。
 */
export function drillSnapshot(snap: Snapshot, drill: Drill): Snapshot {
  return {
    ...snap,
    items: snap.items.filter(it => it.type === drill.side && categoryKeyOf(it) === drill.key)
  };
}

export interface DrillBreakdowns {
  platforms: PlatformCurrencyRowDTO[];
  currencies: CurrencyRowDTO[];
  /** 标签分布（`BarList` 的入参形态）；一个账户可有多个标签，故合计可能大于该分类金额 */
  tags: Array<{ name: string; v: Micro }>;
}

/**
 * 下钻后的三个分布。**三个都从同一份收窄后的快照算出来** —— 分别收窄三次会让
 * 「平台合计 ≠ 币种合计 ≠ 标签合计」这类不一致有空子可钻。
 *
 * `ctx` 在本调用里其实用不到（`mode = 'origin'` 时 `itemValueIn` 第一行就返回
 * `amount_in_base`，见 domain/fx.ts）。仍然要求传：签名跟着领域层走，将来若把
 * 下钻接到「当前本位币口径」，这里不需要改调用方式。传 `makeFxContext(base, [])` 即可。
 */
export function drillBreakdowns(
  snap: Snapshot,
  drill: Drill,
  mode: ViewMode,
  ctx: FxContext,
  currencyMeta: (code: string) => { name: string; symbol: string }
): DrillBreakdowns {
  const sub = drillSnapshot(snap, drill);
  return {
    platforms: platformCurrencyBreakdown(sub, mode, ctx, currencyMeta).map(r => ({
      key: r.key,
      name: r.name,
      asset: mic(r.asset),
      liability: mic(r.liability),
      total: mic(r.total),
      accounts: r.accounts,
      currencies: r.currencies,
      by_currency: r.byCur.map(c => ({
        code: c.code,
        name: c.name,
        symbol: c.symbol,
        orig: mic(c.orig),
        base: mic(c.base),
        asset: mic(c.asset),
        liability: mic(c.liability),
        n: c.n
      }))
    })),
    currencies: currencyBreakdown(sub, mode, ctx, currencyMeta).map(c => ({
      code: c.code,
      name: c.name,
      symbol: c.symbol,
      orig: mic(c.orig),
      base: mic(c.base),
      n: c.n
    })),
    tags: breakdown(sub, 'tag', mode, ctx).map(r => ({
      name: r.name,
      v: mic(r.asset.add(r.liability))
    }))
  };
}

/**
 * 币种代码 → 展示名/符号，供领域函数的 `currencyMeta` 参数用。
 *
 * 原料取 `/reports/currency` 的行：下钻子集一定是整体视图的子集，所以子集里出现的
 * 每个代码都能在这一份里找到（找不到时退回代码本身，避免出现空白标题）。
 */
export function currencyMetaOf(
  rows: readonly CurrencyRowDTO[]
): (code: string) => { name: string; symbol: string } {
  const m = new Map(rows.map(r => [r.code, r]));
  return code => {
    const r = m.get(code);
    return { name: r?.name ?? code, symbol: r?.symbol ?? '' };
  };
}
