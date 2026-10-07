/**
 * inventory/session.ts —— 盘点向导的服务端对接（Step 4）
 *
 * 这个模块只做两件事，别的什么都不做：
 *
 * 1. **边界换算**：领域层与界面里的金额是「元」number，API 边界是**微元整数**（×10^6）。
 *    整个盘点模块只有这里做这个转换。前端与后端各自只在一个地方换单位，
 *    「差 10^6 倍」这类缺陷就没有第二个藏身处。
 *
 * 2. 把四个端点封成四个函数（session / draft / preview / snapshots），
 *    并把服务端的错误翻译成能给用户看的话。
 *
 * ── 为什么 preview 不走 `mutate()` ──
 * `mutate()` 是「写成功 → 清空整个取数缓存」的统一出口，而 preview 是**只读试算**。
 * 让一次试算把整页数据作废、触发一轮全量重取，是白白的抖动。
 */
import type {
  InventoryDraftDTO,
  InventoryEntryDTO,
  InventoryPreviewDTO,
  InventorySaveDTO,
  InventorySessionDTO,
  Micro
} from '@app/shared';
import type { EntryState } from '@app/domain';
import { dataSource, mutate } from '../../api/index.ts';
import { microFromYuan, yuanFromMicro } from '../../lib/units.ts';

/** 界面上的一条录入（金额单位：元）。只取本模块要用的三个字段，避免依赖页面的内部类型。 */
export interface EntryLike {
  amount: number | null;
  principal: number | null;
  state: EntryState;
}

export type EntryMap = Record<string, EntryLike>;

/* ============================================================
   边界换算
   ============================================================ */

/*
 * 「元 ↔ 微元」的实现放在 `lib/units.ts` —— 那才是全前端唯一的换算点，
 * 这里只做「把一条录入拼成请求体」这件事。
 */

/** 界面录入 → API 请求体 */
export function toEntryDTO(e: EntryLike): InventoryEntryDTO {
  return {
    amount: microFromYuan(e.amount),
    principal: microFromYuan(e.principal),
    state: e.state
  };
}

/** 整张录入表 → API 请求体 */
export function toEntriesDTO(entries: EntryMap): Record<string, InventoryEntryDTO> {
  const out: Record<string, InventoryEntryDTO> = {};
  for (const [id, e] of Object.entries(entries)) out[id] = toEntryDTO(e);
  return out;
}

/**
 * 向导第 2 步的汇率表（元）→ API 请求体（微元）。
 *
 * 三个写端点（draft / preview / snapshots）共用这一个换算，
 * 免得出现「草稿里的汇率是 0.94、保存用的还是 0.93」这种半途分叉（见 I-22）。
 * 值为 null（`microFromYuan` 判定的非法输入、或用户把框清空）的条目直接丢掉，
 * 由服务端的 DB 汇率兜底 —— 这一条在 #8 之后变得常用：汇率框现在能被真正清空了。
 */
export function toRatesDTO(rates: Record<string, number | null>): Record<string, Micro> {
  const out: Record<string, Micro> = {};
  for (const [code, v] of Object.entries(rates)) {
    const m = microFromYuan(v);
    if (m !== null) out[code] = m;
  }
  return out;
}

/** API 返回的草稿 entries → 界面录入（金额回到「元」） */
export function fromEntriesDTO(
  entries: Record<string, InventoryEntryDTO>
): Record<string, EntryLike> {
  const out: Record<string, EntryLike> = {};
  for (const [id, e] of Object.entries(entries)) {
    out[id] = { amount: yuanFromMicro(e.amount), principal: yuanFromMicro(e.principal), state: e.state };
  }
  return out;
}

/** 日期是 `<input type="date">` 给的，用户清空时会得到空串；这类值一律不往服务端送 */
export function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/* ============================================================
   四个端点
   ============================================================ */

/** POST /inventory/session —— 开局把向导要用的原料一次拿全 */
export async function openSession(): Promise<InventorySessionDTO> {
  return dataSource().send<InventorySessionDTO>('POST', '/inventory/session');
}

/**
 * PUT /inventory/draft —— 自动保存草稿。
 *
 * `version` 传**上一次写入返回的版本号**；服务端不匹配时返回 409（多标签页保护）。
 * 首次写入（服务端还没有草稿）传 `null`，表示不校验版本。
 *
 * `rates` 是 Step 2 里用户改过的汇率（单位「元」，与界面同单位，到这里才换微元）——
 * 原型 `invRestore` 会把它合回向导；不带上就是「第 2 步白改一场」。
 *
 * @returns 写入后的新版本号
 */
export async function putDraft(
  version: number | null,
  date: string | null,
  note: string,
  entries: EntryMap,
  rates: Record<string, number | null>
): Promise<number> {
  const res = await dataSource().send<{ version: number }>('PUT', '/inventory/draft', {
    version,
    date,
    note,
    entries: toEntriesDTO(entries),
    rates: toRatesDTO(rates)
  });
  return res.version;
}

/** DELETE /inventory/draft —— 丢弃草稿（「重新开始」用） */
export async function discardDraft(): Promise<void> {
  await dataSource().send<{ discarded: boolean }>('DELETE', '/inventory/draft');
}

/**
 * POST /inventory/preview —— 服务端权威试算。只读，不清缓存。
 *
 * `rates` 必须带上：试算的意义就是「拿服务端将要落库的那份输入算一遍」，
 * 少了汇率就等于拿一份和保存时不同的输入去试算（见 I-22）。
 */
export async function previewSnapshot(
  date: string,
  entries: EntryMap,
  rates: Record<string, number | null>
): Promise<InventoryPreviewDTO> {
  return dataSource().send<InventoryPreviewDTO>('POST', '/inventory/preview', {
    date,
    entries: toEntriesDTO(entries),
    rates: toRatesDTO(rates)
  });
}

/**
 * POST /inventory/snapshots —— 保存快照（服务端单事务）。
 *
 * 走 `mutate()` 而不是直接 `send()`：保存成功会让快照列表、账户「最近金额」、
 * 报表趋势、账户页的收益列全部失效。把这些收在一次 `invalidate` 里，
 * 就不存在「保存成功了但首页还是旧数」的位置可写。
 *
 * `rates` 同样必须带上 —— 原型 `invSave()` 用的就是 `inv.rates`，
 * 并且把它冻结进 `snapshot_rate`。
 */
export async function saveSnapshot(
  date: string,
  note: string,
  entries: EntryMap,
  rates: Record<string, number | null>,
  confirmUnfilled: boolean
): Promise<InventorySaveDTO> {
  return mutate(ds =>
    ds.send<InventorySaveDTO>('POST', '/inventory/snapshots', {
      date,
      note,
      entries: toEntriesDTO(entries),
      rates: toRatesDTO(rates),
      confirm_unfilled: confirmUnfilled
    })
  );
}

/** 把草稿里出现过的账户 ID 收成集合（恢复时用来判断「这条草稿还认不认」） */
export function draftAccountIds(draft: InventoryDraftDTO | null): Set<string> {
  return new Set(Object.keys(draft?.entries ?? {}));
}
