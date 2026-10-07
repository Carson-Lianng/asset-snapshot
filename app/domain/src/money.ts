/**
 * Money —— 定点金额值对象
 *
 * ── 实现说明（与《技术设计文档》ADR-05 的一处偏差，行为等价性由黄金值验证）──
 * 文档原定「乘除交给 decimal.js」。实际实现改为纯 bigint 定点乘除。理由：
 *   1. 库内金额与汇率一律是标度 10^6 的整数，乘除是纯整数运算，bigint 绝对精确，
 *      不存在 decimal.js 的 precision 配置与舍入模式选择问题；
 *   2. 领域层因此保持「零 npm 依赖」（设计原则 3），可脱离任何运行时单测；
 *   3. 前端包体积为 0（省去 decimal.js 的 gzip 约 9KB）。
 *
 * 关键约束：折算的乘法中间值会突破 IEEE 754 安全整数上限
 *   （9.007e15 微元 × 1e8 微元 ≈ 9e23），所以**全程不得经过 number**。
 *
 * 舍入：ROUND_HALF_UP（远离零方向），与文档 §5.4 一致。
 */

/** 标度：1 元 = 1_000_000 微元 */
export const SCALE = 1_000_000n;

/** 标度对应的 number 值（仅在确定为安全整数域的换算中使用） */
export const SCALE_NUM = 1_000_000;

const POW10: bigint[] = [
  1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n, 100000000n
];

/**
 * 比率专用标度：15 位小数。
 *
 * 为什么比率不能和金额共用 6 位标度：比率是连乘的结果，位数会累积。
 * 例：1.0753 × 0.1278 = 0.13742334（8 位有效小数），若压到 6 位变成 0.137423，
 * 在 200 万元级金额上会产生约 0.7 元的误差，直接破坏「逐位相等」的验收标准。
 */
const RATIO_DIGITS = 15;
const RATIO_SCALE = 10n ** 15n;

/** 把十进制串解析为指定小数位的定点整数 */
function parseScaled(s: string, digits: number): bigint {
  const t = String(s).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[2] === '' && !m[3])) throw new Error('无法解析数值：' + s);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] || '0';
  let frac = m[3] || '';
  let carry = 0n;
  if (frac.length > digits) {
    const nextDigit = frac.charCodeAt(digits) - 48;
    frac = frac.slice(0, digits);
    if (nextDigit >= 5) carry = 1n;
  }
  frac = (frac + '0'.repeat(digits)).slice(0, digits);
  const unit = 10n ** BigInt(digits);
  return sign * (BigInt(intPart) * unit + BigInt(frac) + carry);
}

/** 定点除法 + 四舍五入（远离零）。n / d，结果取整。 */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('定点除法：除数为 0');
  const negative = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = an / ad;
  const r = an % ad;
  const rounded = r * 2n >= ad ? q + 1n : q;
  return negative ? -rounded : rounded;
}

export class Money {
  readonly micro: bigint;

  constructor(micro: bigint) {
    this.micro = micro;
  }

  /* ---------- 构造 ---------- */

  static zero(): Money {
    return new Money(0n);
  }

  static fromMicro(micro: bigint): Money {
    return new Money(micro);
  }

  /**
   * 由十进制字符串构造，超出 6 位小数的部分按 HALF_UP 舍入。
   * 例："1234.56" → 1234560000n
   */
  static fromDecimalString(s: string): Money {
    const t = String(s).trim();
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
    if (!m || (m[2] === '' && !m[3])) throw new Error('无法解析金额：' + s);
    const sign = m[1] === '-' ? -1n : 1n;
    const intPart = m[2] || '0';
    let frac = m[3] || '';
    let carry = 0n;
    if (frac.length > 6) {
      const nextDigit = frac.charCodeAt(6) - 48;
      frac = frac.slice(0, 6);
      if (nextDigit >= 5) carry = 1n;
    }
    frac = (frac + '000000').slice(0, 6);
    return new Money(sign * (BigInt(intPart) * SCALE + BigInt(frac) + carry));
  }

  /** 由 number 构造（先经 toFixed(6)，避免二进制浮点尾数） */
  static fromNumber(n: number): Money {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error('金额必须为有限数值：' + String(n));
    }
    return Money.fromDecimalString(n.toFixed(6));
  }

  /* ---------- 运算 ---------- */

  add(o: Money): Money {
    return new Money(this.micro + o.micro);
  }

  sub(o: Money): Money {
    return new Money(this.micro - o.micro);
  }

  neg(): Money {
    return new Money(-this.micro);
  }

  abs(): Money {
    return new Money(this.micro < 0n ? -this.micro : this.micro);
  }

  /**
   * 定点乘法：金额 × 系数。中间积在 bigint 域，无溢出风险。
   *
   * 系数有两种形态：
   *   - Money   —— 汇率，库内最多 4 位小数，6 位标度足够
   *   - number  —— 折算比率，连乘后位数会累积，须走 15 位标度（见 RATIO_DIGITS）
   */
  mulByRatio(ratio: number | Money): Money {
    if (ratio instanceof Money) {
      return new Money(divRoundHalfUp(this.micro * ratio.micro, SCALE));
    }
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
      throw new Error('系数必须为有限数值：' + String(ratio));
    }
    const scaled = parseScaled(ratio.toFixed(RATIO_DIGITS), RATIO_DIGITS);
    return new Money(divRoundHalfUp(this.micro * scaled, RATIO_SCALE));
  }

  /** 语义化别名：金额 × 汇率 */
  mulByRate(rate: Money): Money {
    return this.mulByRatio(rate);
  }

  /** 除以整数（用于比率分母等场景） */
  divInt(k: bigint | number): Money {
    if (k === 0n || k === 0) throw new Error('定点除法：除数为 0');
    return new Money(divRoundHalfUp(this.micro, typeof k === 'bigint' ? k : BigInt(k)));
  }

  /* ---------- 比较 ---------- */

  cmp(o: Money): -1 | 0 | 1 {
    if (this.micro < o.micro) return -1;
    if (this.micro > o.micro) return 1;
    return 0;
  }

  eq(o: Money): boolean { return this.micro === o.micro; }
  isZero(): boolean { return this.micro === 0n; }
  isNeg(): boolean { return this.micro < 0n; }
  isPos(): boolean { return this.micro > 0n; }

  /* ---------- 输出 ---------- */

  toMicro(): bigint { return this.micro; }

  /** 微元整数的字符串形式（跨语言/跨进程传递用，无损） */
  toMicroString(): string { return this.micro.toString(); }

  /** 化为「元」的 number（仅用于展示或非精确场景，勿用于二次运算） */
  toNumber(): number { return Number(this.micro) / SCALE_NUM; }

  /** 格式化数字串，带千分位；dec 为小数位（默认 2） */
  toDisplay(dec = 2): string {
    if (dec < 0 || dec > 8) throw new Error('小数位数超出支持范围：' + dec);
    const negative = this.micro < 0n;
    const abs = negative ? -this.micro : this.micro;
    const units = divRoundHalfUp(abs * POW10[dec], SCALE);
    const digits = units.toString().padStart(dec + 1, '0');
    const intPart = dec > 0 ? digits.slice(0, digits.length - dec) : digits;
    const fracPart = dec > 0 ? digits.slice(digits.length - dec) : '';
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (negative ? '-' : '') + grouped + (dec > 0 ? '.' + fracPart : '');
  }

  /** 无千分位的数字串（测试与写文件用） */
  toPlain(dec = 2): string {
    return this.toDisplay(dec).replace(/,/g, '');
  }

  toJSON(): number {
    return this.toNumber();
  }

  toString(): string {
    return this.toDisplay(2);
  }
}

/* ---------- 便捷函数 ---------- */

export const moneyZero = (): Money => Money.zero();

export function sumMoney(list: Money[]): Money {
  let acc = 0n;
  for (const m of list) acc += m.micro;
  return new Money(acc);
}

/** 可空金额的求和：null 视为不参与 */
export function sumMoneyNonNull(list: (Money | null | undefined)[]): Money {
  let acc = 0n;
  for (const m of list) if (m) acc += m.micro;
  return new Money(acc);
}

export interface FormatMoneyOptions {
  /** 小数位，默认 2 */
  decimals?: number;
  /** 币种符号，省略则不出符号 */
  symbol?: string;
  /** 空值占位，默认「—」 */
  placeholder?: string;
}

export function formatMoney(m: Money | null | undefined, opts: FormatMoneyOptions = {}): string {
  const dec = opts.decimals ?? 2;
  const placeholder = opts.placeholder ?? '—';
  if (m === null || m === undefined) return placeholder;
  return (m.isNeg() ? '-' : '') + (opts.symbol ?? '') + m.abs().toDisplay(dec);
}
