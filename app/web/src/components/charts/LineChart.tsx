/**
 * LineChart.tsx —— 折线图（Neo-Brutalism）
 *
 * 与原型的 chartLine 逐属性对齐：同样的 padding、同样的 4 条虚线网格、
 * 同样的 9×9 方形数据点、同样的虚线本位币变更标记。
 * 坐标全部使用「元」浮点数（与原型一致），只有刻度文本走精确整数格式化。
 */
import { axisLabel } from '../../lib/money.ts';

export interface LinePoint {
  x: string;
  y: number;
}

export interface LineSeries {
  data: LinePoint[];
  color: string;
  /** 面积填充 */
  area?: boolean;
  /** 在黑色描边内再描一条同色细线 */
  inner?: boolean;
  /**
   * 在每个数据点上方标出数值（需求 #6「净资产趋势图需要显示每个点的值」）。
   * 只给**一条**序列开，多条序列同时标值会互相压字；报表页开在「净资产」那一条上。
   * 数值带白色描边（paint-order:stroke），压在面积填充或网格线上仍然可读。
   */
  valueLabels?: boolean;
}

export interface BaseChangeMarker {
  index: number;
  from: string;
  to: string;
}

export function LineChart({
  w,
  series,
  height = 250,
  markers
}: {
  w: number;
  series: LineSeries[];
  height?: number;
  markers?: BaseChangeMarker[];
}) {
  const padL = 90;
  const padR = 18;
  const padT = 20;
  const padB = 42;
  const iw = Math.max(w - padL - padR, 60);
  const ih = height - padT - padB;
  const n = series[0].data.length;

  const all = series.flatMap(s => s.data.map(p => p.y));
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.14;
  min -= pad;
  max += pad;

  const X = (i: number) => padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const Y = (v: number) => padT + ih - ((v - min) / (max - min)) * ih;

  const ticks = 4;
  const gridLines: Array<{ y: number; v: number }> = [];
  for (let i = 0; i <= ticks; i++) {
    gridLines.push({ y: padT + (ih * i) / ticks, v: max - ((max - min) * i) / ticks });
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      width="100%"
      height={height}
      style={{ display: 'block', fontFamily: 'var(--mono)' }}
    >
      {gridLines.map((g, i) => (
        <g key={'grid' + i}>
          <line
            x1={padL}
            y1={g.y}
            x2={w - padR}
            y2={g.y}
            stroke="#0A0A0A"
            strokeWidth={1}
            strokeDasharray="4 5"
            opacity={0.22}
          />
          <text x={padL - 8} y={g.y + 4} textAnchor="end" fontSize={10.5} fill="#6B6459" fontWeight={700}>
            {axisLabel(g.v)}
          </text>
        </g>
      ))}

      {min < 0 && max > 0 ? (
        <line x1={padL} y1={Y(0)} x2={w - padR} y2={Y(0)} stroke="#0A0A0A" strokeWidth={2.5} />
      ) : null}

      <line x1={padL} y1={padT} x2={padL} y2={padT + ih} stroke="#0A0A0A" strokeWidth={3} />
      <line x1={padL} y1={padT + ih} x2={w - padR} y2={padT + ih} stroke="#0A0A0A" strokeWidth={3} />

      {series.map((se, si) => {
        const pts = se.data.map((p, i) => [X(i), Y(p.y)] as const);
        const poly = pts.map(p => p.join(',')).join(' ');
        /* 只有一个点时没有「线」可画：polyline 画不出东西，area 会退化成零面积多边形。
           此时只留数据点与数值标签（需求 #6「只有一条数据也需要显示」）。 */
        const hasLine = pts.length >= 2;
        return (
          <g key={'s' + si}>
            {se.area && hasLine ? (
              <polygon
                points={`${poly} ${X(n - 1)},${padT + ih} ${X(0)},${padT + ih}`}
                fill={se.color}
                opacity={0.3}
              />
            ) : null}
            {hasLine ? (
              <polyline
                points={poly}
                fill="none"
                stroke="#0A0A0A"
                strokeWidth={3.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null}
            {se.inner && hasLine ? <polyline points={poly} fill="none" stroke={se.color} strokeWidth={1.6} /> : null}
            {pts.map((p, i) => (
              <rect
                key={'p' + i}
                x={p[0] - 4.5}
                y={p[1] - 4.5}
                width={9}
                height={9}
                fill={se.color || '#0A0A0A'}
                stroke="#0A0A0A"
                strokeWidth={2.5}
              />
            ))}
            {se.valueLabels
              ? pts.map((p, i) => (
                  <text
                    key={'v' + i}
                    x={p[0]}
                    y={p[1] - 11}
                    textAnchor="middle"
                    fontSize={10}
                    fill="#0A0A0A"
                    fontWeight={800}
                    stroke="#FFFFFF"
                    strokeWidth={3}
                    paintOrder="stroke"
                    strokeLinejoin="round"
                  >
                    {axisLabel(se.data[i].y)}
                  </text>
                ))
              : null}
          </g>
        );
      })}

      {series[0].data.map((p, i) => (
        <text
          key={'x' + i}
          x={X(i)}
          y={padT + ih + 18}
          textAnchor="middle"
          fontSize={10.5}
          fill="#0A0A0A"
          fontWeight={700}
        >
          {p.x.length > 5 ? p.x.slice(5) : p.x}
        </text>
      ))}

      {markers?.map((m, i) => {
        const x = X(m.index);
        return (
          <g key={'m' + i}>
            <line
              x1={x}
              y1={padT - 6}
              x2={x}
              y2={padT + ih + 6}
              stroke="#FF5A5F"
              strokeWidth={3}
              strokeDasharray="6 4"
            />
            <rect x={x - 3} y={padT - 12} width={6} height={6} fill="#FF5A5F" stroke="#0A0A0A" strokeWidth={2} />
          </g>
        );
      })}
    </svg>
  );
}
