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
 *
 * ## fillHeight（2026-10-07，首页双卡适配）
 *
 * 传 `fillHeight` 后同时量**高度**，回调签名变为 `(w, h)`。用途：等高卡片
 * （`.card.eq` 的 `auto 1fr` 行）里，让图表填满「卡片被邻卡撑高后剩下的空间」，
 * 而不是顶着写死的 height、在卡底拖一截空白。
 *
 * ⚠ 两条使用纪律（都来自 grid 的 `1fr = minmax(auto,1fr)` 语义）：
 *   · 容器必须处在「高度由父布局决定」的轨道上（1fr 行），并且要给容器一个
 *     **显式 min-height**（如 220）—— 这同时把 auto 最小尺寸换成定值，否则
 *     「行高被上一次的内容高度顶住」会让视口变宽后卡白收不回来；
 *   · 不满足这条的场合（容器高度由内容决定）不要开，量出来恒等于内容高，没有意义。
 */
export function ChartBox({
  children,
  className,
  style,
  dataChart,
  fillHeight = false
}: {
  children: (width: number, height: number) => ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** 保留原型里的 data-chart 标记，便于与基准图对照排查 */
  dataChart?: string;
  /** 同时量高并把 (w, h) 交给回调；见上方「使用纪律」 */
  fillHeight?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      let w = el.clientWidth;
      if (!w || w < 80) w = el.parentElement ? el.parentElement.clientWidth : 720;
      if (!w || w < 80) w = 720;
      w = Math.min(w, 1680);
      /* clientHeight 恰是我们想要的「布局分给这一格的高度」；不加 fillHeight 时
         恒为内容高，旧调用方拿不到这个值，行为与原来完全一致。 */
      const h = fillHeight ? el.clientHeight : 0;
      setSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fillHeight]);

  return (
    <div ref={ref} className={className} style={style} data-chart={dataChart}>
      {size.w > 0 ? children(size.w, size.h) : null}
    </div>
  );
}
