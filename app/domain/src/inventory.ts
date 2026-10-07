/**
 * inventory.ts —— 盘点录入与保存规则（PRD §3.3.1、规则 15）
 *
 * 三态是本模块的核心：
 *   filled  已填写  —— 本次有用户输入
 *   carry   沿用上次 —— 用户未输入，但该账户有历史金额；写入快照并标记 is_carried_over
 *   unfilled 未填写 —— 用户未输入且无历史金额；**不写入本次快照**，保存前须列出清单确认
 *
 * 关键约束：本金未填**不阻断**保存。市值照常计入净资产，只是该期不产出收益指标。
 */
import { Money } from './money.ts';
import type { Account, SnapshotItem } from './types.ts';

export type EntryState = 'filled' | 'carry' | 'unfilled';

export interface EntryDraft {
  accountId: string;
  amount: number | null;
  principal: number | null;
  state: EntryState;
  touched: boolean;
}

/** 空输入的落点取决于有无历史金额：有 → 沿用上次；无 → 未填写 */
export function stateForEmptyInput(hasPrev: boolean): EntryState {
  return hasPrev ? 'carry' : 'unfilled';
}

/**
 * 解析金额输入框的一次变更。
 * 注意：无效输入（parseFloat 得到 NaN）按「空」处理 —— 原型的实现在这一步会留下
 * state='filled' 但 amount=null 的不一致状态，此处收紧。
 */
export function resolveAmountInput(
  raw: string,
  hasPrev: boolean
): { amount: number | null; state: EntryState; touched: boolean } {
  const val = String(raw).trim();
  if (val === '') {
    return { amount: null, state: stateForEmptyInput(hasPrev), touched: false };
  }
  const n = Number.parseFloat(val);
  if (Number.isNaN(n) || !Number.isFinite(n)) {
    return { amount: null, state: stateForEmptyInput(hasPrev), touched: false };
  }
  return { amount: n, state: 'filled', touched: true };
}

export function resolvePrincipalInput(raw: string): { principal: number | null } {
  const val = String(raw).trim();
  if (val === '') return { principal: null };
  const n = Number.parseFloat(val);
  if (Number.isNaN(n) || !Number.isFinite(n)) return { principal: null };
  return { principal: n };
}

/** 是否为「本次会写入快照」的账户 */
export function isWritten(entry: EntryDraft | undefined): boolean {
  if (!entry) return false;
  if (entry.state === 'unfilled') return false;
  return entry.amount !== null && entry.amount !== undefined;
}

/* ============================================================
   校验（保存前的门禁）
   ============================================================ */

export type ValidationCode = 'liability-negative' | 'missing-rate' | 'principal-negative';

export interface ValidationIssue {
  accountId: string;
  accountName: string;
  code: ValidationCode;
  message: string;
}

export function validateEntries(
  accounts: Account[],
  entries: Record<string, EntryDraft>,
  rateOf: (currency: string) => number
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const a of accounts) {
    const e = entries[a.id];
    if (!isWritten(e)) continue;
    const amount = (e as EntryDraft).amount as number;
    if (a.type === 'liability' && amount < 0) {
      issues.push({
        accountId: a.id, accountName: a.name, code: 'liability-negative',
        message: '「' + a.name + '」是负债账户，金额必须填正数'
      });
    }
    if (rateOf(a.currency) <= 0) {
      issues.push({
        accountId: a.id, accountName: a.name, code: 'missing-rate',
        message: '币种 ' + a.currency + ' 的汇率无效'
      });
    }
    if (a.track_principal) {
      const p = (e as EntryDraft).principal;
      if (p !== null && p !== undefined && p < 0) {
        issues.push({
          accountId: a.id, accountName: a.name, code: 'principal-negative',
          message: '「' + a.name + '」本金必须为非负数'
        });
      }
    }
  }
  return issues;
}

/* ============================================================
   待写入明细
   ============================================================ */

export interface PlannedItem {
  account: Account;
  amount: Money;
  rate: number;
  amountInBase: Money;
  principal: Money | null;
  principalInBase: Money | null;
  carriedOver: boolean;
}

export interface PlanResult {
  planned: PlannedItem[];
  /** 未填写 → 不写入快照 */
  unfilled: Account[];
  /** 已开启跟踪但本期未填本金 → 仍写入，只是该期不产出收益指标 */
  noPrincipal: Account[];
}

/**
 * 依据录入状态算出「本次会写入哪些明细」。
 *
 * ⚠ **前提：`entries` 必须为每个要参与的账户提供一条记录**（原型 `invFresh()` 就是
 * 这样初始化的）。本函数对「没有 entry 的账户」是 `continue` —— 既不写入、也不进
 * `unfilled`，调用方若送了不完整的 map，那些账户会被**静默丢弃**。
 *
 * 服务端 `/inventory/*` 已在自己一侧补齐（见 `modules/inventory.ts` 的
 * `normalizeEntries`）；前端的实时预览也要从「每账户一条」的初始状态出发。
 */
export function planItems(
  accounts: Account[],
  entries: Record<string, EntryDraft>,
  rateOf: (currency: string) => number
): PlanResult {
  const planned: PlannedItem[] = [];
  const unfilled: Account[] = [];
  const noPrincipal: Account[] = [];

  for (const a of accounts) {
    const e = entries[a.id];
    if (!e) continue;
    if (!isWritten(e)) { unfilled.push(a); continue; }

    const amount = Money.fromNumber(e.amount as number);
    const rate = rateOf(a.currency);
    const principal = a.track_principal && e.principal !== null && e.principal !== undefined
      ? Money.fromNumber(e.principal)
      : null;

    if (a.track_principal && principal === null) noPrincipal.push(a);

    planned.push({
      account: a,
      amount,
      rate,
      amountInBase: amount.mulByRatio(rate),
      principal,
      principalInBase: principal === null ? null : principal.mulByRatio(rate),
      carriedOver: e.state === 'carry'
    });
  }
  return { planned, unfilled, noPrincipal };
}

export interface InventoryTotals {
  totalAssets: Money;
  totalLiabilities: Money;
  netWorth: Money;
  filled: number;
  carry: number;
  unfilled: number;
  noPrincipal: number;
}

/** 录入过程的实时汇总（保存前预览，与保存后的权威值同源） */
export function inventoryTotals(plan: PlanResult): InventoryTotals {
  let ta = 0n;
  let tl = 0n;
  let filled = 0;
  let carry = 0;
  let noPrincipal = 0;

  for (const p of plan.planned) {
    if (p.carriedOver) carry++; else filled++;
    if (p.account.track_principal && p.principal === null) noPrincipal++;
    if (!p.account.include_in_net_worth) continue;
    if (p.account.type === 'asset') ta += p.amountInBase.micro;
    else tl += p.amountInBase.micro;
  }

  return {
    totalAssets: Money.fromMicro(ta),
    totalLiabilities: Money.fromMicro(tl),
    netWorth: Money.fromMicro(ta - tl),
    filled, carry,
    unfilled: plan.unfilled.length,
    noPrincipal
  };
}

/** 把计划转成快照明细（snapshot_id 由仓储层补齐） */
export function toSnapshotItems(
  plan: PlanResult,
  snapshotId: string,
  resolve: {
    platformName: (id: string | null) => string;
    categoryName: (id: string) => string;
    tagName: (id: string) => string;
  }
): SnapshotItem[] {
  return plan.planned.map((p, i) => {
    const a = p.account;
    return {
      id: 'si-' + snapshotId + '-' + a.id,
      snapshot_id: snapshotId,
      account_id: a.id,
      account_name_snapshot: a.name,
      platform_id_snapshot: a.platform_id,
      platform_name_snapshot: a.platform_id ? resolve.platformName(a.platform_id) : '未指定平台',
      category_id_snapshot: a.category_id,
      category_name_snapshot: resolve.categoryName(a.category_id),
      type: a.type,
      currency: a.currency,
      original_amount: p.amount,
      exchange_rate: Money.fromNumber(p.rate),
      amount_in_base: p.amountInBase,
      include_in_net_worth: a.include_in_net_worth,
      tracks_principal: a.track_principal,
      principal: p.principal,
      principal_in_base: p.principalInBase,
      is_carried_over: p.carriedOver,
      tags_snapshot: a.tags.map(t => ({ id: t, name: resolve.tagName(t) })),
      sort: i + 1
    };
  });
}
