/**
 * router.ts —— hash 路由
 *
 * 兼容原型在 Step 0 冻结下来的深链契约（基准截图脚本依赖它）：
 *   #home / #accounts / #snapshots / #reports / #settings
 *   #snapshot-detail / #snapshot-compare
 *   #inventory
 *
 * 原型到达盘点向导的中间步骤靠「注入脚本改 UI.inv.step」，
 * 这在 React 里没有对应的注入点，因此把步骤提进 URL：`#inventory?step=3.5`。
 * 截图脚本改用深链即可，不再需要生成变体文件。
 *
 * `#help` 是**原型没有的新页面**（使用手册），因此它不在基准图的深链契约里，
 * 加它不会影响任何一张截图的取景。它沿用同一套参数化写法定位到某一章：
 * `#help?sec=concepts` —— 别处（如设置页「关于」）可直接链到指定章节。
 *
 * `#account-detail` 与 `#snapshot-detail` 同构（2026-10-05 视觉迭代）：
 * 「看的是哪一个」放在 UiState（`accSel` / `snapSel`），URL 里只表达「在哪一层」。
 * 这样刷新落在详情页时不会丢选中项，返回列表也不需要清参数。
 */
import { useCallback, useEffect, useState } from 'react';

export type View = 'home' | 'accounts' | 'inventory' | 'snapshots' | 'reports' | 'settings' | 'help';
export type SnapMode = 'list' | 'detail' | 'compare';
/** 账户页的两层：列表（资产卡包）/ 详情（单个账户） */
export type AccMode = 'list' | 'detail';

export interface Route {
  view: View;
  snapMode: SnapMode;
  /** 账户页的层级；与 snapMode 同构 */
  accMode: AccMode;
  /** 盘点向导的步骤；1 / 2 / 3 / 3.5 / 4 */
  invStep: number;
  /** 使用手册要定位到的章节 id（`#help?sec=concepts`）；不在手册页时为 null */
  helpSec: string | null;
}

const VIEWS: readonly View[] = [
  'home',
  'accounts',
  'inventory',
  'snapshots',
  'reports',
  'settings',
  'help'
];

export const VALID_STEPS: readonly number[] = [1, 2, 3, 3.5, 4];

/** `hashFor` / `setHash` / `useNavigate` 共用的参数包（原先三处各写一遍字面类型） */
export interface RouteOpts {
  snapMode?: SnapMode;
  accMode?: AccMode;
  invStep?: number;
  helpSec?: string | null;
}

export function parseHash(hash: string): Route {
  const raw = (hash || '').replace(/^#/, '');
  const [head, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);

  if (head === 'snapshot-detail') {
    return { view: 'snapshots', snapMode: 'detail', accMode: 'list', invStep: 1, helpSec: null };
  }
  if (head === 'snapshot-compare') {
    return { view: 'snapshots', snapMode: 'compare', accMode: 'list', invStep: 1, helpSec: null };
  }
  if (head === 'account-detail') {
    return { view: 'accounts', snapMode: 'list', accMode: 'detail', invStep: 1, helpSec: null };
  }

  if (head === 'inventory') {
    const step = Number(params.get('step') ?? '1');
    return {
      view: 'inventory',
      snapMode: 'list',
      accMode: 'list',
      invStep: VALID_STEPS.includes(step) ? step : 1,
      helpSec: null
    };
  }

  if (head === 'help') {
    return { view: 'help', snapMode: 'list', accMode: 'list', invStep: 1, helpSec: params.get('sec') || null };
  }

  const view = (VIEWS as readonly string[]).includes(head) ? (head as View) : 'home';
  return { view, snapMode: 'list', accMode: 'list', invStep: 1, helpSec: null };
}

export function hashFor(view: View, opts: RouteOpts = {}): string {
  if (view === 'snapshots') {
    if (opts.snapMode === 'detail') return '#snapshot-detail';
    if (opts.snapMode === 'compare') return '#snapshot-compare';
    return '#snapshots';
  }
  if (view === 'accounts') {
    return opts.accMode === 'detail' ? '#account-detail' : '#accounts';
  }
  if (view === 'inventory') {
    const step = opts.invStep ?? 1;
    return step === 1 ? '#inventory' : `#inventory?step=${step}`;
  }
  if (view === 'help') {
    return opts.helpSec ? `#help?sec=${encodeURIComponent(opts.helpSec)}` : '#help';
  }
  return '#' + view;
}

export function setHash(view: View, opts: RouteOpts = {}): void {
  const next = hashFor(view, opts);
  if (window.location.hash !== next) window.location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** 首次进入时没有 hash（例如直接打开 dist/index.html），补成 #home */
export function ensureDefaultHash(): void {
  if (!window.location.hash) window.location.hash = '#home';
}

export function useNavigate(): (view: View, opts?: RouteOpts) => void {
  return useCallback((view, opts) => setHash(view, opts), []);
}
