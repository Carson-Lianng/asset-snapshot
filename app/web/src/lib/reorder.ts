/**
 * reorder.ts —— 账户顺序的**唯一口径**（纯函数，零依赖）
 *
 * ## 为什么单独成一个模块
 *
 * 与 `lib/series.ts` 同一个理由：排序的「落点计算」既要被页面用，也要被
 * 验收脚本用。验收脚本是 `.mjs`，Node 的类型擦除不认 JSX，**import 不了
 * `.tsx`** —— 逻辑若留在 `AccountsPage.tsx` 里，脚本就只能把口径抄第二份，
 * 而本项目已经栽过一次「抄成两份，迟早有一份先被改掉」。
 *
 * ## 与服务端的关系
 *
 * 读：服务端 `listAccounts` 的 `ORDER BY sort ASC, id ASC`（repo.ts）。
 *     本地 `orderAccounts()` **必须逐字复刻**这个次序，否则页面看到的顺序
 *     与「拖完之后服务端记下的顺序」会差一点，且差在 id 相同时。
 * 写：`POST /api/accounts/reorder { ids }`（`writes.reorder()`）按给定顺序
 *     把 `sort` 改写成 1..n，单事务。⚠ 它**只改 ids 里出现的行**，没提到的行
 *     保留旧 `sort`，会与新序号交错 —— 所以调用方必须送**全量** id，不能只送
 *     当前筛选结果。这一点由页面保证（`accounts` 是全量，见 AccountsPage）。
 */

/** 列表按 `(sort, id)` 升序 —— 与服务端 `ORDER BY sort ASC, id ASC` 逐字一致 */
export function orderAccounts<T extends { id: string; sort: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 落点：`a` = 插到目标**之前**，`b` = 插到目标**之后**（a/before、b/after） */
export type DropPos = 'a' | 'b';

/**
 * 把 `dragId` 移到 `targetId` 的前 / 后，返回新的 id 顺序。
 *
 * 参数不合法（任一方不在列表里、或两者相同）时**原样返回** —— 调用方拿返回值
 * 与原数组比较即可判断「这一拖没有产生变化」，不必各自再判一遍前置条件。
 */
export function moveId(
  ids: readonly string[],
  dragId: string,
  targetId: string,
  pos: DropPos
): string[] {
  if (dragId === targetId || !ids.includes(dragId) || !ids.includes(targetId)) return [...ids];
  const out = ids.filter(id => id !== dragId);
  const at = out.indexOf(targetId);
  out.splice(pos === 'a' ? at : at + 1, 0, dragId);
  return out;
}

/**
 * 按 `override` 给出的顺序重排；`override` 里没提到的（例如刚新建、还没进
 * 本地顺序的账户）保持 `(sort, id)` 的相对次序、统一落到末尾。
 *
 * `override` 为空 / 为 null ⇒ 就是 `orderAccounts()`。
 *
 * 为什么需要它：拖完到服务端回话之间隔着一次往返，`useApi` 在这期间交出的
 * 仍是**上一次成功值**（旧顺序），页面会先弹回旧序再跳到新序。页面在提交时
 * 先用本地顺序顶上，等回话落地再交还给服务端顺序。
 */
export function sortedByOrder<T extends { id: string; sort: number }>(
  list: readonly T[],
  override: readonly string[] | null = null
): T[] {
  const base = orderAccounts(list);
  if (!override || !override.length) return base;

  const known = new Set(base.map(a => a.id));
  const rank = new Map<string, number>();
  for (const id of override) if (known.has(id)) rank.set(id, rank.size);
  for (const a of base) if (!rank.has(a.id)) rank.set(a.id, rank.size);

  return [...base].sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);
}
