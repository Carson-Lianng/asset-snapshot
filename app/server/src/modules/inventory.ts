/**
 * 盘点模块（技术设计文档 §8.3 盘点 · §8.4 事务边界）
 *
 * Step 4 起，盘点草稿由**服务端持有**（原本的 localStorage 版本已移除）：
 *   · 多标签页与刷新都不丢；不存在「两份真相」；
 *   · `version` 做乐观锁，写入冲突返回 409（ADR-10）。
 *
 * 计算一律复用 `@app/domain` 的 `planItems` / `inventoryTotals` / `toSnapshotItems` /
 * `validateEntries` —— 与前端实时预览**同一份代码**，所以「确认页显示 A、保存后是 B」
 * 这类漂移在结构上不可能发生。
 *
 * 草稿的落库形态是领域层的 `EntryDraft`（金额为**元** number），因为它要直接喂给
 * `planItems`；API 边界上仍是微元整数。这是本模块唯一的形态差异，单独注明。
 */
import { Hono } from 'hono';
import {
  draftPutSchema,
  inventoryPreviewSchema,
  inventorySaveSchema,
  type InventoryEntryDTO
} from '@app/shared';
import {
  inventoryTotals,
  planItems,
  toSnapshotItems,
  validateEntries,
  type Account,
  type EntryDraft,
  type PlanResult
} from '@app/domain';
import type { AppEnv } from '../middleware.ts';
import type { Db } from '../db/client.ts';
import * as svc from '../services.ts';
import * as w from '../db/writes.ts';
import { listAccounts, listCategories, listPlatforms, listTags, snapshotCounts } from '../db/repo.ts';
import { safeBackup, type BackupLog } from '../db/backup.ts';
import {
  toAccountDTO,
  toInventoryDraftDTO,
  toInventoryPreviewDTO,
  toInventorySaveDTO,
  toSnapshotSummaryDTO
} from '../lib/dto.ts';
import { fail } from '../lib/errors.ts';

const ZERO_COUNTS = { item_count: 0, carried_over: 0, tracked: 0, no_principal: 0 };

/** 微元 → 元。仅用于把 API 入参转成领域层要的 number。 */
const yuan = (micro: number | null): number | null => (micro === null ? null : micro / 1_000_000);

/* ============================================================
   上下文
   ============================================================ */

/** 当前汇率表：同时给出「元」形态（喂领域层）与微元形态（回给前端） */
function ratesOf(db: Db): { baseCurrency: string; yuan: Record<string, number>; micro: Record<string, number> } {
  const baseCurrency = svc.queryContext(db).baseCurrency;
  const yuanRates: Record<string, number> = {};
  const microRates: Record<string, number> = {};
  for (const c of svc.currencyService(db, true)) {
    const micro = c.rate_to_base_micro ?? 0;
    microRates[c.code] = micro;
    yuanRates[c.code] = micro / 1_000_000;
  }
  return { baseCurrency, yuan: yuanRates, micro: microRates };
}

/**
 * 汇率查询器。本位币恒为 1 —— 与原型 `a.currency === baseCur() ? 1 : rates[code]` 一致，
 * 不依赖表里那一行恰好等于 1。
 */
function rateResolver(baseCurrency: string, rates: Record<string, number>) {
  return (currency: string): number => (currency === baseCurrency ? 1 : (rates[currency] ?? 0));
}

/** API 入参（微元）→ 领域形态（元） */
function toDomainEntries(entries: Record<string, InventoryEntryDTO>): Record<string, EntryDraft> {
  const out: Record<string, EntryDraft> = {};
  for (const [id, e] of Object.entries(entries)) {
    out[id] = {
      accountId: id,
      amount: yuan(e.amount),
      principal: yuan(e.principal),
      state: e.state,
      touched: e.state === 'filled'
    };
  }
  return out;
}

/**
 * 参与本次盘点的账户。
 *
 * 未归档的当然都在；此外**只要前端为某个已归档账户送了录入值，它也算数** ——
 * 否则用户在界面上填了数字却不会被保存，属于静默丢数据。
 */
function accountsFor(db: Db, entries: Record<string, InventoryEntryDTO>): Account[] {
  return listAccounts(db).filter(a => !a.archived || a.id in entries);
}

/**
 * 把前端送来的 entries **补齐成「每个账户都有一条」**，口径对齐原型 `invFresh()`：
 *
 * ```js
 * DB.accounts.filter(a => !a.archived).forEach(a => {
 *   const prev = prevItemForInventory(a.id, date);
 *   entries[a.id] = { amount: prev ? prev.item.original_amount : null, state: prev ? 'carry' : 'unfilled' };
 * });
 * ```
 *
 * 为什么必须做这一步（而不是信任客户端送全）：
 *   1. `planItems` 对「没有 entry 的账户」是 `continue` —— 既不写入快照、也不进未填写
 *      清单，是一个**静默黑洞**。客户端漏送一个账户，用户看到的就是「少了一行」而没有任何提示。
 *   2. 「未填写清单」是保存前的门禁。门禁必须由服务端算，不能靠客户端自报 —— 否则
 *      一个漏送账户的前端就能把「不写入」变成静默行为。
 *   3. 设计文档给 `/inventory/session` 的返回只有 `lastAmounts`，**没有本金**，
 *      客户端本就无法独立还原「沿用上次」的本金。补齐放在服务端，两边就不会各算一套。
 *
 * 两条细化规则：
 *   · 客户端**明确送了** entry 的，一律以客户端的 `state` 为准（用户改过的意图优先）。
 *   · 客户端送 `state: 'carry'` 但金额为空的（界面上「沿用上次」但没回填数字），
 *     用历史金额回填 —— 这是 `carry` 这个词的定义，不是容错。
 */
function normalizeEntries(
  db: Db,
  accounts: Account[],
  entries: Record<string, InventoryEntryDTO>
): Record<string, InventoryEntryDTO> {
  const lastAmounts = w.lastAmountsByAccount(db);
  const lastPrincipals = w.lastPrincipalsByAccount(db);
  const out: Record<string, InventoryEntryDTO> = {};

  for (const a of accounts) {
    const hasPrev = Object.prototype.hasOwnProperty.call(lastAmounts, a.id);
    const prevAmount = hasPrev ? lastAmounts[a.id] : null;
    // 未跟踪本金的账户不该有本金，历史里即使有也不沿用
    const prevPrincipal = a.track_principal ? (lastPrincipals[a.id] ?? null) : null;
    const supplied = entries[a.id];

    if (!supplied) {
      out[a.id] = {
        amount: prevAmount,
        principal: prevPrincipal,
        state: hasPrev ? 'carry' : 'unfilled'
      };
      continue;
    }

    out[a.id] = {
      // `??` 而非 `||`：0 是合法金额，不能被当成空
      amount: supplied.amount ?? (supplied.state === 'carry' ? prevAmount : null),
      principal: supplied.principal ?? (supplied.state === 'carry' ? prevPrincipal : null),
      state: supplied.state
    };
  }
  return out;
}

/**
 * 合并汇率：**DB 为底、客户端覆盖、本位币恒为 1**（见 I-22）。
 *
 * 为什么是「覆盖」而不是「只认客户端送来的那张表」：
 * 界面上的预览表只列**启用中的币种**，而 DB 里可能还有已停用但历史账户仍在用的币种；
 * 若整表替换，那些币种会掉成 0，被 `validateEntries` 判成「缺汇率」直接拦住保存 ——
 * 用户什么也没改却突然存不了盘。以 DB 兜底才不会有这个副作用。
 *
 * 本位币不从客户端取：`rateResolver` 本来就恒返回 1，让它由客户端的数据决定
 * 只会在 `snapshot_rate` 里留下一行自相矛盾的值。
 */
function mergeRates(
  db: Db,
  clientRates?: Record<string, number>
): { baseCurrency: string; yuan: Record<string, number>; micro: Record<string, number> } {
  const base = ratesOf(db);
  if (!clientRates) return base;
  const yuan = { ...base.yuan };
  const micro = { ...base.micro };
  for (const [code, m] of Object.entries(clientRates)) {
    if (code === base.baseCurrency) continue;
    yuan[code] = m / 1_000_000;
    micro[code] = m;
  }
  return { ...base, yuan, micro };
}

function resolvers(db: Db) {
  const platformName = new Map(listPlatforms(db).map(p => [p.id, p.name]));
  const categoryName = new Map(listCategories(db).map(c => [c.id, c.name]));
  const tagName = new Map(listTags(db).map(t => [t.id, t.name]));
  return {
    platformName: (id: string | null) => (id ? (platformName.get(id) ?? '未指定平台') : '未指定平台'),
    categoryName: (id: string) => categoryName.get(id) ?? '',
    tagName: (id: string) => tagName.get(id) ?? id
  };
}

interface Computed {
  baseCurrency: string;
  ratesYuan: Record<string, number>;
  ratesMicro: Record<string, number>;
  accounts: Account[];
  entries: Record<string, EntryDraft>;
  plan: PlanResult;
  totals: ReturnType<typeof inventoryTotals>;
  issues: ReturnType<typeof validateEntries>;
  excludedFromNetWorth: number;
}

function compute(
  db: Db,
  date: string,
  entries: Record<string, InventoryEntryDTO>,
  clientRates?: Record<string, number>
): Computed & { date: string } {
  const { baseCurrency, yuan: ratesYuan, micro: ratesMicro } = mergeRates(db, clientRates);
  // 账户集合先按「客户端送来的原始 entries」定：只有被明确点名的归档账户才参与本次盘点
  const accounts = accountsFor(db, entries);
  // 再把 entries 补齐到与账户集合一一对应（见 normalizeEntries 的说明）
  const full = normalizeEntries(db, accounts, entries);
  const domainEntries = toDomainEntries(full);
  const rateOf = rateResolver(baseCurrency, ratesYuan);
  const plan = planItems(accounts, domainEntries, rateOf);
  return {
    date,
    baseCurrency,
    ratesYuan,
    ratesMicro,
    accounts,
    entries: domainEntries,
    plan,
    totals: inventoryTotals(plan),
    issues: validateEntries(accounts, domainEntries, rateOf),
    excludedFromNetWorth: listAccounts(db).filter(a => !a.include_in_net_worth && !a.archived).length
  };
}

export interface InventoryRoutesOptions {
  /**
   * 保存快照后自动备份（§6.6「每次成功保存快照后一次」）。
   *
   * 传 `null` 表示关闭，由装配层的 `BACKUP_ON_SNAPSHOT=false` 决定 ——
   * 盘点模块自己不读环境变量，配置只有一个来源。
   */
  backup: { dataDir: string; keep: number; log: BackupLog } | null;
}

export function createInventoryRoutes(
  db: Db,
  opts: InventoryRoutesOptions = { backup: null }
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /**
   * 开启盘点：一次性把向导要用的全部原料返回，减少往返（§8.3 原文如此）。
   * `lastAmounts` 是「沿用上次」的原料，微元整数。
   */
  r.post('/inventory/session', c => {
    const { baseCurrency, micro } = ratesOf(db);
    return c.json({
      draft: toInventoryDraftDTO(w.getDraft(db)),
      accounts: listAccounts(db).map(toAccountDTO),
      lastAmounts: w.lastAmountsByAccount(db),
      rates: micro,
      base_currency: baseCurrency,
      today: new Date().toLocaleDateString('sv-SE') // sv-SE 即 YYYY-MM-DD，且用本地时区
    });
  });

  r.get('/inventory/draft', c => {
    const { baseCurrency, micro } = ratesOf(db);
    return c.json({
      draft: toInventoryDraftDTO(w.getDraft(db)),
      base_currency: baseCurrency,
      rates: micro
    });
  });

  /** 自动保存草稿。`version` 不匹配 → 409（多标签页保护）。 */
  r.put('/inventory/draft', async c => {
    const body = draftPutSchema.parse(await c.req.json());
    const data = {
      date: body.date,
      note: body.note,
      entries: toDomainEntries(body.entries),
      /* 原样存微元：草稿的落库形态里只有 entries 是「元」，
         因为它要直接喂给 planItems；rates 不参与领域计算，不必换单位 */
      ...(body.rates ? { rates: body.rates } : {})
    };
    const next = w.putDraft(db, data, body.version);
    if (next < 0) {
      throw fail.conflict('草稿已被其它标签页修改，请刷新后重试', {
        current_version: w.getDraft(db)?.version ?? 0
      });
    }
    return c.json({ version: next });
  });

  r.delete('/inventory/draft', c => {
    w.deleteDraft(db);
    return c.json({ discarded: true });
  });

  /** 服务端权威试算 —— 确认页取的就是这里的数 */
  r.post('/inventory/preview', async c => {
    const body = inventoryPreviewSchema.parse(await c.req.json());
    const rv = resolvers(db);
    const computed = compute(db, body.date, body.entries, body.rates);
    return c.json(
      toInventoryPreviewDTO({
        date: computed.date,
        baseCurrency: computed.baseCurrency,
        plan: computed.plan,
        totals: computed.totals,
        issues: computed.issues,
        platformName: rv.platformName,
        excludedFromNetWorth: computed.excludedFromNetWorth,
        duplicateDate: listSnapshotMetaDates(db).has(body.date)
      })
    );
  });

  /**
   * 保存快照（单事务）。
   *
   * 三个汇总列取 `inventoryTotals` 的结果 —— 它就是「冻结口径」，
   * 与明细严格同源，且落库后不再重算（PRD 规则 3 / 4）。
   * 保存成功后一并丢弃草稿，这是「一次盘点一个事务」的收尾。
   */
  r.post('/inventory/snapshots', async c => {
    const body = inventorySaveSchema.parse(await c.req.json());
    const rv = resolvers(db);
    const computed = compute(db, body.date, body.entries, body.rates);

    if (computed.issues.length) {
      throw fail.rule(
        `保存前的校验未通过（${computed.issues.length} 项）`,
        { issues: computed.issues }
      );
    }
    if (computed.plan.unfilled.length && !body.confirm_unfilled) {
      throw fail.rule(
        `有 ${computed.plan.unfilled.length} 个账户本次「未填写」，确认后才会保存`,
        {
          unfilled: computed.plan.unfilled.map(a => ({ account_id: a.id, account_name: a.name })),
          confirm_required: true
        }
      );
    }
    if (computed.plan.planned.length === 0) {
      throw fail.rule('没有任何明细要写入，快照会是一张空表；请至少填写一个账户');
    }

    const snapshotId = w.nextSnapshotId(db);
    const items = toSnapshotItems(computed.plan, snapshotId, rv);
    const createdAt = w.nowIso();

    w.tx(db, () => {
      w.insertSnapshotTx(
        db,
        {
          id: snapshotId,
          date: computed.date,
          note: body.note,
          base_currency: computed.baseCurrency,
          created_at: createdAt,
          total_assets: computed.totals.totalAssets,
          total_liabilities: computed.totals.totalLiabilities,
          net_worth: computed.totals.netWorth
        },
        items,
        computed.ratesYuan
      );
      w.deleteDraft(db);
    });

    /* §6.6：每次**成功**保存快照后自动备份一次。
       只在这一处触发 —— 备份的正是「刚写完的库」，那也是最该留底的一刻。
       刻意 `await`（而不是 fire-and-forget）：备份是毫秒级操作，而「响应返回时
       备份文件已经存在」让这件事可以被验收脚本直接断言；后台跑则只能靠 sleep 猜。
       备份失败不影响保存结果（`safeBackup` 内部吞掉异常，只记 warn）。 */
    if (opts.backup) {
      await safeBackup(db, opts.backup.dataDir, opts.backup.keep, opts.backup.log);
    }

    const counts = snapshotCounts(db).get(snapshotId) ?? { ...ZERO_COUNTS };
    const series = svc.loadSeries(db);
    const snapshot = series.snapshots.find(s => s.id === snapshotId)!;
    return c.json(
      toInventorySaveDTO(toSnapshotSummaryDTO(snapshot, counts), {
        written: items.length,
        carried_over: items.filter(i => i.is_carried_over).length,
        unfilled: computed.plan.unfilled.length,
        no_principal: computed.plan.noPrincipal.length
      }),
      201
    );
  });

  return r;
}

/** 已有快照的日期集合（判断「同一天已有快照」，PRD 规则 16） */
function listSnapshotMetaDates(db: Db): Set<string> {
  return new Set(
    svc
      .snapshotListService(db)
      .map(e => e.snapshot.date)
  );
}
