/**
 * 快照模块（技术设计文档 §8.3）
 *
 * 路由注册顺序有含义：`/snapshots/compare` 必须早于 `/snapshots/:id`，
 * 否则 `compare` 会被当成快照 ID。
 */
import { Hono } from 'hono';
import {
  parseQuery,
  snapshotCompareQuerySchema,
  snapshotDetailQuerySchema,
  snapshotListQuerySchema
} from '@app/shared';
import type { AppEnv } from '../middleware.ts';
import type { Db } from '../db/client.ts';
import * as svc from '../services.ts';
import * as w from '../db/writes.ts';
import { fail } from '../lib/errors.ts';
import {
  toCompareDTO,
  toItemReturnDTO,
  toSnapshotDTO,
  toSnapshotSummaryDTO
} from '../lib/dto.ts';

export function createSnapshotRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/snapshots', c => {
    const q = parseQuery(snapshotListQuerySchema, c.req.query());
    const list = svc.snapshotListService(db, { from: q.from, to: q.to });
    return c.json({
      items: list.map(e => toSnapshotSummaryDTO(e.snapshot, e.counts)),
      total: list.length
    });
  });

  r.get('/snapshots/compare', c => {
    const q = parseQuery(snapshotCompareQuerySchema, c.req.query());
    const { result, early, late } = svc.compareService(db, q.a, q.b, q.dim, q.mode);
    return c.json(
      toCompareDTO(
        result,
        toSnapshotSummaryDTO(early.snapshot, early.counts),
        toSnapshotSummaryDTO(late.snapshot, late.counts)
      )
    );
  });

  r.get('/snapshots/:id', c => {
    const q = parseQuery(snapshotDetailQuerySchema, c.req.query());
    const { snapshot, counts } = svc.snapshotDetailService(db, c.req.param('id'));
    const dto = toSnapshotDTO(snapshot, counts);
    // origin / current 的差别只体现在「折算后的取值」上：原口径直接返回落库值
    return c.json({ ...dto, view: q.view });
  });

  /** 单条明细的收益指标（原币口径）—— 与黄金值 itemMetricsBySnapshot 对齐 */
  r.get('/snapshots/:id/returns', c => {
    const id = c.req.param('id');
    const entries = svc.itemReturnsService(db, id);
    return c.json({
      snapshot_id: id,
      items: entries.map(e => toItemReturnDTO(e.item, e.metrics))
    });
  });

  /**
   * 删除快照（含明细与汇率，单事务）。
   *
   * 二次确认在前端（§8.3 原文）。这里只做存在性校验：
   * 删一张不存在的快照应当 404，而不是静默成功 —— 后者会让「点了没反应」难以排查。
   */
  r.delete('/snapshots/:id', c => {
    const id = c.req.param('id');
    if (!w.findSnapshotRow(db, id)) throw fail.notFound(`快照不存在：${id}`);
    w.deleteSnapshot(db, id);
    return c.json({ deleted: id });
  });

  return r;
}
