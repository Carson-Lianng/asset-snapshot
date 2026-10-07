/**
 * CategoryMixPie.tsx —— 分类饼图 + 悬浮「该分类的币种构成」
 *
 * 首页「资产配置」与报表「资产配置 / 负债结构」三处共用（需求 #8 / #11 / #12）。
 * 与 CurrencyPie 的分工：
 *   · CurrencyPie    扇区 = **币种**，悬浮 = 该币种的明细（原币 / 折本位币 / 账户数）；
 *   · CategoryMixPie 扇区 = **分类**，悬浮 = 该分类**内部**的币种构成。
 *
 * 无数据时给提示，而不是留一张空白卡 —— 报表「负债结构」在只有资产、没有负债的账本上
 * 就会走到这一支（PieChart 在 rows 为空时返回 null，卡片会空着）。
 *
 * ⚠ 悬浮里「分类合计」的数值必须与扇区同源，因此直接取 `row.v`（就是从
 * `/reports/breakdown` 那一行来的值），而不是把币种明细再求和一遍 —— 后者在
 * 「分类下含不计入净资产的项」时会与扇区对不上。
 *
 * 2026-10-04 新增点选（需求 #4）：传 `onSelectRow` 后扇区可点（报表页用它下钻）。
 * 回调给的是**整行**（`CatMixRow`）而不是索引 —— 页面关心的是分类 key，
 * 索引是这一层的内部细节。`selectedKey` 反查回索引去加粗描边。
 * 不传 `onSelectRow` 时行为与此前完全一致（连 `onClick` 都不挂）。
 */
import type { Micro } from '@app/shared';
import { getBaseCurrency, money } from '../../lib/money.ts';
import { pickHex } from '../../lib/palette.ts';
import { EmptyBox } from '../Atoms.tsx';
import { PieWithLegend } from './PieChart.tsx';
import type { MixSide } from '../../lib/categoryMix.ts';

export interface CatMixRow {
  key: string;
  name: string;
  v: Micro;
}

export function CategoryMixPie({
  rows,
  mix,
  currencyName,
  side,
  size = 210,
  legendMinWidth = 220,
  centerText,
  chartAttrs,
  emptyText,
  onSelectRow,
  selectedKey = null
}: {
  rows: CatMixRow[];
  /** 分类 key → 币种 → 折本位币金额（微元）；由 `categoryCurrencyMix()` 产出 */
  mix: Map<string, Map<string, number>>;
  /** 币种代码 → 展示名（取自 `/reports/currency` 的行） */
  currencyName: Map<string, string>;
  side: MixSide;
  size?: number;
  legendMinWidth?: number;
  centerText?: { k: string; v: string };
  chartAttrs?: Record<string, string>;
  emptyText?: string;
  /** 点某一片（下钻）；不传则不可点 */
  onSelectRow?: (row: CatMixRow) => void;
  /** 当前下钻的分类 key；该片会加粗描边 */
  selectedKey?: string | null;
}) {
  const base = getBaseCurrency();

  if (!rows.length) {
    return <EmptyBox text={emptyText ?? `暂无可展示的${side === 'asset' ? '资产' : '负债'}分类`} />;
  }

  const pieRows = rows.map(r => ({ name: r.name, v: r.v }));
  const selIdx = selectedKey === null ? null : rows.findIndex(r => r.key === selectedKey);

  return (
    <PieWithLegend
      rows={pieRows}
      size={size}
      legendMinWidth={legendMinWidth}
      chartAttrs={chartAttrs}
      centerText={centerText}
      selected={selIdx !== null && selIdx >= 0 ? selIdx : null}
      onSelect={onSelectRow ? i => { const row = rows[i]; if (row) onSelectRow(row); } : undefined}
      tipFor={i => {
        const row = rows[i];
        if (!row) return null;
        const entries = [...(mix.get(row.key)?.entries() ?? [])].sort((a, b) => b[1] - a[1]);
        const sum = entries.reduce((s, [, v]) => s + v, 0) || 1;
        return (
          <>
            <div className="pt-hd">
              <b>{row.name}</b>
              <span>折 {base}</span>
            </div>
            {entries.length ? (
              <div className="pt-list">
                {entries.map(([code, v], k) => (
                  <div className="pt-li" key={code}>
                    <span className="pt-sw" style={{ background: pickHex(k) }} />
                    <span className="pt-nm">
                      {currencyName.get(code) ?? code} <span className="code">{code}</span>
                    </span>
                    <span className="pt-amt">{money(v, 0)}</span>
                    <span className="pt-sub">占该分类 {((v / sum) * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pt-empty">该分类暂无明细</div>
            )}
            <div className="pt-note">分类合计 {money(row.v, 0)}</div>
          </>
        );
      }}
    />
  );
}
