/**
 * 领域类型定义
 *
 * 两类形态刻意分开：
 *   - XXXJSON   —— 落库 / 传输形态，金额是 number（元，最多 2~6 位小数）
 *   - XXX       —— 领域形态，金额一律是 Money
 *
 * 边界只有一个：hydrate() 系列函数。仓储层负责 JSON ↔ 领域，其余层只见领域形态。
 * 这样「金额绝不裸 number」这条约束可以在类型层面被强制。
 */
import { Money } from './money.ts';

export type AccountType = 'asset' | 'liability';

/** 汇总维度 */
export type Dim = 'account' | 'platform' | 'category' | 'currency' | 'tag';

/** 口径：origin = 快照原口径；current = 按当前本位币折算（参考值） */
export type ViewMode = 'origin' | 'current';

/* ============================================================
   基础实体
   ============================================================ */

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  sort: number;
  enabled: boolean;
}

export interface Platform {
  id: string;
  name: string;
  type: string;
  note: string;
  sort: number;
  enabled: boolean;
}

export interface Category {
  id: string;
  name: string;
  type: AccountType;
  /** 新建该分类下的资产账户时，是否默认开启「跟踪本金」（PRD §3.1.5 / §5.6） */
  default_track_principal: boolean;
  sort: number;
  enabled: boolean;
}

export interface Tag {
  id: string;
  name: string;
  sort: number;
  enabled: boolean;
}

export interface Account {
  id: string;
  name: string;
  platform_id: string | null;
  category_id: string;
  type: AccountType;
  currency: string;
  tags: string[];
  note: string;
  include_in_net_worth: boolean;
  track_principal: boolean;
  sort: number;
  archived: boolean;
  created_at: string;
  updated_at?: string;
}

/** 本位币变更历史（折算链的原料） */
export interface BaseCurrencyChange {
  from_currency: string;
  to_currency: string;
  /** 1 旧本位币 = conversion_rate 新本位币 */
  conversion_rate: number;
  changed_at: string;
}

/* ============================================================
   快照（领域形态）
   ============================================================ */

export interface TagSnapshot {
  id: string;
  name: string;
}

export interface SnapshotItem {
  id: string;
  snapshot_id: string;
  account_id: string;

  /* 冗余快照字段：账户/平台/分类改名或删除后，历史仍可正确展示与匹配 */
  account_name_snapshot: string;
  platform_id_snapshot: string | null;
  platform_name_snapshot: string;
  category_id_snapshot: string;
  category_name_snapshot: string;

  type: AccountType;
  currency: string;

  original_amount: Money;
  exchange_rate: Money;
  amount_in_base: Money;

  include_in_net_worth: boolean;

  /* 本金跟踪（仅资产账户可开启） */
  tracks_principal: boolean;
  principal: Money | null;
  principal_in_base: Money | null;

  is_carried_over: boolean;
  tags_snapshot: TagSnapshot[];
  sort: number;
}

export interface Snapshot {
  id: string;
  date: string;
  note: string;
  base_currency: string;
  /** 保存时的汇率表，键为币种代码 */
  rates: Record<string, number>;
  total_assets: Money;
  total_liabilities: Money;
  net_worth: Money;
  created_at: string;
  items: SnapshotItem[];
}

/* ============================================================
   落库 / 传输形态（金额为 number）
   ============================================================ */

export interface SnapshotItemJSON {
  id: string;
  snapshot_id: string;
  account_id: string;
  account_name_snapshot: string;
  platform_id_snapshot: string | null;
  platform_name_snapshot: string;
  category_id_snapshot: string;
  category_name_snapshot: string;
  type: AccountType;
  currency: string;
  original_amount: number;
  exchange_rate: number;
  amount_in_base: number;
  include_in_net_worth: boolean;
  tracks_principal: boolean;
  principal: number | null;
  principal_in_base: number | null;
  is_carried_over: boolean;
  tags_snapshot: TagSnapshot[];
  sort: number;
}

export interface SnapshotJSON {
  id: string;
  date: string;
  note: string;
  base_currency: string;
  rates: Record<string, number>;
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  created_at: string;
  items: SnapshotItemJSON[];
}

/* ============================================================
   边界：JSON → 领域
   ============================================================ */

const optMoney = (v: number | null | undefined): Money | null =>
  v === null || v === undefined ? null : Money.fromNumber(v);

export function hydrateItem(json: SnapshotItemJSON): SnapshotItem {
  return {
    id: json.id,
    snapshot_id: json.snapshot_id,
    account_id: json.account_id,
    account_name_snapshot: json.account_name_snapshot,
    platform_id_snapshot: json.platform_id_snapshot ?? null,
    platform_name_snapshot: json.platform_name_snapshot,
    category_id_snapshot: json.category_id_snapshot,
    category_name_snapshot: json.category_name_snapshot,
    type: json.type,
    currency: json.currency,
    original_amount: Money.fromNumber(json.original_amount),
    exchange_rate: Money.fromNumber(json.exchange_rate),
    amount_in_base: Money.fromNumber(json.amount_in_base),
    include_in_net_worth: json.include_in_net_worth,
    tracks_principal: !!json.tracks_principal,
    principal: optMoney(json.principal),
    principal_in_base: optMoney(json.principal_in_base),
    is_carried_over: !!json.is_carried_over,
    tags_snapshot: (json.tags_snapshot ?? []).map(t => ({ id: t.id, name: t.name })),
    sort: json.sort
  };
}

export function hydrateSnapshot(json: SnapshotJSON): Snapshot {
  return {
    id: json.id,
    date: json.date,
    note: json.note,
    base_currency: json.base_currency,
    rates: { ...json.rates },
    total_assets: Money.fromNumber(json.total_assets),
    total_liabilities: Money.fromNumber(json.total_liabilities),
    net_worth: Money.fromNumber(json.net_worth),
    created_at: json.created_at,
    items: json.items.map(hydrateItem)
  };
}
