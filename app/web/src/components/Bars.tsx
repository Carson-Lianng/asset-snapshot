/**
 * Bars.tsx —— 横向条形 / 币种堆叠 / 悬浮明细
 *
 * 对应原型的 barListHTML / platformBarsHTML+platPopHTML / currencyBarsHTML。
 * 悬浮明细面板（.pb-pop）与原型的做法一致：**始终在 DOM 里**，靠行的 :hover 控制显隐，
 * 因此不存在「截图时刚好没悬停」这类时序问题。
 */
import type { CurrencyRowDTO, Micro, PlatformCurrencyRowDTO } from '@app/shared';
import { getBaseCurrency, money, moneyAuto, toYuan } from '../lib/money.ts';
import { currencyColorMap, pickColor, pickHex } from '../lib/palette.ts';
import { EmptyBox } from './Atoms.tsx';

/* ============================================================
   通用条形列表（原 barListHTML）
   ============================================================ */

export interface BarRow {
  name: string;
  v: Micro;
}

export function BarList({ rows, color, emptyText }: { rows: BarRow[]; color?: string; emptyText?: string }) {
  if (!rows.length) return <EmptyBox text={emptyText ?? '暂无数据'} />;
  const base = Math.abs(toYuan(rows[0].v)) || 1;
  return (
    <>
      {rows.map((x, i) => {
        const w = (Math.abs(toYuan(x.v)) / base) * 100;
        return (
          <div className="bar-row" key={x.name + i}>
            <div className="bar-name" title={x.name}>
              {x.name}
            </div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: Math.max(w, 1.5).toFixed(1) + '%', background: color || pickColor(i) }}
              />
            </div>
            <div className="bar-val">{money(x.v, 0)}</div>
          </div>
        );
      })}
    </>
  );
}

/* ============================================================
   平台分布：币种堆叠条 + 悬浮币种明细（右侧指标仍为本位币）
   ============================================================ */

export function PlatformBars({ rows, emptyText }: { rows: PlatformCurrencyRowDTO[]; emptyText?: string }) {
  if (!rows.length) return <EmptyBox text={emptyText ?? '暂无数据'} />;

  const cmap = currencyColorMap(rows);
  const max = Math.max(...rows.map(r => toYuan(r.total)), 1);

  return (
    <>
      {rows.map(r => (
        <div className="plrow" key={r.key}>
          <div className="pl-name" title={r.name}>
            {r.name}
            {r.currencies > 1 ? <span className="pl-tag">{r.currencies} 币种</span> : null}
          </div>
          <div className="pl-track">
            {r.by_currency.map(c => (
              <i
                key={c.code}
                style={{
                  width: Math.max(((toYuan(c.asset) + toYuan(c.liability)) / max) * 100, 0.5).toFixed(2) + '%',
                  background: pickHex(cmap[c.code])
                }}
              />
            ))}
          </div>
          <div className="pl-val">{money(r.total, 0)}</div>
          <PlatformPopup row={r} cmap={cmap} />
        </div>
      ))}
      {Object.keys(cmap).length > 1 ? (
        <div className="pl-legend">
          <span className="pl-lg-t">币种图例</span>
          {Object.keys(cmap)
            .sort((a, b) => cmap[a] - cmap[b])
            .map(code => (
              <span key={code}>
                <i style={{ background: pickHex(cmap[code]) }} />
                {code}
              </span>
            ))}
        </div>
      ) : null}
    </>
  );
}

function PlatformPopup({ row, cmap }: { row: PlatformCurrencyRowDTO; cmap: Record<string, number> }) {
  const totalYuan = toYuan(row.total) || 1;
  const runTotal = toYuan(row.total);
  return (
    <div className="pb-pop">
      <div className="pb-hd">
        <b>{row.name}</b>
        <span>
          {row.currencies} 个币种 · {row.accounts} 个账户
        </span>
      </div>
      <div className="pb-stack">
        {row.by_currency.map(c => (
          <i
            key={c.code}
            style={{
              width: (((toYuan(c.asset) + toYuan(c.liability)) / totalYuan) * 100).toFixed(2) + '%',
              background: pickHex(cmap[c.code])
            }}
          />
        ))}
      </div>
      <div className="pb-list">
        {row.by_currency.map(c => (
          <div className="pb-li" key={c.code}>
            <span className="pb-sw" style={{ background: pickHex(cmap[c.code]) }} />
            <span className="pb-cur">
              <b>{c.name}</b>
              <span className="code">{c.code}</span>
              {c.n > 1 ? <span className="code">{c.n} 个账户</span> : null}
            </span>
            <span className="pb-amt">{money(c.orig, 2, c.code)}</span>
            <span className="pb-sub">
              折 {money(c.base, 0)} · 占该平台 {((toYuan(c.base) / runTotal) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      <div className="pb-ft">
        <span>折 {getBaseCurrency()} 合计</span>
        <b>{money(row.total, 0)}</b>
      </div>
      <div className="pb-fx">
        资产 {money(row.asset, 0)} · 负债 {money(row.liability, 0)}
      </div>
    </div>
  );
}

/* ============================================================
   币种分布：主指标为原币（带该币种符号），副行为折本位币
   ============================================================ */

export function CurrencyBars({ rows }: { rows: CurrencyRowDTO[] }) {
  if (!rows.length) return <EmptyBox text="暂无数据" />;
  const max = Math.max(...rows.map(r => Math.abs(toYuan(r.base))), 1);
  const sum = rows.reduce((s, r) => s + Math.abs(toYuan(r.base)), 0) || 1;

  return (
    <>
      {rows.map((r, i) => {
        const w = Math.max((Math.abs(toYuan(r.base)) / max) * 100, 1.5);
        return (
          <div className="curow" key={r.code}>
            <div className="pl-name">
              <span
                style={{
                  display: 'inline-block',
                  width: 11,
                  height: 11,
                  border: '2px solid var(--ink)',
                  flex: '0 0 11px',
                  background: pickColor(i)
                }}
              />
              {r.name}
            </div>
            <div className="cu-track">
              <i style={{ width: w.toFixed(1) + '%', background: pickColor(i) }} />
            </div>
            <div className="cu-val">
              <b>{moneyAuto(r.orig, r.code)}</b>
              <span>
                折 {money(r.base, 0)} · {((Math.abs(toYuan(r.base)) / sum) * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
