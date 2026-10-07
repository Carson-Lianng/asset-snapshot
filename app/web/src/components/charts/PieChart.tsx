/**
 * PieChart.tsx —— 饼图（含环形中心文案）与配套图例
 *
 * 与原型的 chartPie / pieLegendHTML 逐属性对齐。
 * 有一处**刻意保留的原样**：原型在 `<text>` 上用 `font-family="var(--mono)"`
 * 作为 SVG 表现属性写 CSS 变量，这在浏览器里是无效值因而被忽略。
 * 为了外观逐像素一致，这里不做「修正」，原样保留。
 *
 * 2026-10-04 新增悬浮明细（需求 #8 / #11）：传入 `tipFor` 后，光标移到某一片上会
 * 弹出该片的明细（首页分类饼图给「该分类的币种构成」，币种饼图给「该币种明细」）。
 * 要点：
 *   · 提示框跟着光标走，因此需要外层 `position:relative` 的包裹元素来算相对坐标；
 *   · 未传 `tipFor` 时**不挂任何事件**，DOM 与之前完全一致（外观回归不受影响）；
 *   · 提示框只在鼠标交互时出现，静态截图里不存在 ⇒ Step 3 基准图不受影响。
 *
 * 2026-10-04 再新增「点选」（需求 #4 的报表下钻）：传 `onSelect` 后扇区可点击，
 * `selected` 指到的那一片加粗描边表示「当前下钻范围」。同样地——
 *   · **不传 `onSelect` 就不挂 `onClick`**，这一层契约与原实现完全一致；
 *   · 加粗只在 `selected !== null` 时发生，而静态截图里没有任何选中项
 *     ⇒ 基准图仍然不受影响（`.pie-slice` 只含 `cursor:pointer`，不产生像素）。
 */
import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Micro } from '@app/shared';
import { money, toYuan } from '../../lib/money.ts';
import { pickHex } from '../../lib/palette.ts';

export interface PieRow {
  name: string;
  v: Micro;
}

export function PieChart({
  rows,
  size = 230,
  centerText,
  tipFor,
  onSelect,
  selected = null
}: {
  rows: PieRow[];
  size?: number;
  centerText?: { k: string; v: string };
  /** 悬浮第 i 片时显示的明细内容；不传则整个饼图不响应悬浮 */
  tipFor?: (index: number) => ReactNode;
  /** 点击第 i 片；不传则整个饼图不可点（DOM 里连 `onClick` 都没有） */
  onSelect?: (index: number) => void;
  /** 当前选中的片（下钻范围）；`null` 表示没选中，所有扇区样式与原来一致 */
  selected?: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  /** 「可交互」= 有悬浮或有选点。它只影响 `cursor` 与事件挂载，不影响任何像素 */
  const interactive = !!tipFor || !!onSelect;

  const total = rows.reduce((s, x) => s + Math.abs(toYuan(x.v)), 0);
  if (!rows.length || total <= 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 14;

  let a0 = -Math.PI / 2;
  const arcs = rows.map((r, i) => {
    const frac = Math.abs(toYuan(r.v)) / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + R * Math.cos(a0);
    const y0 = cy + R * Math.sin(a0);
    const x1 = cx + R * Math.cos(a1);
    const y1 = cy + R * Math.sin(a1);
    a0 = a1;
    return { i, frac, large, x0, y0, x1, y1 };
  });

  /** 把光标位置换算成相对包裹元素的坐标，并把提示框夹在饼图范围内避免横溢出卡片 */
  const track = tipFor
    ? (i: number) => (e: ReactMouseEvent) => {
        const r = wrapRef.current?.getBoundingClientRect();
        if (!r) return;
        const margin = 96;
        setHover({
          i,
          x: Math.min(Math.max(e.clientX - r.left, margin), Math.max(size - margin, margin)),
          y: e.clientY - r.top
        });
      }
    : undefined;

  /* 提示框默认在光标上方；光标落在饼图上半部时改到下方 —— 否则会顶出卡片、
     压住上方的指标卡。 */
  const tipBelow = hover ? hover.y < size / 2 : false;

  return (
    <div className="pie-wrap" ref={wrapRef} onMouseLeave={tipFor ? () => setHover(null) : undefined}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ display: 'block' }}>
        <circle cx={cx + 6} cy={cy + 6} r={R} fill="#0A0A0A" />
        {/* 垫一层不透明白底：悬浮时非命中扇区会被压暗（透明度 < 1），
            没有这层的话它们会透出背后那个黑色阴影圆，一半变黑一半发白，很脏。
            扇区静止时完全不透明，这层圆被盖住 ⇒ 不改变静态外观。 */}
        <circle cx={cx} cy={cy} r={R} fill="#FFFFFF" />
        {arcs.map(a => {
          const fill = pickHex(a.i);
          /* 悬浮某片时其余片压暗，让对上的那一片立起来 */
          const dim = hover && hover.i !== a.i ? 0.32 : 1;
          /* 选中片加粗描边：不加任何 class（CSS 一字节不动），只用 SVG 自身属性。
             两条路径都要带上 —— 单片占满（frac ≈ 1）走 circle，其余走 path。 */
          const sw = selected === a.i ? 6 : 3;
          if (a.frac > 0.9999) {
            return (
              <circle
                key={a.i}
                className={interactive ? 'pie-slice' : undefined}
                cx={cx}
                cy={cy}
                r={R}
                fill={fill}
                stroke="#0A0A0A"
                strokeWidth={sw}
                opacity={dim}
                onMouseMove={track?.(a.i)}
                onClick={onSelect ? () => onSelect(a.i) : undefined}
              />
            );
          }
          return (
            <path
              key={a.i}
              className={interactive ? 'pie-slice' : undefined}
              d={`M${cx},${cy} L${a.x0},${a.y0} A${R},${R} 0 ${a.large} 1 ${a.x1},${a.y1} Z`}
              fill={fill}
              stroke="#0A0A0A"
              strokeWidth={sw}
              strokeLinejoin="round"
              opacity={dim}
              onMouseMove={track?.(a.i)}
              onClick={onSelect ? () => onSelect(a.i) : undefined}
            />
          );
        })}
        {centerText ? (
          <>
            <circle cx={cx} cy={cy} r={R * 0.44} fill="#FDF8EE" stroke="#0A0A0A" strokeWidth={3} />
            <text
              x={cx}
              y={cy - 1}
              textAnchor="middle"
              fontSize={10}
              fontFamily="var(--mono)"
              fill="#6B6459"
              fontWeight={700}
            >
              {centerText.k}
            </text>
            <text
              x={cx}
              y={cy + 14}
              textAnchor="middle"
              fontSize={13}
              fontFamily="var(--mono)"
              fill="#0A0A0A"
              fontWeight={800}
            >
              {centerText.v}
            </text>
          </>
        ) : null}
      </svg>
      {tipFor && hover ? (
        <div className={'pie-tip ' + (tipBelow ? 'below' : 'above')} style={{ left: hover.x, top: hover.y }}>
          {tipFor(hover.i)}
        </div>
      ) : null}
    </div>
  );
}

export function PieLegend({ rows, total }: { rows: PieRow[]; total: Micro }) {
  const t = toYuan(total);
  return (
    <div className="pie-legend">
      {rows.map((r, i) => (
        <div className="li" key={r.name + i}>
          <span className="sw" style={{ background: pickHex(i) }} />
          <span>{r.name}</span>
          <span className="muted tiny mono">
            {t > 0 ? ((Math.abs(toYuan(r.v)) / t) * 100).toFixed(1) + '%' : '—'}
          </span>
          <span className="amt">{money(r.v, 0)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 饼图 + 右侧图例的固定组合（首页 / 报表的资产配置、负债结构、币种分布都是这个形状）。
 * 抽出来是为了让「悬浮明细」只实现一次 —— 各页只负责给自己的卡片包一层 `.card` 与标题。
 */
export function PieWithLegend({
  rows,
  size = 210,
  centerText,
  tipFor,
  onSelect,
  selected = null,
  legendMinWidth = 200,
  chartAttrs
}: {
  rows: PieRow[];
  size?: number;
  centerText?: { k: string; v: string };
  tipFor?: (index: number) => ReactNode;
  /** 点击第 i 片（下钻）；不传则不可点 */
  onSelect?: (index: number) => void;
  /** 当前选中的片 */
  selected?: number | null;
  legendMinWidth?: number;
  /** 原型留下的 data-chart 标记，仅用于与基准图对照排查 */
  chartAttrs?: Record<string, string>;
}) {
  const total = rows.reduce((s, x) => s + Math.abs(x.v), 0) as Micro;
  return (
    <div className="flex" style={{ gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div {...chartAttrs} style={{ flex: '0 0 auto' }}>
        <PieChart rows={rows} size={size} centerText={centerText} tipFor={tipFor} onSelect={onSelect} selected={selected} />
      </div>
      <div className="grow" style={{ minWidth: legendMinWidth }}>
        <PieLegend rows={rows} total={total} />
      </div>
    </div>
  );
}
