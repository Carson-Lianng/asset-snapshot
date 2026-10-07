/**
 * catalogWrite.ts —— 基础资料写操作的唯一出口（设置页与标签管理弹窗共用）
 *
 * 币种 / 平台 / 分类 / 标签四组 CRUD 加起来二十来个调用点，如果每个都自己写
 * 「判 writable → mutate → 分派错误 → toast」，会出现两处必然的漂移：
 *   · 有的地方忘了判离线源，于是 fixture 下点了没反应也不报错；
 *   · 有的地方把服务端的 409 吞成「操作失败」，把「已被 3 个账户引用」这条
 *     唯一有用的信息丢掉。
 * 所以收成一个入口，调用点只剩「方法 + 路径 + 体 + 成功提示」四个参数。
 *
 * 错误文案**一律优先服务端原话**：409 的引用计数、422 的规则说明都是服务端算出来的，
 * 前端再拼一遍只会走样。只有拿不到错误体（网络失败等）才退回通用文案。
 *
 * ── 2026-10-04 第三批 #5 追加：`writeQuiet` ──
 * 设置页四张表改成「草稿 + 点保存才落库」之后，一次保存可能要发 N 条请求
 * （改 5 个平台名 = 5 条 PATCH）。若沿用 `write`，失败的每一条都会**各弹一个** toast，
 * 用户看到一屏红字却不知道到底是哪几项；而且每次 `write` 都会 `invalidate()` 一遍，
 * 5 条请求就是 5 次全量重取。
 *
 * 所以拆成两半：
 *   · `writeQuiet` —— 只发请求 + 把错误**原话**交回调用方，不弹提示、不失效缓存；
 *   · `write`      —— 单条写入的既有语义（弹提示 + 写在 `mutate` 里顺带失效），
 *                     现在实现为「writeQuiet + 一次 invalidate」，行为逐字不变。
 * 批量保存的调用方自己去汇总失败项，并在全部发完后调一次 `invalidate()`。
 */
import { useCallback } from 'react';
import { dataSource, invalidate, writable } from '../api/index.ts';
import { problemOf } from '../api/problem.ts';
import { useToast } from '../components/Toast.tsx';

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** 离线源的统一拒绝文案（`write` 与 `writeQuiet` 共用，避免两处各写一遍） */
const OFFLINE = '当前是离线数据源（?data=fixture），该项不可修改';

export type QuietResult = { ok: true } | { ok: false; message: string; offline?: true };

export interface CatalogWrite {
  /**
   * 执行一次写并提示。返回是否成功 —— 调用方据此决定要不要把受控控件
   * 拉回服务端的值（失败时不重渲染，勾选框会停在用户点过的位置）。
   *
   * `ok` 传空串表示**成功时不提示**：原型里平台的类型/备注、分类与标签的
   * 启停都是静默保存的，凭空多出提示就是行为漂移。
   */
  write(method: Method, path: string, body: unknown, ok: string): Promise<boolean>;
  /**
   * 不弹提示、不失效缓存的写。留给「一次保存要发多条请求」的调用方做汇总
   * （设置页的草稿保存）。**调用方必须在全部发完后自己调一次失效**
   * —— 见 `features/settings/SettingsPage.tsx` 的 `commitGroup()`。
   */
  writeQuiet(method: Method, path: string, body: unknown): Promise<QuietResult>;
}

export function useCatalogWrite(): CatalogWrite {
  const toast = useToast();

  const writeQuiet = useCallback(
    async (method: Method, path: string, body: unknown): Promise<QuietResult> => {
      if (!writable()) return { ok: false, message: OFFLINE, offline: true };
      try {
        await dataSource().send(method, path, body);
        return { ok: true };
      } catch (err) {
        const p = problemOf(err);
        return {
          ok: false,
          message: p ? p.message : `操作失败：${err instanceof Error ? err.message : String(err)}`
        };
      }
    },
    []
  );

  const write = useCallback(
    async (method: Method, path: string, body: unknown, ok: string): Promise<boolean> => {
      const res = await writeQuiet(method, path, body);
      if (!res.ok) {
        /* 离线源保持原有的 'warn' 语气 —— 它不是「操作出错」，而是「这里改不了」 */
        toast(res.message, res.offline ? 'warn' : 'err', 4200);
        return false;
      }
      invalidate();
      if (ok) toast(ok, 'ok');
      return true;
    },
    [writeQuiet, toast]
  );

  return { write, writeQuiet };
}

