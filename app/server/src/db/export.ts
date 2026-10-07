/**
 * 全量导出 —— 库 → 备份文档（技术设计文档 §6.6 / §8.3 的 `GET /export/full`）
 *
 * ## 为什么导出文档与 `app/fixtures/demo-seed.json` 同构
 *
 * 「种子导入」与「从备份恢复」要做的事在数据层是**同一件**：把一份文档灌进空库。
 * 让导出产出同一种形状，这两条路径就能共用 `loadDocument()`——
 * 否则「恢复」会慢慢长出自己的字段处理（多认一个字段、少写一个表），
 * 而这类漂移在恢复时才暴露，那时用户的原数据已经面临风险。
 *
 * ## 口径
 *
 * 输出的一律是**元**（`Money.toNumber()`），不是库里的微元整数。
 * 备份文件要能被外部工具读懂、能被将来的版本重新导入，微元是实现细节。
 * 汇总列（`total_assets` 等）直接取落库的**冻结值**，绝不重算 —— 见 §6.2 说明 2。
 */
import { eq } from 'drizzle-orm';
import { Money } from '@app/domain';
import type { Db } from './client.ts';
import * as t from './schema.ts';
import * as repo from './repo.ts';
import { currentSchemaVersion, getDataMode, type SeedFixture } from './seed.ts';
import { APP_VERSION } from '../config/paths.ts';

/** 备份文档 = 种子文档 + `exported_at`（`SeedFixture` 里已声明为可选） */
export interface BackupDocument extends SeedFixture {
  exported_at: string;
}

const num = (m: Money | null | undefined): number => (m ? m.toNumber() : 0);
const numOrNull = (m: Money | null | undefined): number | null => (m ? m.toNumber() : null);

export function buildBackupDocument(db: Db): BackupDocument {
  const settings = repo.getSettings(db);
  const currencies = repo.listCurrencies(db);
  const history = repo.listBaseHistoryRows(db);
  const accounts = repo.listAccounts(db);
  const snapshots = repo.loadSeries(db).snapshots;

  const draftRow = db.orm.select().from(t.inventoryDraft).where(eq(t.inventoryDraft.id, 'current')).get();

  return {
    // 与 `PRAGMA user_version` 同值（§6.3），恢复时的版本校验看的就是这个
    schema_version: currentSchemaVersion(db.raw),
    app_version: APP_VERSION,
    exported_at: new Date().toISOString(),
    /* 带出数据模式：恢复一份演示备份后仍是演示数据，界面该提示的照旧提示
       （见 `restoreFromDocument`）。从 `setting` 读，而不是另开字段。 */
    data_mode: getDataMode(db.raw),

    settings: { base_currency: settings.base_currency ?? 'CNY' },

    currencies: currencies.map(c => ({
      code: c.code, name: c.name, symbol: c.symbol, sort: c.sort, enabled: c.enabled
    })),

    // 汇率表只含「有汇率」的币种；本位币恒为 1，也在表里
    rates: Object.fromEntries(
      currencies
        .filter(c => c.rate_to_base_micro !== null)
        .map(c => [c.code, repo.moneyReq(c.rate_to_base_micro!).toNumber()])
    ),

    baseHistory: history.map(h => ({
      id: h.id,
      from_currency: h.fromCurrency,
      to_currency: h.toCurrency,
      conversion_rate: repo.moneyReq(h.conversionRate).toNumber(),
      changed_at: h.changedAt
    })),

    // `account_count` 是给界面算删除前置条件的，不属于数据本身，导出时剔除
    platforms: repo.listPlatforms(db).map(p => ({
      id: p.id, name: p.name, type: p.type, note: p.note, sort: p.sort, enabled: p.enabled
    })),
    categories: repo.listCategories(db).map(c => ({
      id: c.id, name: c.name, type: c.type,
      default_track_principal: c.default_track_principal,
      sort: c.sort, enabled: c.enabled
    })),
    tags: repo.listTags(db).map(g => ({
      id: g.id, name: g.name, sort: g.sort, enabled: g.enabled
    })),

    accounts: accounts.map(a => ({
      id: a.id, name: a.name,
      platform_id: a.platform_id, category_id: a.category_id,
      type: a.type, currency: a.currency, tags: a.tags, note: a.note,
      include_in_net_worth: a.include_in_net_worth,
      track_principal: a.track_principal,
      sort: a.sort, archived: a.archived,
      created_at: a.created_at, updated_at: a.updated_at
    })),

    snapshots: snapshots.map(s => ({
      id: s.id, date: s.date, note: s.note, base_currency: s.base_currency,
      rates: s.rates,
      // 冻结口径原样带出，不重算
      total_assets: num(s.total_assets),
      total_liabilities: num(s.total_liabilities),
      net_worth: num(s.net_worth),
      created_at: s.created_at,
      items: s.items.map(it => ({
        id: it.id,
        snapshot_id: it.snapshot_id,
        account_id: it.account_id,
        account_name_snapshot: it.account_name_snapshot,
        platform_id_snapshot: it.platform_id_snapshot,
        platform_name_snapshot: it.platform_name_snapshot,
        category_id_snapshot: it.category_id_snapshot,
        category_name_snapshot: it.category_name_snapshot,
        type: it.type, currency: it.currency,
        original_amount: num(it.original_amount),
        exchange_rate: num(it.exchange_rate),
        amount_in_base: num(it.amount_in_base),
        include_in_net_worth: it.include_in_net_worth,
        tracks_principal: it.tracks_principal,
        // 没跟踪本金的账户这两列本就是 NULL，不能写成 0 —— 0 与「未填」语义不同
        principal: numOrNull(it.principal),
        principal_in_base: numOrNull(it.principal_in_base),
        is_carried_over: it.is_carried_over,
        tags_snapshot: it.tags_snapshot,
        sort: it.sort
      }))
    })),

    draft: draftRow ? (draftRow.data as unknown) : null
  };
}
