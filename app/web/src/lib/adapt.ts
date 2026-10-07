/**
 * adapt.ts —— DTO → 领域形态
 *
 * 金额在传输层是微元整数（contracts.ts 的 `Micro`），而领域层一律是 Money，
 * 于是「边界」在这里，且只有这里：`Money.fromMicro()`。
 *
 * 为什么前端需要领域形态：`@app/domain` 的设计前提就是「前后端共享同一份口径」
 * （见该包 index.ts 的注释）。盘点的实时收益预览、快照详情的「当前本位币口径」
 * 都需要在浏览器里算，且必须与服务端算得一模一样 —— 用同一份代码是唯一可靠的办法。
 */
import { Money, makeFxContext, type Account, type BaseCurrencyChange, type FxContext, type Snapshot, type SnapshotItem } from '@app/domain';
import type { AccountDTO, BaseCurrencyChangeDTO, SnapshotDTO, SnapshotItemDTO } from '@app/shared';

const micro = (v: number): Money => Money.fromMicro(BigInt(v));
const optMicro = (v: number | null | undefined): Money | null =>
  v === null || v === undefined ? null : micro(v);

export function dtoItemToDomain(dto: SnapshotItemDTO): SnapshotItem {
  return {
    id: dto.id,
    snapshot_id: dto.snapshot_id,
    account_id: dto.account_id,
    account_name_snapshot: dto.account_name_snapshot,
    platform_id_snapshot: dto.platform_id_snapshot,
    platform_name_snapshot: dto.platform_name_snapshot,
    category_id_snapshot: dto.category_id_snapshot,
    category_name_snapshot: dto.category_name_snapshot,
    type: dto.type,
    currency: dto.currency,
    original_amount: micro(dto.original_amount),
    exchange_rate: micro(dto.exchange_rate),
    amount_in_base: micro(dto.amount_in_base),
    include_in_net_worth: dto.include_in_net_worth,
    tracks_principal: dto.tracks_principal,
    principal: optMicro(dto.principal),
    principal_in_base: optMicro(dto.principal_in_base),
    is_carried_over: dto.is_carried_over,
    tags_snapshot: dto.tags_snapshot.map(t => ({ id: t.id, name: t.name })),
    sort: dto.sort
  };
}

export function dtoSnapshotToDomain(dto: SnapshotDTO): Snapshot {
  return {
    id: dto.id,
    date: dto.date,
    note: dto.note,
    base_currency: dto.base_currency,
    // 领域层的 rates 是「元」数值（7.28），传输层是微元（7280000）
    rates: Object.fromEntries(Object.entries(dto.rates).map(([k, v]) => [k, v / 1e6])),
    total_assets: micro(dto.total_assets),
    total_liabilities: micro(dto.total_liabilities),
    net_worth: micro(dto.net_worth),
    created_at: dto.created_at,
    items: dto.items.map(dtoItemToDomain)
  };
}

export function dtoChangesToDomain(items: readonly BaseCurrencyChangeDTO[]): BaseCurrencyChange[] {
  return items.map(h => ({
    from_currency: h.from_currency,
    to_currency: h.to_currency,
    conversion_rate: h.conversion_rate,
    changed_at: h.changed_at
  }));
}

/** 账户：传输形态与领域形态字段一一对应（金额字段本就没有） */
export function dtoAccountToDomain(dto: AccountDTO): Account {
  return {
    id: dto.id,
    name: dto.name,
    platform_id: dto.platform_id,
    category_id: dto.category_id,
    type: dto.type,
    currency: dto.currency,
    tags: [...dto.tags],
    note: dto.note,
    include_in_net_worth: dto.include_in_net_worth,
    track_principal: dto.track_principal,
    sort: dto.sort,
    archived: dto.archived,
    created_at: dto.created_at,
    updated_at: dto.updated_at
  };
}

/** 折算上下文：当前本位币 + 变更历史 */
export function fxOf(currentBase: string, history: readonly BaseCurrencyChangeDTO[]): FxContext {
  return makeFxContext(currentBase, dtoChangesToDomain(history));
}
