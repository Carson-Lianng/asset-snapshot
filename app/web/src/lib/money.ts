/**
 * money.ts —— 金额显示（前端）
 *
 * 与原型 `money(n, dec, cur)` 的显示结果逐字符等价，但内部走 **整数运算**：
 * DTO 里的金额一律是微元整数（×10^6，见 contracts.ts 的 `Micro`），
 * 这里先把微元精确四舍五入到 dec 位，再补千分位与币种符号 —— 全程不经过浮点。
 *
 * 为什么这是「等价」而不是「近似」：
 *   本库所有金额都是 0.01 元的整数倍（已在 .data 上全量核对，0 个例外）。
 *   对 dec=0 的显示，唯一可能分歧的是恰好落在 X.5 元的值，
 *   原型路径（toLocaleString 的 halfExpand）与本实现的「半值向上」方向一致，
 *   实测 3 处边界值（7352.50 / 141765.50）两者结果相同。
 *
 * 另有一处刻意的行为差异：原型在 money() 内部用 `isNaN` 兜底，
 * 这里用类型系统在源头拦掉非数值，运行期只处理 `null | undefined | 微元整数`。
 */
import type { Money } from '@app/domain';
import type { Micro } from '@app/shared';

/** 微元标度：1 元 = 1_000_000 微元 */
export const MICRO = 1_000_000n;

/**
 * 领域层 Money → 传输层微元整数（本模块所有格式化入口的入参形态）。
 *
 * 为什么不直接 `money(m.toNumber())`：那要先经过浮点。微元整数正好落在
 * IEEE 754 安全整数域内（本库最大绝对值 2.19e12 微元 ≪ 2^53），
 * 因此 Number(micro) 是**精确**的，全程不引入舍入。
 */
export function microOf(m: Money | null | undefined): Micro | null {
  return m === null || m === undefined ? null : Number(m.toMicro());
}

/** 领域层 Money → 「元」浮点。仅用于 SVG 坐标与输入框回填，不用于文本显示 */
export function yuanOf(m: Money | null | undefined): number | null {
  return m === null || m === undefined ? null : m.toNumber();
}

const POW10: readonly bigint[] = [1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n];

/** 半值向上（half-up，按绝对值），与 Intl 的 halfExpand 同向 */
function roundScaled(abs: bigint, dec: number): bigint {
  if (dec >= 6) return abs * POW10[dec - 6];
  const drop = POW10[6 - dec];
  return (abs + drop / 2n) / drop;
}

/** 千分位分组 */
function group(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/** 把已按 10^dec 放大过的整数格式化为带千分位与小数的字符串 */
export function formatScaled(scaled: bigint, dec: number): string {
  if (dec === 0) return group(scaled.toString());
  const unit = POW10[dec];
  const intPart = scaled / unit;
  const fracPart = (scaled % unit).toString().padStart(dec, '0');
  return `${group(intPart.toString())}.${fracPart}`;
}

/** 微元 → 「1,234.56」形式的字符串（不含符号与币种符号） */
export function microToDigits(micro: bigint, dec: number): string {
  const abs = micro < 0n ? -micro : micro;
  return formatScaled(roundScaled(abs, dec), dec);
}

/**
 * 微元 → 「万元」文案，用于环形图中心（原型写作 `money(总资产 / 10000, 1) + '万'`）。
 * 微元 → 万元是除以 10^10；保留 dec 位小数等价于把微元按 10^(10-dec) 取整后再插入小数点。
 */
export function wanText(micro: Micro, dec = 1): string {
  const negative = micro < 0;
  const abs = negative ? -BigInt(micro) : BigInt(micro);
  const shift = 10n ** BigInt(10 - dec);
  const scaled = (abs + shift / 2n) / shift;
  return (negative ? '-' : '') + formatScaled(scaled, dec);
}

/* ============================================================
   币种符号表：启动时由 setCurrencies 注入（与原型同序查找）
   ============================================================ */

let symbolMap = new Map<string, string>();
let baseCurrency = 'CNY';

export function setCurrencyTable(
  currencies: ReadonlyArray<{ code: string; symbol: string }>,
  base: string
): void {
  symbolMap = new Map(currencies.map(c => [c.code, c.symbol]));
  baseCurrency = base;
}

export function setBaseCurrency(code: string): void {
  baseCurrency = code;
}

export function getBaseCurrency(): string {
  return baseCurrency;
}

export function symbolOf(code?: string | false | null): string {
  if (code === false) return '';
  const key = code === undefined || code === null ? baseCurrency : code;
  return symbolMap.get(key) ?? '';
}

/* ============================================================
   主格式化入口
   ============================================================ */

/**
 * @param micro 微元整数，null / undefined → '—'
 * @param dec   小数位
 * @param cur   币种代码；省略 → 本位币；`false` → 只出数字（坐标轴等）
 */
export function money(micro: Micro | null | undefined, dec = 2, cur?: string | false): string {
  if (micro === null || micro === undefined) return '—';
  return dispatch(BigInt(micro), dec, cur);
}

function dispatch(micro: bigint, dec: number, cur?: string | false): string {
  const digits = microToDigits(micro, dec);
  const sign = micro < 0n ? '-' : '';
  return sign + symbolOf(cur) + digits;
}

export function money0(micro: Micro | null | undefined, cur?: string | false): string {
  return money(micro, 0, cur);
}

/** 整数金额不带小数位，非整数保留 2 位（对应原型的 moneyAuto） */
export function moneyAuto(micro: Micro | null | undefined, cur?: string | false): string {
  if (micro === null || micro === undefined) return '—';
  const isIntegerYuan = BigInt(micro) % MICRO === 0n;
  return money(micro, isIntegerYuan ? 0 : 2, cur);
}

export function signed(micro: Micro, dec = 2, cur?: string | false): string {
  return (micro > 0 ? '+' : '') + money(micro, dec, cur);
}

/* ============================================================
   涨跌 / 百分比
   阈值也按微元表达：原型用 0.0001 元与 0.005 元
   ============================================================ */

export const UP_EPSILON: Micro = 100; // 0.0001 元
export const ZERO_EPSILON: Micro = 5000; // 0.005 元

export type Trend = 'up' | 'down' | 'flat';

export function trendOf(micro: Micro): Trend {
  if (micro > UP_EPSILON) return 'up';
  if (micro < -UP_EPSILON) return 'down';
  return 'flat';
}

/** 与 deltaHtml 同构：▲ +1,234 / ▼ 1,234 / ＝ 0 */
export function deltaParts(
  micro: Micro,
  dec = 2,
  cur?: string | false
): { cls: Trend; sign: string; text: string } {
  const cls = trendOf(micro);
  const sign = cls === 'up' ? '▲ +' : cls === 'down' ? '▼ ' : '＝ ';
  /* 箭头已经表达了方向，数值本身一律输出绝对值；
     绝对值小于 0.005 元时显示为 0（与原型 `Math.abs(v) < 0.005 ? 0 : v` 同义） */
  const abs = micro < 0 ? -micro : micro;
  const shown = abs < ZERO_EPSILON ? 0 : abs;
  return { cls, sign, text: dispatch(BigInt(shown), dec, cur) };
}

/** 百分比文本（不含 span），对应原型的 pctText */
export function pctText(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
}

export type PctParts = { cls: Trend; text: string };

/** 百分比视图，对应原型的 pctHtml（阈值 0.0005） */
export function pctParts(v: number | null | undefined): PctParts {
  if (v === null || v === undefined || !isFinite(v)) return { cls: 'flat', text: '—' };
  const cls: Trend = v > 0.0005 ? 'up' : v < -0.0005 ? 'down' : 'flat';
  return { cls, text: v > 0.0005 ? '+' + (v * 100).toFixed(2) + '%' : (v * 100).toFixed(2) + '%' };
}

/* ============================================================
   便捷转换
   ============================================================ */

/** 微元 → 元（浮点）。只用于 SVG 坐标计算与图表刻度，不用于文本显示 */
export function toYuan(micro: Micro | null | undefined): number {
  return micro === null || micro === undefined ? 0 : Number(micro) / 1e6;
}

/** 汇率微元 → 数值（7.28 显示为 7.28，0.0486 显示为 0.0486） */
export function rateNum(micro: Micro): number {
  return Number(micro) / 1e6;
}

/** 汇率显示文本，等价于原型里直接插值 `it.exchange_rate` */
export function rateText(micro: Micro): string {
  return String(rateNum(micro));
}

/** 图表坐标轴刻度：原型用 money0(v)，此处等价 */
export function axisLabel(yuan: number): string {
  const micro = BigInt(Math.round(yuan * 1e6));
  return dispatch(micro, 0, false);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
