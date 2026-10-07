/**
 * fx.ts —— 双口径折算（PRD §3.1.1 / 规则 1、2、10）
 *
 * 核心规则：本位币可以变更，但历史快照的原口径不可变。
 * 把历史快照折算到「当前本位币」时，只累积**该快照保存之后**发生的本位币变更，
 * 按 changed_at 升序**连乘**：新汇率 = 旧汇率 × R（注意是乘，不是除）。
 */
import { Money } from './money.ts';
import type { BaseCurrencyChange, Snapshot, SnapshotItem, ViewMode } from './types.ts';

/** 折算上下文：当前本位币 + 变更历史（已按 changed_at 升序） */
export interface FxContext {
  currentBase: string;
  history: BaseCurrencyChange[];
}

export function makeFxContext(currentBase: string, history: BaseCurrencyChange[] = []): FxContext {
  return {
    currentBase,
    history: history.slice().sort((a, b) =>
      a.changed_at < b.changed_at ? -1 : a.changed_at > b.changed_at ? 1 : 0)
  };
}

/**
 * 快照原口径 → 当前本位币的比率。
 * 返回 null 表示折算链断裂（历史路径不通），界面须按「无法折算」处理，不得当 0 用。
 */
export function ratioToCurrent(snapshot: Snapshot, ctx: FxContext): number | null {
  if (snapshot.base_currency === ctx.currentBase) return 1;
  let factor = 1;
  let cur = snapshot.base_currency;
  for (const h of ctx.history) {
    if (h.changed_at <= snapshot.created_at) continue;
    if (h.from_currency === cur) {
      factor *= h.conversion_rate;
      cur = h.to_currency;
    }
    if (cur === ctx.currentBase) break;
  }
  return cur === ctx.currentBase ? factor : null;
}

/** 明细金额按指定口径取值；current 口径下若链断裂返回 null */
export function itemValueIn(
  item: SnapshotItem,
  snapshot: Snapshot,
  mode: ViewMode,
  ctx: FxContext
): Money | null {
  if (mode !== 'current') return item.amount_in_base;
  const f = ratioToCurrent(snapshot, ctx);
  if (f === null) return null;
  /* 比率可能远超 6 位小数，必须走 mulByRatio 的 15 位标度 */
  return item.amount_in_base.mulByRatio(f);
}

export interface TotalsIn {
  ta: Money | null;
  tl: Money | null;
  nw: Money | null;
  /** true 表示这是折算后的参考值，界面须标注 */
  ref: boolean;
}

/** 快照总额按指定口径取值 */
export function snapTotalsIn(snapshot: Snapshot, mode: ViewMode, ctx: FxContext): TotalsIn {
  if (mode !== 'current' || snapshot.base_currency === ctx.currentBase) {
    return {
      ta: snapshot.total_assets,
      tl: snapshot.total_liabilities,
      nw: snapshot.net_worth,
      ref: false
    };
  }
  const f = ratioToCurrent(snapshot, ctx);
  if (f === null) return { ta: null, tl: null, nw: null, ref: true };
  return {
    ta: snapshot.total_assets.mulByRatio(f),
    tl: snapshot.total_liabilities.mulByRatio(f),
    nw: snapshot.net_worth.mulByRatio(f),
    ref: true
  };
}

/**
 * 单条本位币变更的自动反算（PRD S1-6）：
 * 用户只填「1 旧本位币 = R 新本位币」，整张汇率表按 新汇率 = 旧汇率 × R 重算。
 */
export function rebaseRates(
  rates: Record<string, number>,
  conversionRate: number
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of Object.keys(rates)) {
    out[code] = rates[code] * conversionRate;
  }
  return out;
}

/* ============================================================
   从公开汇率源生成默认汇率表（第三批 #1 / #2）
   ============================================================ */

/**
 * 公开源返回的表，方向统一为 **`1 base = rates[code] code`**。
 *
 * frankfurter（`api.frankfurter.app/latest?from=CNY`）与 open.er-api.com
 * （`/v6/latest/CNY`）**都是这个方向** —— 它们回答的是「一个基准币值多少目标币」。
 * 这是本函数唯一容易写反的地方，所以单独写成一个带名字的类型，并在调用处断言。
 */
export interface FxSourceTable {
  base: string;
  rates: Record<string, number>;
}

export interface FxConvertedRow {
  code: string;
  /** 1 单位该币种 = 这么多微元的本位币（本系统的口径） */
  micro: number;
  /** 源给的比值（`1 base = sourceRate code`），随响应下发供界面展示换算依据 */
  sourceRate: number;
}

export interface FxConversion {
  rows: FxConvertedRow[];
  /** 源里没有、或值不是有限正数的币种 —— **保留原汇率，不动它们** */
  skipped: string[];
}

/**
 * 源表 → 本系统的汇率表（微元）。
 *
 * ── 为什么必须取倒数 ──
 * 源给的是「1 基准币 = R 原币」（例如 CNY→USD 是 0.1374），
 * 系统要的是「1 原币 = X 本位币」（USD→CNY 是 7.2780）。方向相反，必须 `1 / R`。
 * 直接乘会得到一个数量级与含义都错的数，而且**不会报错、也不会被黄金值抓到**
 * （黄金值是自拍快照）——所以这一条的断言写成了「取值等于 1/r」而不是「取值大于 0」。
 *
 * ── 三条边界 ──
 *   · 基准币自身恒为 1（`1_000_000` 微元）：源可能不返回它，也可能返回 1，
 *     一律直接赋值 —— 让浮点去决定「1 是不是 1」没有意义（与 `rebaseRates` 的
 *     调用方以及服务端的 `ONE` 同一处理）。
 *   · 源里没有该币种 → 进 `skipped`，**保留库里原值**，绝不清零。
 *   · 值非有限正数（0 / 负数 / NaN / 字符串）→ 同样进 `skipped`。
 *
 * @param codes 只换算**库内已有**的币种：源通常多给几十个（泰铢、兰特…），
 *              把库外的写进汇率表等于凭空多出一批「使用中=否」的币种
 */
export function ratesFromSource(
  table: FxSourceTable,
  base: string,
  codes: readonly string[]
): FxConversion {
  if (table.base !== base) {
    /* 源换了基准币（或我们请求时传错）时不能猜：整表的方向都变了 */
    throw new Error(`汇率源的基准币是 ${table.base}，与本位币 ${base} 不一致`);
  }
  const rows: FxConvertedRow[] = [];
  const skipped: string[] = [];
  for (const code of codes) {
    if (code === base) {
      rows.push({ code, micro: 1_000_000, sourceRate: 1 });
      continue;
    }
    const r = table.rates[code];
    if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) {
      skipped.push(code);
      continue;
    }
    /* 微元换算走 Money —— 全项目唯一的舍入实现（六位小数、半值向上） */
    const micro = Number(Money.fromNumber(1 / r).toMicro());
    if (micro <= 0) {
      skipped.push(code);
      continue;
    }
    rows.push({ code, micro, sourceRate: r });
  }
  return { rows, skipped };
}
