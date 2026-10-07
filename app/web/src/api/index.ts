/**
 * api/index.ts —— 数据源注册表 + 取数缓存 + React 取数 hook + 写后失效
 */
import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { DataSourceError, type DataSource } from './source.ts';

let active: DataSource | null = null;

export function setDataSource(source: DataSource): void {
  active = source;
  cache.clear();
  errors.clear();
  /* 换源时必须一并丢掉「上一次成功值」，否则会把上一个源的数据当成兜底画出来 */
  lastGood.clear();
}

export function dataSource(): DataSource {
  if (!active) throw new DataSourceError('数据源尚未初始化（应在 main.tsx 渲染前 setDataSource）', '<boot>');
  return active;
}

/** 当前源是否可写（fixture 为只读）—— UI 用它置灰，而不是等调用抛错 */
export function writable(): boolean {
  return active?.writable ?? false;
}

/* ============================================================
   缓存
   ============================================================ */

const cache = new Map<string, unknown>();
const errors = new Map<string, Error>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * 上一次**成功**加载的值，刻意**不随 `invalidate()` 清空**。
 *
 * `mutate` 的策略是「写完整体作废」，作废之后到重新取回之间隔着一次网络往返。
 * 这期间 `cache` 是空的，`useApi` 只能交出 `data: null` —— 于是每次写入都会让
 * 页面上的表格**闪一帧空白**（原型是同步重渲染，没有这一帧）。
 *
 * 保留最后一次成功的值做兜底，语义就成了「先给旧的、再换新的」：数据仍然是
 * 写后重新取回的，只是不再把中间态画出来。注意它**不参与是否要重新取数的判断**
 * （那个判断只看 `cache`），所以不会变成「写完不刷新」。
 */
const lastGood = new Map<string, unknown>();

/** 同步取数：优先当前缓存，缓存被作废后回落到上一次成功值 */
function peek<T>(path: string): T | undefined {
  if (cache.has(path)) return cache.get(path) as T;
  return lastGood.has(path) ? (lastGood.get(path) as T) : undefined;
}

function load(path: string): Promise<unknown> {
  const running = inflight.get(path);
  if (running) return running;
  const p = dataSource()
    .get(path)
    .then(
      value => {
        cache.set(path, value);
        lastGood.set(path, value);
        errors.delete(path);
        inflight.delete(path);
        return value;
      },
      (err: Error) => {
        errors.set(path, err);
        inflight.delete(path);
        throw err;
      }
    );
  inflight.set(path, p);
  return p;
}

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/* ============================================================
   写后失效与重渲染
   ============================================================ */

let revision = 0;
const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getRevision(): number {
  return revision;
}

/** 丢弃缓存并通知订阅者重渲染。`match` 缺省表示「全部失效」。 */
export function invalidate(match?: (path: string) => boolean): void {
  if (!match) {
    cache.clear();
    errors.clear();
  } else {
    for (const k of [...cache.keys()]) if (match(k)) cache.delete(k);
    for (const k of [...errors.keys()]) if (match(k)) errors.delete(k);
  }
  revision++;
  for (const fn of [...listeners]) fn();
}

/**
 * 写操作的统一出口：**先真正写，再让缓存失效**。
 *
 * 把两件事绑在一个函数里，是为了让「写成功但界面还是旧值」这类问题在结构上不出现 ——
 * 每个调用点都必须经过这里，没有「忘了刷新」的位置可写。
 * 本地应用数据量很小，缺省全部失效即可，不做精细的依赖追踪。
 */
export async function mutate<T>(
  fn: (ds: DataSource) => Promise<T>,
  match?: (path: string) => boolean
): Promise<T> {
  const out = await fn(dataSource());
  invalidate(match);
  return out;
}

/** useApi / usePaths 共用的「外部失效」重渲染信号 */
function useRevision(): number {
  return useSyncExternalStore(subscribe, getRevision, getRevision);
}

/**
 * 取数 hook。
 *
 * 离线源支持同步命中，首帧即拿到数据 —— 这正是 Step 3 截图比对需要的确定性；
 * 切换到 http 源后走异步路径，语义不变。
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const rev = useRevision();

  const sync = path === null ? undefined : peek<T>(path);
  const failed = path === null ? undefined : errors.get(path);

  useEffect(() => {
    if (path === null) return;
    if (cache.has(path) || errors.has(path)) return;
    if (inflight.has(path)) {
      // 已在别处发起：等它落地后重渲染
      let alive = true;
      inflight.get(path)!.then(
        () => alive && force(),
        () => alive && force()
      );
      return () => {
        alive = false;
      };
    }
    let alive = true;
    load(path).then(
      () => alive && force(),
      () => alive && force()
    );
    return () => {
      alive = false;
    };
  }, [path, rev]);

  if (path === null) return { data: null, error: null, loading: false };
  if (failed) return { data: null, error: failed, loading: false };
  if (sync !== undefined) return { data: sync, error: null, loading: false };
  return { data: null, error: null, loading: true };
}

/** 必须在渲染前调用（main.tsx）：把常用端点预热进缓存，保证首帧就是完整页面 */
export async function prefetch(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(p => (cache.has(p) ? Promise.resolve() : load(p))));
}

/**
 * 同步读缓存；未命中返回 null（**不触发加载**）。
 *
 * 与 `useApi` 同源：缓存被 `invalidate()` 作废后回落到上一次成功值，
 * 这样「用 `cached()` 拼出来的派生数据」（例如设置页那份「使用中」的币种并集）
 * 在写入后不会先塌成空集再长回来。
 */
export function cached<T>(path: string): T | null {
  const v = peek<T>(path);
  return v === undefined ? null : v;
}

/**
 * 订阅**数量可变**的一组路径。
 *
 * 为什么不是「在循环里调 useApi」：快照期数是渲染期才知道的，
 * 而 Hook 的调用顺序必须稳定 —— 首帧 0 张、次帧 7 张会直接崩。
 * 这里把路径列表压成一个字符串作为依赖键，effect 内部按需加载，完成后强制重渲染。
 */
export function usePaths(paths: readonly string[]): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const rev = useRevision();
  const key = paths.join('\u0000');

  useEffect(() => {
    const list = key ? key.split('\u0000') : [];
    const inflightHere = list.filter(p => inflight.has(p));
    const missing = list.filter(p => !cache.has(p) && !errors.has(p) && !inflight.has(p));
    if (!missing.length && !inflightHere.length) return;

    let alive = true;
    const jobs = [
      ...missing.map(p => load(p).catch(() => undefined)),
      ...inflightHere.map(p => inflight.get(p)!.catch(() => undefined))
    ];
    Promise.all(jobs).then(() => alive && force());
    return () => {
      alive = false;
    };
  }, [key, rev]);
}

export type { WriteMethod } from './source.ts';

export { ep } from './endpoints.ts';
export type { DataSource, DataSourceKind } from './source.ts';
export { DataSourceError } from './source.ts';
