/**
 * DecimalInput.tsx —— 支持 2 位小数的受控数字输入（第三批 #8）
 *
 * ── 为什么不能直接 `<input value={String(n)} onChange={e => set(Number(e.target.value))}>` ──
 * 用户敲「123.」时 `Number("123.")` 得到 `123`，React 立刻把 `value` 重置成 `"123"`，
 * **小数点会在眼前消失** —— 结果是这个框里根本打不出小数。需求 #8「录入金额需要支持
 * 2 位小数，目前是不支持的」说的就是这个，与精度无关：库里 / 接口 / 领域层
 * （微元整数 ×10⁶）从一开始就能精确表示 0.01 元。
 *
 * 同一处还有更贵的第二个症状：盘点第 2 步的汇率框也是这个写法（`value={rates[c] ?? 0}`
 * + `Number.parseFloat(value) || 0`）。想把 JPY 的 0.0486 改成别的值，删到「0.」时
 * 会被归一成「0」再变成「9」——**汇率实际上是无法编辑的**。历史上的
 * 「HKD 汇率改错导致净资产差 ¥2,540」正出自这一族问题。
 *
 * ── 做法 ──
 * 输入框**自己持有一份文本**：文本只跟用户的按键走，解析出的数值才往上传。
 * 外部把值改掉时（恢复草稿、「全部沿用上次」、从公开源刷新汇率）文本要跟着同步，
 * 这件事的判据是「**解析后的文本 ≠ 传入的值**」：
 *   · 打字中间态（`"123."` / `"0."` / `"."`）解析后仍等于传入的值 ⇒ **不打断输入**；
 *   · 外部赋值（值从 0.93 变成 0.94）解析结果与传入值不等 ⇒ 文本同步过来。
 * 用「值不等」而不是「引用不等」当判据，是这里唯一的关键。
 *
 * 失焦时把文本归一（`"123."` → `"123"`、`"007"` → `"7"`），这样框里最终留下的是
 * 真正会被提交的那个数。
 *
 * ⚠ 不可解析的输入一律按「空」（`null`）处理，与领域层 `resolveAmountInput` 同口径：
 * 原型会留下 `state='filled'` 而 `amount=null` 的不一致状态，这里不收。
 */
import { useState, type CSSProperties } from 'react';

/** 值 → 文本。`null` 是空框（不是 0）——「没填」与「填了 0」是两回事 */
function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * 文本 → 值。空串与非有限数都按 `null`。
 *
 * 用 `Number` 而不是 `parseFloat`：`parseFloat("12abc")` 会得到 12（静默吞掉后面的垃圾），
 * 而 `Number("12abc")` 是 `NaN` ⇒ 按「空」处理。这符合「这个框只接受一个数」的预期。
 */
function parse(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function DecimalInput({
  value,
  onValue,
  className,
  style,
  placeholder,
  selectOnFocus = true
}: {
  value: number | null;
  onValue: (v: number | null) => void;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  /** 聚焦时全选（便于整值重输）。原型在这里就是这么做的 */
  selectOnFocus?: boolean;
}) {
  const [text, setText] = useState(() => fmt(value));

  /* 渲染期同步（React 官方的「props 变化时调整 state」写法）：
     `parse(text) !== value` 才是「外部把值改了」的判据，见文件头。 */
  if (parse(text) !== value) setText(fmt(value));

  return (
    <input
      className={className}
      style={style}
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onChange={e => {
        setText(e.target.value);
        onValue(parse(e.target.value));
      }}
      onBlur={() => setText(fmt(value))}
      onFocus={selectOnFocus ? e => e.target.select() : undefined}
    />
  );
}
