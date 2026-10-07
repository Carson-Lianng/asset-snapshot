/**
 * HomePage.tsx —— 首页（PRD §3.6）
 *
 * 数值来源与原型一致，但每一项都取自 Step 2 的对应端点：
 *   KPI 卡 / 较上期   ← /snapshots（冻结汇总列）+ /reports/trend（日序列的相邻两点）
 *   净资产趋势        ← /reports/trend?metric=net_worth&mode=origin
 *   资产配置（环形）  ← /reports/breakdown?dim=category（明细另取 /snapshots/:id 算币种构成）
 *   理财收益摘要      ← /reports/returns
 *   平台分布 / 币种分布 ← /reports/platform-currency · /reports/currency
 *   最近快照表        ← /snapshots
 *
 * 2026-10-04 界面调整（原型退役后，不再受「逐像素对齐原型」约束）：
 *   #1  净资产趋势与资产配置改为**等高**（去掉 grid 的 align-items:start）
 *   #2  币种分布由条形改为**饼图**，并与平台分布**并列**（不再各占一整行）
 *   #7  理财收益摘要由键值列表改为**卡片**（.stat-grid）
 *   #8/#11 资产配置饼图悬浮扇区可看到**该分类的币种构成**
 *   另：净资产趋势在只有 1 期数据时也渲染（只有一个点时标数值）
 *
 * 2026-10-04 第二批界面需求：
 *   #3  币种分布**内容居中 + 饼图放大**（它与平台分布等高，而它的内容比平台分布矮
 *       一大截，原先全部余量都堆在卡片底部，看起来像「留白太多」）
 *   #5  理财收益摘要**去掉「本期收益」**（只剩总本金 / 总市值 / 累计收益 / 累计收益率）
 */
import { useMemo } from 'react';
import type {
  BreakdownDTO,
  CurrencyRowDTO,
  PlatformCurrencyRowDTO,
  ReturnsPanelDTO,
  SnapshotDTO,
  SnapshotSummaryDTO,
  TrendDTO
} from '@app/shared';
import { ep, useApi } from '../../api/index.ts';
import {
  daysBetween,
  getBaseCurrency,
  money,
  pctText,
  todayISO,
  toYuan,
  wanText
} from '../../lib/money.ts';
import { dailySeries, lastSnapshot, snapsDesc } from '../../lib/series.ts';
import { categoryCurrencyMix } from '../../lib/categoryMix.ts';
import { returnsCompare, returnsCompareHint } from '../../lib/returnsCompare.ts';
import { CardHd, EmptyState, Note, SecTitle, Stat } from '../../components/Atoms.tsx';
import { Delta, Pct, PrevCompare } from '../../components/Delta.tsx';
import { PlatformBars } from '../../components/Bars.tsx';
import { ChartBox } from '../../components/charts/ChartBox.tsx';
import { CategoryMixPie } from '../../components/charts/CategoryMixPie.tsx';
import { LineChart } from '../../components/charts/LineChart.tsx';
import { CurrencyPie } from '../../components/charts/CurrencyPie.tsx';
import type { View } from '../../router.ts';

export function HomePage({
  snapshotList,
  onNavigate,
  onStartInventory,
  onOpenSnapshot
}: {
  snapshotList: readonly SnapshotSummaryDTO[];
  onNavigate: (view: View) => void;
  onStartInventory: () => void;
  onOpenSnapshot: (id: string) => void;
}) {
  const last = lastSnapshot(snapshotList);
  const lastId = last?.id ?? null;

  /* 前一期（同日折叠口径）。**必须算在这里** —— 下面 `if (!last) return …` 之后
     再加 Hook 就会破坏调用顺序。它同时供两处用：总资产/总负债的环比，以及
     #6 那两张理财卡的环比（后者要拿 `prevId` 去取上一期的收益面板）。 */
  const daily = dailySeries(snapshotList);
  const prevId = daily.length >= 2 ? daily[daily.length - 2].id : null;

  const trend = useApi<TrendDTO>(lastId ? ep.trend('net_worth', 'origin') : null);
  const returns = useApi<ReturnsPanelDTO>(lastId ? ep.returns(lastId) : null);
  const prevReturns = useApi<ReturnsPanelDTO>(prevId ? ep.returns(prevId) : null);
  const platCur = useApi<{ rows: PlatformCurrencyRowDTO[] }>(lastId ? ep.platformCurrency(lastId, 'origin') : null);
  const currency = useApi<{ rows: CurrencyRowDTO[] }>(lastId ? ep.currency(lastId, 'origin') : null);
  const breakdown = useApi<BreakdownDTO>(lastId ? ep.breakdown(lastId, 'category', 'origin') : null);
  /* 资产配置饼图的悬浮明细要「该分类的币种构成」—— 现有端点里没有这个组合，
     而明细本来就随快照一起返回，所以直接取最新一期在**前端**按分类 × 币种聚合。 */
  const detail = useApi<SnapshotDTO>(lastId ? ep.snapshot(lastId, 'origin') : null);

  /**
   * 分类 → 币种 → 折本位币金额（微元）—— 资产配置饼图的悬浮明细。
   * 聚合口径（只纳入净值项 / 只算资产项 / 分类 key 与 breakdown 逐字相同）
   * 统一收在 `lib/categoryMix.ts` 里，与报表页共用同一份实现。
   */
  const catMix = useMemo(() => categoryCurrencyMix(detail.data?.items, 'asset'), [detail.data]);

  const curName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of currency.data?.rows ?? []) m.set(r.code, r.name);
    return m;
  }, [currency.data]);

  if (!last) {
    return (
      <div className="card">
        <EmptyState
          icon="◧"
          title="还没有任何盘点记录"
          desc="建立账户后开始第一次盘点，即可看到你的净资产。"
          action={
            <button className="btn pri" onClick={onStartInventory}>
              开始盘点
            </button>
          }
        />
      </div>
    );
  }

  const base = getBaseCurrency();
  const points = trend.data?.points ?? [];
  const lastPoint = points.length ? points[points.length - 1] : null;
  const prevPoint = points.length >= 2 ? points[points.length - 2] : null;

  const prev = daily.length >= 2 ? daily[daily.length - 2] : null;
  const gap = daysBetween(last.date, todayISO());

  const dNw =
    lastPoint?.net_worth !== null && lastPoint?.net_worth !== undefined && prevPoint?.net_worth !== null && prevPoint?.net_worth !== undefined
      ? lastPoint.net_worth - prevPoint.net_worth
      : null;
  const dNwRate = dNw !== null && prevPoint?.net_worth ? dNw / Math.abs(prevPoint.net_worth) : null;
  const dTa = prev ? last.total_assets - prev.total_assets : null;
  const dTl = prev ? last.total_liabilities - prev.total_liabilities : null;

  const rp = returns.data;
  /* #6：总本金 / 总市值的环比（累计收益的环比恒等于已删除的「本期收益」，故不加 —— 见 lib/returnsCompare.ts） */
  const rCmp = returnsCompare(rp, prevReturns.data);
  const trendPoints = points.slice(-8).map(p => ({ x: p.date, y: toYuan(p.net_worth) }));

  const catRows = (breakdown.data?.rows ?? [])
    .filter(r => r.asset > 0)
    .slice(0, 6)
    .map(r => ({ key: r.key, name: r.name, v: r.asset }));

  const showReturns = rp ? rp.count + rp.first + rp.missing_base + rp.no_principal > 0 : false;

  return (
    <>
      {gap <= 0 ? (
        <Note tone="ok" style={{ marginBottom: 16 }}>
          <b>今天已盘点。</b>数据是最新的。
        </Note>
      ) : (
        <Note tone={gap > 45 ? 'warn' : 'plain'} style={{ marginBottom: 16 }}>
          距上次盘点 <b className="mono">{gap}</b> 天（{last.date}）。
          {gap > 45 ? ' 超过 45 天未盘点，建议更新一次。' : ''}
          <button className="btn sm" style={{ marginLeft: 10 }} onClick={onStartInventory}>
            现在盘点
          </button>
        </Note>
      )}

      <div className="stat-grid" style={{ gridTemplateColumns: '1.7fr 1fr 1fr', marginBottom: 16 }}>
        <Stat
          tone="hero"
          k={`当前净资产 · ${base}`}
          v={money(last.net_worth)}
          d={
            prev ? (
              <>
                {'较上期 '}
                <Delta v={dNw} dec={0} />
                {`（${pctText(dNwRate)}）`}
              </>
            ) : (
              <span className="flat">首次快照，无可比期</span>
            )
          }
        />
        <Stat
          tone="blue"
          k="总资产"
          v={money(last.total_assets, 0)}
          d={dTa !== null ? (
            <>
              <Delta v={dTa} dec={0} />
              {' 较上期'}
            </>
          ) : (
            <span className="flat">—</span>
          )}
        />
        <Stat
          tone="pink"
          k="总负债"
          v={money(last.total_liabilities, 0)}
          d={dTl !== null ? (
            <>
              <Delta v={dTl} dec={0} />
              {' 较上期'}
            </>
          ) : (
            <span className="flat">—</span>
          )}
        />
      </div>

      {/* #1：两块卡等高 —— grid2 默认 align-items:stretch，这里**不能**再写 align-items:start。
          2026-10-07 屏幕适配：两卡都改 `.card.eq`（auto 1fr）——
          · 左卡图表不再写死 height=230，而是 fillHeight 撑满「等高后分到的剩余空间」；
            窄视口下右卡图例换到饼图下方、把卡撑高时，趋势图跟着变高，卡底不再拖空白。
            显式 minHeight:220 有双重作用：防压扁 + 把 1fr 的 auto 最小尺寸换成定值
            （否则视口变宽后行高会被上一次的内容高度顶住，空白收不回来）。
          · 右卡正文包 `.eq-mid` 垂直居中（与报表页同一套等高语言）。 */}
      <div className="grid2" style={{ gridTemplateColumns: '1.35fr 1fr' }}>
        <div className="card eq">
          <CardHd
            title="净资产趋势"
            sub={`近 ${trendPoints.length} 期 · 每日取最后一张`}
            right={
              <button className="btn sm" onClick={() => onNavigate('reports')}>
                完整报表
              </button>
            }
          />
          <ChartBox className="chartbox" dataChart="home-trend" fillHeight style={{ minHeight: 220 }}>
            {(w, h) =>
              trendPoints.length >= 1 ? (
                <LineChart
                  w={w}
                  series={[
                    {
                      data: trendPoints,
                      color: '#FFE500',
                      area: true,
                      inner: true,
                      /* 期数很少时线本身说明不了什么，把数值标出来；
                         期数多了标值会互相压字，就交回给线形表达。 */
                      valueLabels: trendPoints.length <= 2
                    }
                  ]}
                  height={h}
                />
              ) : null
            }
          </ChartBox>
        </div>
        <div className="card eq">
          <CardHd title="资产配置" sub={`按分类 · ${last.date} · 悬浮查看币种构成`} />
          {/* #8 / #11：与报表页共用同一个组件，避免两处各写一遍悬浮明细。
              `.home-pie`：卡宽不足以「饼图+图例」并排时（图例换到下一行），
              把孤行上的饼图水平居中，别贴着左边留一整条空白（见 mount.css）。 */}
          <div className="eq-mid">
            <div className="home-pie">
              <CategoryMixPie
                rows={catRows}
                mix={catMix}
                currencyName={curName}
                side="asset"
                size={210}
                chartAttrs={{ 'data-chart': 'home-pie' }}
                centerText={{ k: '总资产', v: wanText(last.total_assets, 1) + '万' }}
              />
            </div>
          </div>
        </div>
      </div>

      <div>
        {showReturns && rp ? (
          <div className="card">
            <CardHd title="理财收益摘要" sub="仅跟踪本金的账户" />
            {/* #7：由键值列表改为卡片。#5：去掉「本期收益」一卡（累计口径不受影响） */}
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
              <Stat
                tone="plain"
                k="总本金"
                v={money(rp.principal, 0)}
                vStyle={{ fontSize: 20 }}
                d={<PrevCompare diff={rCmp?.principal ?? null} noPrev={prevId === null} />}
              />
              <Stat
                tone="blue"
                k="总市值"
                v={money(rp.market, 0)}
                vStyle={{ fontSize: 20 }}
                d={<PrevCompare diff={rCmp?.market ?? null} noPrev={prevId === null} />}
              />
              <Stat
                tone="green"
                k="累计收益"
                v={money(rp.cum, 0)}
                vStyle={{ fontSize: 20 }}
                d={<Pct v={rp.cum_rate} />}
              />
              <Stat tone="plain" k="累计收益率" v={pctText(rp.cum_rate)} vStyle={{ fontSize: 20 }} />
            </div>
            <div className="flex between" style={{ marginTop: 12 }}>
              <span className="panel-hint">累计收益不影响净资产口径</span>
              <button className="btn sm" onClick={() => onNavigate('reports')}>
                明细
              </button>
            </div>
            {/* #6：环比的口径小字（与快照详情、报表理财 tab 共用同一句，见 lib/returnsCompare.ts） */}
            <div className="panel-hint" style={{ marginTop: 6 }}>{returnsCompareHint(rp.count)}</div>
            {/* #5：面板里只剩「累计」口径，因此这里只再提醒真正被排除在外的那些账户
                （未填本金 = 连累计都算不了）。「首期 / 基准缺失」两类自 PRD v1.3 起
                **照常计入累计**，不再属于「未纳入统计」。 */}
            {rp.no_principal > 0 ? (
              <Note tone="warn" style={{ margin: '12px 0 0', fontSize: 11 }}>
                {`未填本金 ${rp.no_principal} 个账户未计入收益统计`}
              </Note>
            ) : null}
          </div>
        ) : null}

        {/* #2：币种分布改为饼图，并与平台分布并列。#3：两者等高，而币种分布的内容更矮，
            故用 .card.eq + .eq-mid 把内容在卡内垂直居中，避免余量全堆在底部。 */}
        <div className="grid2" style={{ gridTemplateColumns: '1.15fr 1fr', marginBottom: 16 }}>
          <div className="card" style={{ marginBottom: 0 }}>
            <CardHd title="平台分布" sub={`资产+负债 · 折 ${base} · 悬浮查看币种构成`} />
            <PlatformBars rows={platCur.data?.rows ?? []} />
          </div>
          <div className="card eq" style={{ marginBottom: 0 }}>
            <CardHd title="币种分布" sub={`折 ${base} · 悬浮查看币种明细`} />
            <div className="eq-mid">
              <CurrencyPie rows={currency.data?.rows ?? []} size={236} legendMinWidth={190} />
            </div>
          </div>
        </div>
      </div>

      <SecTitle>最近快照</SecTitle>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>日期</th>
              <th>备注</th>
              <th className="num">总资产</th>
              <th className="num">总负债</th>
              <th className="num">净资产</th>
              <th className="num">较上期</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snapsDesc(snapshotList)
              .slice(0, 5)
              .map(s => {
                const idx = daily.findIndex(d => d.id === s.id);
                const p = idx > 0 ? daily[idx - 1] : null;
                const d = p ? s.net_worth - p.net_worth : null;
                const isDup = snapshotList.filter(x => x.date === s.date).length > 1;
                return (
                  <tr key={s.id}>
                    <td className="mono bold">
                      {s.date}
                      {isDup ? (
                        <>
                          {' '}
                          <span className="badge dup">同日多张</span>
                        </>
                      ) : null}
                    </td>
                    <td>{s.note || '—'}</td>
                    <td className="num">{money(s.total_assets, 0)}</td>
                    <td className="num">{money(s.total_liabilities, 0)}</td>
                    <td className="num bold">{money(s.net_worth, 0)}</td>
                    <td className="num">{d !== null ? <Delta v={d} dec={0} /> : <span className="flat">—</span>}</td>
                    <td className="num">
                      <button className="btn xs" onClick={() => onOpenSnapshot(s.id)}>
                        详情
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </>
  );
}
