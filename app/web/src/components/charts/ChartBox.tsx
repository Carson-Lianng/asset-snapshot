import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * ChartBox.tsx —— 宽度自适应容器（原型 mountChart 的 React 版本）
 *
 * 原型的做法是渲染完页面后 `$$('[data-chart]').forEach(...)` 量宽度再 innerHTML。
 * 这里用 `useLayoutEffect` + `ResizeObserver`：首帧前就量好并同步重渲染，
 * 因此截图不会捕获到「宽度未定」的中间态。
 *
 * 宽度取值规则与原型的 mountChart 一致，只有上限跟着宽屏适配放开了：
 *   clientWidth < 80 → 退到父元素宽度；仍 < 80 → 720；上限 1680。
 *
 * 上限为什么从 1400 提到 1680：`.view` 的宽度上限已同步提到 1680（见 mount.css 的
 * 宽屏适配一节）。两处必须一致，否则卡片变宽了图表还停在 1400，卡内右侧会空出一条。
 * 1500 宽的验收视口下可用宽度仅约 1176，远低于任一个上限 ⇒ 基准图不受影响。
 */
export function ChartBox({
  children,
  className,
  style,
  dataChart
}: {
  children: (width: number) => ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** 保留原型里的 data-chart 标记，便于与基准图对照排查 */
  dataChart?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      let w = el.clientWidth;
      if (!w || w < 80) w = el.parentElement ? el.parentElement.clientWidth : 720;
      if (!w || w < 80) w = 720;
      setWidth(Math.min(w, 1680));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className={className} style={style} data-chart={dataChart}>
      {width > 0 ? children(width) : null}
    </div>
  );
}
