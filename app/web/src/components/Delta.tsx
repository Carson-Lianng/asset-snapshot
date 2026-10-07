/**
 * Delta.tsx —— 涨跌与百分比
 *
 * 与原型 deltaHtml / pctHtml 的产物完全一致：
 *   <span class="delta up">▲ +1,234</span>
 *   <span class="delta flat">—</span>
 * 注意符号在币种符号之前由 money 输出（`-¥1,234`），箭头本身不再带负号。
 */
import type { Micro } from '@app/shared';
import { deltaParts, pctParts } from '../lib/money.ts';

export function Delta({ v, dec = 2, cur }: { v: Micro | null | undefined; dec?: number; cur?: string | false }) {
  if (v === null || v === undefined) return <span className="flat">—</span>;
  const { cls, sign, text } = deltaParts(v, dec, cur);
  return (
    <span className={'delta ' + cls}>
      {sign}
      {text}
    </span>
  );
}

export function Pct({ v }: { v: number | null | undefined }) {
  const { cls, text } = pctParts(v);
  return <span className={'delta ' + cls}>{text}</span>;
}

/**
 * 「较上期 ▲ +1,234」一行 —— 三个页面的理财卡片共用（第三批 #6）。
 *
 * 三态，每种都必须长得不一样，否则同一张卡在不同时刻会说不同的话：
 *   · `noPrev`            —— **确定没有前一期**（首次快照）→ 「首期，无可比期」；
 *   · `diff === null`     —— 有前一期，但那一期的面板还没取回来 → 「—」。
 *     这里刻意不用「什么都不渲染」：`.stat` 是竖排 flex，少一行会让卡片高度变一次，
 *     一屏三张卡同时跳一下比一个短横难看得多；
 *   · 其余                —— 涨跌额。`dec` 默认 0：本金与市值都是整元展示的。
 *
 * 注意 `diff === 0` 落在第三态（`Delta` 会渲染「—」样式的 flat），这是对的：
 * 「与上期完全一样」和「没有可比期」是两件事，前者用 `flat` 的短横表达已经足够。
 */
export function PrevCompare({
  diff,
  noPrev = false,
  label = '较上期'
}: {
  diff: Micro | null | undefined;
  /** true = 确定没有前一期（首次快照） */
  noPrev?: boolean;
  label?: string;
}) {
  if (noPrev) return <span className="flat">首期，无可比期</span>;
  if (diff === null || diff === undefined) return <span className="flat">—</span>;
  return (
    <>
      {`${label} `}
      <Delta v={diff} dec={0} />
    </>
  );
}
