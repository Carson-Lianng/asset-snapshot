import { useState, type ReactNode } from 'react';

/**
 * Collapse.tsx —— 原型里 `toggleCollapse` 的 React 版本
 *
 * DOM 与原型一致：`.collapse-block > .collapse-hd + .collapse-body`
 * 展开时 `.collapse-hd` 带 `open`（箭头旋转 90°），收起时 `.collapse-body` 内联 display:none。
 * 原型的展开态是 DOM class + 内联样式两处状态，这里保持同样的两处，避免样式漂移。
 */
export function Collapse({
  header,
  children,
  defaultOpen = true,
  bodyStyle,
  headerStyle
}: {
  header: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  bodyStyle?: React.CSSProperties;
  headerStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapse-block">
      <div
        className={'collapse-hd' + (open ? ' open' : '')}
        style={headerStyle}
        onClick={() => setOpen(v => !v)}
      >
        <span className="arw">▶</span>
        {header}
      </div>
      <div className="collapse-body" style={open ? bodyStyle : { display: 'none', ...bodyStyle }}>
        {children}
      </div>
    </div>
  );
}
