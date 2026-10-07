/**
 * palette.ts —— 与原型完全一致的调色板
 *
 * 两个版本都要保留：CSS 变量版用于内联 style（`background:var(--blue)`），
 * hex 版用于 SVG 属性（SVG 的 fill/stroke 不吃 CSS 变量在旧渲染路径下的解析）。
 */
export const PALETTE = [
  'var(--yellow)',
  'var(--blue)',
  'var(--pink)',
  'var(--green)',
  'var(--orange)',
  'var(--purple)',
  'var(--paper-3)'
] as const;

export const PALETTE_HEX = [
  '#FFE500',
  '#7CC6FF',
  '#FF9BD2',
  '#9BE9A8',
  '#FFB067',
  '#C4A1FF',
  '#E4DECF'
] as const;

export function pickColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

export function pickHex(i: number): string {
  return PALETTE_HEX[i % PALETTE_HEX.length];
}

/** 同一币种在所有平台行使用同一颜色 */
export function currencyColorMap(rows: ReadonlyArray<{ by_currency: ReadonlyArray<{ code: string; base: number }> }>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const r of rows) {
    for (const c of r.by_currency) totals[c.code] = (totals[c.code] ?? 0) + Math.abs(c.base);
  }
  const codes = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const map: Record<string, number> = {};
  codes.forEach((c, i) => (map[c] = i));
  return map;
}

/**
 * 币种 → 颜色（2026-10-05 资产卡包的「币种色带」）。
 *
 * 与 `currencyColorMap` 的**分配方式不同**，这是刻意的：
 * 那张表按「金额从大到小」排位，币种集合一变，同一个币种的颜色就会漂。
 * 账户卡上的色带是**识别标记**（一屏扫过去按颜色区分钱包里有几种钱），
 * 颜色漂了就没有识别意义，所以这里用**币种代码自身的哈希**取模 ——
 * 与集合、顺序、金额全都无关，USD 在哪儿都是同一个颜色。
 *
 * 返回 CSS 变量（`var(--blue)` 这种），与 `PALETTE` 同一套 token。
 */
export function currencyColorOf(code: string): string {
  const s = (code || '').toUpperCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  /* 取前 6 个：第 7 个 `--paper-3` 与卡片底/分组底太接近，当色带用等于没有颜色 */
  return PALETTE[h % 6];
}
