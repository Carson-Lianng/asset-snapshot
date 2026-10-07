/**
 * 系统模块 —— 存活与就绪探针（技术设计文档 §8.3）
 */
import { Hono } from 'hono';
import type { AppEnv } from '../middleware.ts';
import type { Db } from '../db/client.ts';
import { tableCounts } from '../db/repo.ts';
import { currentVersion } from '../db/migrate.ts';
import { toHealthDTO, toReadyDTO } from '../lib/dto.ts';

export function createMetaRoutes(db: Db, version: string): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/health', c => {
    const started = c.get('boot').startedAt;
    return c.json(toHealthDTO(version, (Date.now() - started) / 1000));
  });

  r.get('/ready', c => {
    const counts = tableCounts(db);
    return c.json(toReadyDTO(currentVersion(db.raw), c.get('boot').dataDir, counts));
  });

  return r;
}
