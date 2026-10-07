/**
 * Atoms.tsx —— 通用小件
 *
 * 全部按原型的 class 名与 DOM 结构 1:1 复刻，这样 tokens.css 才能保持逐像素生效。
 * 原型里的 `esc()` 在这里不需要：React 默认转义文本节点。
 */
import type { CSSProperties, ReactNode } from 'react';
import type { AccountType } from '@app/shared';

export function Spacer({ flex = 1 }: { flex?: number }) {
  return <span className="spacer" style={{ flex }} />;
}

/* ---------------- 徽章 ---------------- */

export function CurBadge({ code }: { code: string }) {
  return <span className="badge cur">{code}</span>;
}

export function TypeBadge({ type }: { type: AccountType }) {
  return type === 'asset' ? <span className="badge asset">资产</span> : <span className="badge liab">负债</span>;
}

export function CatBadge({ name, type }: { name: string; type: AccountType }) {
  return <span className={'badge ' + (type === 'liability' ? 'liab' : 'asset')}>{name}</span>;
}

export function TagBadges({
  tags,
  max,
  fallback = '—'
}: {
  tags: ReadonlyArray<{ id?: string; name: string }> | null | undefined;
  max?: number;
  fallback?: string;
}) {
  if (!tags || !tags.length) return <span className="muted tiny">{fallback}</span>;
  const list = max ? tags.slice(0, max) : tags;
  return (
    <>
      {list.map((t, i) => (
        <span className="badge tag" key={t.id ?? i}>
          {t.name}
        </span>
      ))}
      {max && tags.length > max ? <span className="badge mute">+{tags.length - max}</span> : null}
    </>
  );
}

export function RoleDot({ type }: { type: AccountType }) {
  return <span className="dot" style={{ background: type === 'asset' ? 'var(--blue)' : 'var(--pink)' }} />;
}

/* ---------------- 区块标题 ---------------- */

export function SecTitle({
  children,
  first,
  style
}: {
  children: ReactNode;
  first?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={'sec-title' + (first ? ' first' : '')} style={style}>
      {children}
    </div>
  );
}

export function CardHd({
  title,
  sub,
  right
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="card-hd">
      <h3>{title}</h3>
      {sub !== undefined && sub !== null ? <span className="sub">{sub}</span> : null}
      {right ? (
        <>
          <span className="spacer" />
          {right}
        </>
      ) : null}
    </div>
  );
}

/* ---------------- 指标卡 ---------------- */

export type StatTone = 'plain' | 'hero' | 'blue' | 'pink' | 'purple' | 'green' | 'orange';

export function Stat({
  tone = 'plain',
  k,
  v,
  vStyle,
  d,
  dClass
}: {
  tone?: StatTone;
  k: ReactNode;
  v: ReactNode;
  vStyle?: CSSProperties;
  d?: ReactNode;
  /** 附加在 `.d` 上的 class（原型里偶有 `d tiny muted` 这样的组合） */
  dClass?: string;
}) {
  const cls = 'stat' + (tone === 'plain' ? '' : ' ' + tone);
  return (
    <div className={cls}>
      <span className="k">{k}</span>
      <span className="v" style={vStyle}>
        {v}
      </span>
      {d !== undefined ? <span className={'d' + (dClass ? ' ' + dClass : '')}>{d}</span> : null}
    </div>
  );
}

/* ---------------- 空态 ---------------- */

export function EmptyState({
  icon,
  title,
  desc,
  action
}: {
  icon: string;
  title: string;
  desc: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <b>{title}</b>
      <p>{desc}</p>
      {action}
    </div>
  );
}

export function EmptyBox({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <div className="empty" style={{ padding: '26px 16px', ...style }}>
      <p style={{ margin: 0 }}>{text}</p>
    </div>
  );
}

/* ---------------- 提示条 ---------------- */

export type NoteTone = 'plain' | 'warn' | 'err' | 'ok' | 'info';

export function Note({
  tone = 'plain',
  children,
  style
}: {
  tone?: NoteTone;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className={'note' + (tone === 'plain' ? '' : ' ' + tone)} style={style}>
      {children}
    </div>
  );
}

/* ---------------- 键值块 ---------------- */

export function KV({ rows, style }: { rows: Array<[ReactNode, ReactNode]>; style?: CSSProperties }) {
  return (
    <div className="kv" style={style}>
      {rows.map(([k, v], i) => (
        <Fragment2 key={i} k={k} v={v} />
      ))}
    </div>
  );
}

function Fragment2({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <>
      <span className="kk">{k}</span>
      <span className="vv">{v}</span>
    </>
  );
}

/* ---------------- 分段控件 / 标签页 ---------------- */

export function Seg<T extends string>({
  value,
  options,
  onChange,
  small,
  full,
  style
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
  small?: boolean;
  full?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={'seg' + (small ? ' sm' : '') + (full ? ' full' : '')} style={style}>
      {options.map(o => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="tabs">
      {options.map(o => (
        <button key={o.value} className={'tab ' + (value === o.value ? 'on' : '')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- 图例 ---------------- */

export function Legend({ items }: { items: ReadonlyArray<{ color: string; label: string }> }) {
  return (
    <div className="legend">
      {items.map(i => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
