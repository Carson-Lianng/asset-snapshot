/**
 * lib/units.ts —— 「元」number ↔ 微元整数 的**唯一**换算点（前端）
 *
 * 界面上、领域层里，金额都是「元」的 number；API 边界上，金额一律是微元整数（×10^6）。
 * 这两个世界的转换只允许写在这一处 —— 换算散落开之后，「差 10^6 倍」这类缺陷
 * 就有了第二个藏身处，而且它不会报错，只会在某一张报表上悄悄错一位。
 *
 * 为什么不用 `Math.round(v * 1e6)`：那是另一套舍入实现。承 `Money.fromNumber`
 * 是为了和领域层用同一套规则 —— 微元是领域层的底座，边界上换单位也该照着它来。
 */
import { Money } from '@app/domain';
import type { Micro } from '@app/shared';

/** 元 → 微元整数。`null` / `undefined` / 非有限数一律按「空」处理。 */
export function microFromYuan(v: number | null | undefined): Micro | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Number(Money.fromNumber(v).toMicro());
}

/** 微元整数 → 元（浮点）。只用于把服务端的值回填进输入框，不用于文本显示。 */
export function yuanFromMicro(v: Micro | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v) / 1_000_000;
}
