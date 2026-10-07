/**
 * 报表模块（技术设计文档 §8.3）
 *
 * 端点与文档的对应关系：
 *   /reports/trend              ← 趋势序列（同日取最后一张，本位币变更处返回分隔标记）
 *   /reports/breakdown          ← 结构分布（任一维度）
 *   /reports/platform-currency  ← 平台 × 币种分解（首页「平台分布」堆叠与悬浮明细）※本步新增
 *   /reports/currency           ← 币种维度：原币合计 + 折本位币 ※本步新增
 *   /reports/returns            ← 收益面板
 *   /reports/returns-breakdown  ← 收益多维度汇总（账户 / 平台 / 分类 / 币种）
 *   /reports/returns-trend      ← 累计收益 / 本期收益随时间变化
 *
 * 所有 `snapshot_id` 缺省时取「最新一张」。
 */
import { Hono } from 'hono';
import {
  breakdownQuerySchema,
  parseQuery,
  returnsBreakdownQuerySchema,
  returnsQuerySchema,
  snapshotScopedSchema,
  trendQuerySchema
} from '@app/shared';
import type { AppEnv } from '../middleware.ts';
import type { Db } from '../db/client.ts';
import * as svc from '../services.ts';
import {
  toBaseHistoryDTO,
  toBreakdownDTO,
  toCurrencyRowDTO,
  toPlatformCurrencyDTO,
  toReturnsBreakdownDTO,
  toReturnsPanelDTO,
  toReturnsTrendDTO,
  toTrendDTO
} from '../lib/dto.ts';
import { fail } from '../lib/errors.ts';

export function createReportRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /** 缺省取最新一张快照；库里没有任何快照时给出明确错误而非空报表 */
  const resolveSnapshotId = (raw: string | undefined): string => {
    if (raw) return raw;
    const id = svc.latestSnapshotId(db);
    if (!id) throw fail.rule('尚无任何快照，无法生成报表');
    return id;
  };

  r.get('/reports/trend', c => {
    const q = parseQuery(trendQuerySchema, c.req.query());
    const { baseCurrency, points, baseChanges } = svc.trendService(db, q.metric, q.mode);
    return c.json(
      toTrendDTO(q.metric, q.mode, baseCurrency, points, baseChanges.map(toBaseHistoryDTO))
    );
  });

  r.get('/reports/breakdown', c => {
    const q = parseQuery(breakdownQuerySchema, c.req.query());
    const { snapshot, rows, ref, baseCurrency } = svc.breakdownService(db, q.snapshot_id, q.dim, q.mode);
    return c.json(toBreakdownDTO(snapshot.id, q.dim, q.mode, baseCurrency, ref, rows));
  });

  r.get('/reports/platform-currency', c => {
    const q = parseQuery(snapshotScopedSchema, c.req.query());
    const id = resolveSnapshotId(q.snapshot_id);
    const { rows, baseCurrency } = svc.platformCurrencyService(db, id, q.mode);
    return c.json({
      snapshot_id: id,
      mode: q.mode,
      base_currency: baseCurrency,
      rows: toPlatformCurrencyDTO(rows)
    });
  });

  r.get('/reports/currency', c => {
    const q = parseQuery(snapshotScopedSchema, c.req.query());
    const id = resolveSnapshotId(q.snapshot_id);
    const { rows, baseCurrency } = svc.currencyBreakdownService(db, id, q.mode);
    return c.json({
      snapshot_id: id,
      mode: q.mode,
      base_currency: baseCurrency,
      rows: toCurrencyRowDTO(rows)
    });
  });

  r.get('/reports/returns', c => {
    const q = parseQuery(returnsQuerySchema, c.req.query());
    const { snapshot, panel } = svc.returnsPanelService(db, q.snapshot_id);
    return c.json(toReturnsPanelDTO(snapshot.id, panel));
  });

  r.get('/reports/returns-breakdown', c => {
    const q = parseQuery(returnsBreakdownQuerySchema, c.req.query());
    const { snapshot, rows } = svc.returnsBreakdownService(db, q.snapshot_id, q.dim);
    return c.json(toReturnsBreakdownDTO(snapshot.id, q.dim, rows));
  });

  r.get('/reports/returns-trend', c => {
    return c.json(toReturnsTrendDTO(svc.returnsTrendService(db)));
  });

  return r;
}
