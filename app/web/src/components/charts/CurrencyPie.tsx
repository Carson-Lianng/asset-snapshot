/**
 * CurrencyPie.tsx —— 币种分布饼图（首页 #2 / 报表页 #3 共用）
 *
 * 口径：`/reports/currency` 的 `base` 是「资产 + 负债」的折本位币合计（见 domain
 * `currencyBreakdown`：两类都按正值累加）。原来的条形图用的就是这个口径，换成饼图
 * 不改变任何数值，只是换个表达。
 *
 * 悬浮明细（#8 的姊妹需求）给出该币种的原币金额、折本位币、占合计比例与账户数 ——
 * 条形图时代的这些信息散在主行与副行里，饼图放不下，改由悬浮承载。
 */
import type { CurrencyRowDTO } from '@app/shared';
import { getBaseCurrency, money, moneyAuto, wanText } from '../../lib/money.ts';
import { EmptyBox } from '../Atoms.tsx';
import { PieWithLegend } from './PieChart.tsx';

export function CurrencyPie({
  rows,
  size = 190,
  legendMinWidth = 180,
  chartAttrs
}: {
  rows: readonly CurrencyRowDTO[];
  size?: number;
  legendMinWidth?: number;
  chartAttrs?: Record<string, string>;
}) {
  const base = getBaseCurrency();
  const total = rows.reduce((s, r) => s + Math.abs(r.base), 0);

  if (!rows.length) return <EmptyBox text="暂无数据" />;

  const pieRows = rows.map(r => ({ name: `${r.name} · ${r.code}`, v: r.base }));

  return (
    <PieWithLegend
      rows={pieRows}
      size={size}
      legendMinWidth={legendMinWidth}
      chartAttrs={chartAttrs}
      centerText={{ k: `折 ${base}`, v: wanText(total, 1) + '万' }}
      tipFor={i => {
        const r = rows[i];
        if (!r) return null;
        return (
          <>
            <div className="pt-hd">
              <b>{r.name}</b>
              <span>{r.code}</span>
            </div>
            <div className="pt-kv">
              <span className="k">原币金额</span>
              <span className="v">{moneyAuto(r.orig, r.code)}</span>
            </div>
            <div className="pt-kv">
              <span className="k">折 {base}</span>
              <span className="v">
                {money(r.base, 0)}
                <small>占合计 {total > 0 ? ((Math.abs(r.base) / total) * 100).toFixed(1) : '—'}%</small>
              </span>
            </div>
            <div className="pt-note">{r.n} 个账户 · 资产与负债合计</div>
          </>
        );
      }}
    />
  );
}
