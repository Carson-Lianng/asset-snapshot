/**
 * endpoints.ts —— 端点路径的唯一来源
 *
 * 这个模块被两处引用，从而保证「离线 fixture」与「真实 API」的键完全一致：
 *   1. 前端运行期（app/web/src/api/*）
 *   2. fixture 导出脚本（app/tools/data/export-web-fixture.mjs，Node 直接 import）
 *
 * 因此这里**只能有纯函数与类型**，不得引入任何前端/浏览器依赖。
 */
import type { Dim, ViewMode } from '@app/shared';

export type ReturnsDim = Exclude<Dim, 'tag'>;
export type TrendMetric = 'net_worth' | 'total_assets' | 'total_liabilities';

/** 稳定的查询串构造：键按字典序，便于 fixture 命中 */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const keys = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  if (!keys.length) return '';
  return '?' + keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join('&');
}

export const ep = {
  health: () => '/health',
  ready: () => '/ready',

  settings: () => '/settings',
  currencies: (includeDisabled = false) => `/currencies${qs({ includeDisabled })}`,
  platforms: (includeDisabled = false) => `/platforms${qs({ includeDisabled })}`,
  categories: (includeDisabled = false) => `/categories${qs({ includeDisabled })}`,
  tags: (includeDisabled = false) => `/tags${qs({ includeDisabled })}`,
  rates: () => '/rates',
  baseCurrencyHistory: () => '/base-currency-history',

  accounts: (f: { platform_id?: string; category_id?: string; tag_id?: string; archived?: boolean; q?: string } = {}) =>
    `/accounts${qs(f)}`,

  snapshots: (f: { from?: string; to?: string } = {}) => `/snapshots${qs(f)}`,
  snapshot: (id: string, view: ViewMode = 'origin') => `/snapshots/${id}${qs({ view })}`,
  snapshotReturns: (id: string) => `/snapshots/${id}/returns`,
  compare: (a: string, b: string, dim: Dim = 'account', mode: ViewMode = 'origin') =>
    `/snapshots/compare${qs({ a, b, dim, mode })}`,

  trend: (metric: TrendMetric = 'net_worth', mode: ViewMode = 'origin') => `/reports/trend${qs({ metric, mode })}`,
  breakdown: (snapshotId: string, dim: Dim = 'category', mode: ViewMode = 'origin') =>
    `/reports/breakdown${qs({ snapshot_id: snapshotId, dim, mode })}`,
  platformCurrency: (snapshotId: string, mode: ViewMode = 'origin') =>
    `/reports/platform-currency${qs({ snapshot_id: snapshotId, mode })}`,
  currency: (snapshotId: string, mode: ViewMode = 'origin') =>
    `/reports/currency${qs({ snapshot_id: snapshotId, mode })}`,
  returns: (snapshotId: string) => `/reports/returns${qs({ snapshot_id: snapshotId })}`,
  returnsBreakdown: (snapshotId: string, dim: ReturnsDim = 'account') =>
    `/reports/returns-breakdown${qs({ snapshot_id: snapshotId, dim })}`,
  returnsTrend: () => '/reports/returns-trend',

  /* ---- 数据管理（Step 5）。只有 GET 进这里；写路径（POST /backup、/import/*、
     /restore）按 I-13 直接用字面量，不混进 `ep`。---- */
  backups: () => '/backup',
  exportFull: () => '/export/full',
  exportCsv: (type: 'items' | 'summary', snapshotId?: string) =>
    `/export/csv${qs({ type, snapshot_id: snapshotId })}`
} as const;
