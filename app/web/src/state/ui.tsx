/**
 * ui.tsx —— 界面状态集中存放（对应原型的全局 `UI` 对象）
 *
 * 放在一个 context 里而不是散落在各页面，原因有两个：
 *   1. 顶栏的标题 / 面包屑 / 操作按钮由 App 渲染，但内容依赖页面内的选择
 *      （例如快照详情看的是哪一期），状态必须能被 App 读到；
 *   2. 视图切换（列表 → 详情 → 对比）要保持各自的选择不丢，与原型语义一致。
 *
 * 所有字段的默认值都与原型 `const UI = {...}` 一致，这是外观等价的前提。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Dim } from '@app/shared';
import type { ReturnsDim } from '../api/endpoints.ts';
import type { Drill } from '../lib/drill.ts';
import type { SnapRange } from '../lib/series.ts';

export type ViewMode = 'origin' | 'current';
export type AccGroup = 'platform' | 'currency' | 'category';
export type SnapTab = 'platform' | 'currency' | 'category' | 'account';
/** 报表页的两个 tab（需求 #5）：资产（趋势 + 结构分布）/ 理财（收益） */
export type RepTab = 'asset' | 'wealth';
/**
 * 快照列表的时间筛选档（2026-10-05）。
 *
 * **定义在 `lib/series.ts`** —— 与它的边界口径（`snapRangeBounds`）放在一起，
 * 那里是纯函数叶子模块，验收脚本（`.mjs`，不能 import `.tsx`）可以直接引用。
 * 这里只是再导出，免得两处各写一份联合类型、改一处漏一处。
 */
export type { SnapRange } from '../lib/series.ts';

export interface AccFilter {
  platform?: string;
  category?: string;
  currency?: string;
  tag?: string;
  archived?: boolean;
}

export interface UiState {
  /** 快照详情当前查看的快照 */
  snapSel: string | null;
  snapTab: SnapTab;
  /** 快照列表的时间筛选；自定义档用 snapFrom / snapTo（含端点，`YYYY-MM-DD`） */
  snapRange: SnapRange;
  snapFrom: string;
  snapTo: string;

  /**
   * 账户详情当前查看的账户（与 `snapSel` 同构）。
   *
   * 「看的是哪一个」放在这里而不是 URL：`#account-detail` / `#snapshot-detail`
   * 只表达「在第几层」，选中项由状态承载 —— 刷新落回详情页时不至于丢。
   */
  accSel: string | null;

  cmpA: string | null;
  cmpB: string | null;
  cmpTab: Dim;
  cmpMode: ViewMode;

  repTrendMode: ViewMode;
  repRetDim: ReturnsDim;
  /** 报表页当前 tab；默认落在「资产」 */
  repTab: RepTab;
  /**
   * 报表页「维度分布」的下钻范围（第三批 #4）：`null` = 整体视图。
   *
   * 放在 UiState 而不是 ReportsPage 的局部 state，理由同本文件开头：切到别的页面
   * 再切回来时，页面的局部 state 会随卸载一起丢，而下钻范围是「我正在看哪个分类」——
   * 与 `snapSel`「我正在看哪一期」是同一类东西。
   */
  repDrill: Drill | null;

  accGroup: AccGroup;
  accQuery: string;
  accFilter: AccFilter;

  setTab: string;
}

const INITIAL: UiState = {
  snapSel: null,
  snapTab: 'platform',
  snapRange: 'all',
  snapFrom: '',
  snapTo: '',

  accSel: null,

  cmpA: null,
  cmpB: null,
  cmpTab: 'account',
  cmpMode: 'origin',

  repTrendMode: 'origin',
  repRetDim: 'account',
  repTab: 'asset',
  repDrill: null,

  accGroup: 'platform',
  accQuery: '',
  accFilter: {},

  setTab: 'base'
};

interface UiContextValue {
  ui: UiState;
  patch: (p: Partial<UiState>) => void;
  reset: () => void;
}

const UiContext = createContext<UiContextValue | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<UiState>(INITIAL);
  const patch = useCallback((p: Partial<UiState>) => setUi(prev => ({ ...prev, ...p })), []);
  const reset = useCallback(() => setUi(INITIAL), []);
  const value = useMemo(() => ({ ui, patch, reset }), [ui, patch, reset]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiContextValue {
  const v = useContext(UiContext);
  if (!v) throw new Error('useUi 必须在 UiProvider 内使用');
  return v;
}

/* ============================================================
   维度标签（原型的 DIMS）
   ============================================================ */

export const DIMS: Record<Dim, { label: string }> = {
  account: { label: '按账户' },
  platform: { label: '按平台' },
  category: { label: '按分类' },
  currency: { label: '按币种' },
  tag: { label: '按标签' }
};

/* ============================================================
   收益状态徽章（原型的 RETURN_TAG）
   ============================================================ */

export const RETURN_TAG: Record<string, { t: string; c: string } | null> = {
  ok: null,
  'not-tracked': null,
  'no-principal': { t: '未填本金', c: 'warn' },
  first: { t: '首期', c: 'mute' },
  'base-missing': { t: '基准缺失', c: 'warn' }
};

/* ============================================================
   设置页分页（原型的 SET_TABS，顺序即渲染顺序）
   ============================================================ */

export const SET_TABS: ReadonlyArray<readonly [string, string]> = [
  ['base', '本位币'],
  ['currency', '币种'],
  ['rate', '汇率'],
  ['platform', '平台'],
  ['category', '分类'],
  ['tag', '标签'],
  ['io', '导入导出'],
  ['backup', '备份恢复'],
  ['about', '关于']
];
