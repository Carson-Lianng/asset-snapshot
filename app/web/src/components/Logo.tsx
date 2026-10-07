/**
 * Logo.tsx —— 品牌标识「取景框 + 资产卡包」
 *
 * 立意：把这一包资产，框进一张照片。
 *   · 四角 L 形 = 相机取景框 ⇒ 「快照」（时点冻结、不可改写）
 *   · 中央直角卡包 = 「资产包」（多平台 / 多币种 / 多账户打包在一起）
 *   · 卡包内一枚货币符 = 本位币折算后的那一个数
 *
 * 几何全部按 48×48 viewBox 设计，`.brand-mark` 渲染 34px ⇒ 1 单位 ≈ 0.71px。
 * 三处参数是**实测**出来的，不是拍脑袋：
 *   1. L 内缩 3 / 臂长 11 —— 内缩 4 时 L 竖臂外沿在 x=5.6，而卡包描边外沿在 5.5，
 *      两者会重叠 0.1 单位，34px 下**角标与卡包会连成一条线**（看过 64px 渲染才发现的）。
 *      现在间隙 2.9 单位 ≈ 2px，分得开。臂长 12 又会顶到卡包，11 是上限。
 *   2. 卡包 30×18（比例 1.67:1，卡片比例）—— 曾经是 34×21，但那样四角几乎没有呼吸、
 *      取景框的「框」感会被卡包吃掉。
 *   3. 卡包内**只能再放一个元素**。加第二条线（哪怕是卡槽）就会在 34px 下与描边黏成墨团。
 * 16px 下三层结构仍在（货币符缩成一个墨点，属物理下限，不再优化）。
 *
 * 配色策略：几何用 currentColor 走，所以同一份几何在深底（侧栏黑块里的黄）与
 * 浅底（独立文件里的黑 + 黄）都能用，不需要维护两套图形。
 * 货币符单独抽成参数 —— 它是本位币的显示，不是图形的一部分。
 */

/** 侧栏品牌区用的方标。尺寸由调用方给，默认 34 与 `.brand-mark` 对齐 */
export function LogoMark({ size = 34, currency = '$' }: { size?: number; currency?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="家底快照"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M3 14V3h11" stroke="currentColor" strokeWidth="3.2" />
      <path d="M34 3h11v11" stroke="currentColor" strokeWidth="3.2" />
      <path d="M45 34v11H34" stroke="currentColor" strokeWidth="3.2" />
      <path d="M14 45H3V34" stroke="currentColor" strokeWidth="3.2" />
      <rect x="9" y="15" width="30" height="18" fill="currentColor" />
      <text
        x="24"
        y="24"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace"
        fontSize="15"
        fontWeight="700"
        style={{ fill: 'var(--ink,#0A0A0A)' }}
      >
        {currency}
      </text>
    </svg>
  );
}

/** 本位币代码 → 卡包里的那个字符 */
const SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  JPY: '¥',
  HKD: 'HK$',
  EUR: '€',
  GBP: '£'
};

export function currencyGlyph(code: string): string {
  return SYMBOL[code] ?? '$';
}
