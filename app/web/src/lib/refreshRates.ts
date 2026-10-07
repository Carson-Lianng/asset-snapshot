/**
 * refreshRates.ts —— 「获取实时汇率」的前端唯一出口（第三批 #1 / #2）
 *
 * 两个调用点：设置页的「汇率」分页、盘点向导第 2 步。
 * 它们要做的是同一件事 —— **判离线 → 发一次无体 POST → 把结果/失败原话交回调用方**。
 * 分开各写一份，就会出现「一处记得判离线、另一处忘了」的漂移
 * （`catalogWrite.ts` 的文件头记过同一个成因）。
 *
 * 与 `catalogWrite` 的分工：那个是「写一组基础资料」的通用入口，成败只用一个布尔
 * 表达；这里是**一个具体动作**，返回值里带着界面要显示的东西（源名 / 改了哪几项 /
 * 哪些源没提供），所以单独成一个模块，而不是硬塞进 `catalogWrite` 的签名里。
 *
 * 三个刻意的取舍：
 *  1. **成功时顺手 `invalidate()`**。刷新改的是默认汇率表，设置页的币种列表
 *     （`rate_to_base`）、汇率分页、盘点向导的默认值都跟着变，让调用方各自记得
 *     失效一次是没必要的负担。盘点向导不受影响：它的 `inv` 只在首次就绪时初始化
 *     一次（`if (inv || …) return`），重新取回 `/rates` 不会把用户正在填的东西冲掉。
 *  2. **路径写成字面量，不进 `ep`**。`ep` 只收 GET（I-13），写路径一律字面量 ——
 *     `/go-live`、`/import/*`、`/restore` 都是这么做的。
 *  3. **不发请求体**。服务端 `contentTypeGuard` 只拦「带体的非 JSON 写请求」，
 *     无体 POST 合法（与 `/go-live` 同一条通道），因此这里不编一个空对象出来。
 *     源由服务端 `FX_SOURCE` 决定 —— 请求参数里**没有任何**指定地址的通道。
 */
import type { RatesRefreshDTO } from '@app/shared';
import { dataSource, invalidate, writable } from '../api/index.ts';
import { problemOf } from '../api/problem.ts';

/** 与 `catalogWrite.ts` 的 OFFLINE 同一层意思：离线源下这个动作同样不可用 */
const OFFLINE = '当前是离线数据源（?data=fixture），无法获取实时汇率';

export type RefreshRatesResult =
  | { ok: true; dto: RatesRefreshDTO }
  | { ok: false; message: string; offline?: true };

/**
 * 取一次源汇率并落库。
 *
 * **失败一律不改动任何东西**：服务端在取数/换算失败时直接返回错误、不写库
 * （见 `app/server/src/modules/catalog.ts` 的 `/rates/refresh`），
 * 所以这里不需要「失败回滚」之类的补偿逻辑。
 */
export async function refreshRates(): Promise<RefreshRatesResult> {
  if (!writable()) return { ok: false, message: OFFLINE, offline: true };
  try {
    const dto = await dataSource().send<RatesRefreshDTO>('POST', '/rates/refresh');
    invalidate();
    return { ok: true, dto };
  } catch (err) {
    const p = problemOf(err);
    return {
      ok: false,
      message: p ? p.message : `获取实时汇率失败：${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * 刷新结果 → 一句给用户看的话。
 *
 * 两种「一项都没改」必须分开说，否则会撒谎：
 *   · 源给了数、只是与本表一致     → 「已是最新」（`ok` 语气，这不是问题）；
 *   · 源里根本没有这些币种         → 「源未提供，保留原值」（`warn` 语气）。
 *     第二种是真会发生的情形：本位币被换成源不支持的代码时，整张表都会进 `skipped`，
 *     说成「已是最新」会让用户以为刷新成功、只不过数字恰好一样。
 *
 * `skipped` 里是**保留原值**而不是被清空的币种 —— 保留是刻意的：汇率被清成 0
 * 会让盘点的缺汇率门禁把整张快照拦下来（见服务端 `lib/fx-source.ts` 第 3 条约束）。
 */
export function refreshSummary(dto: RatesRefreshDTO): { text: string; tone: 'ok' | 'warn' } {
  const left = dto.skipped.length ? `${dto.skipped.join('、')} 源未提供，已保留原值` : '';
  if (dto.updated === 0) {
    return left
      ? { tone: 'warn', text: `已从 ${dto.source_label} 取回汇率，但 ${left}` }
      : { tone: 'ok', text: `已从 ${dto.source_label} 取回汇率，本表已是最新` };
  }
  return {
    tone: 'ok',
    text: `已从 ${dto.source_label} 更新 ${dto.updated} 项汇率${left ? `；${left}` : ''}`
  };
}
