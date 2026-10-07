/**
 * ReportsPage.tsx —— 报表页（PRD §3.5.2 §3.4.4）
 *
 * 对应原型的 `renderReports` + `baseChangeMarkers`。
 *
 * 趋势序列不再由前端自己算 —— 原型的写法是「dailySeries() 里逐张调用
 * snapTotalsIn(s, mode)」，这要求把全部快照的明细都拉到前端。`/reports/trend`
 * 在服务端做的就是同一件事（`dailySeries` + `snapTotalsIn`），一次请求就能拿到
 * 三条线所需的全部数值点，并且顺带返回本位币变更分隔点。
 *
 * 收益趋势同理：`/reports/returns-trend` 一次返回**全部快照**的收益面板，
 * 因此「净资产趋势」与「收益趋势」是两次请求，不随期数增长。
 *
 * 2026-10-04 第二批界面需求：#5 理财侧一律不再出现「本期收益」——
 *   去掉收益趋势里的那条线（连带图例与副标题）、汇总表的那一列，指标卡 4 → 3。
 *   累计口径不受影响；`per` / `per_status` 仍在 DTO 里（领域层与接口契约没动），只是不再展示。
 *
 * 2026-10-04 第三批：
 *   #6 理财 tab 的「总本金 / 总市值」加环比（口径与实现见 lib/returnsCompare.ts）。
 *   #4 「维度分布」支持按分类下钻：点资产配置 / 负债结构的扇区，下方三个分布
 *      （平台 / 币种 / 标签）就只统计该分类内的项，再点同一片或点「← 返回整体」恢复。
 *      下钻是**纯前端收窄 + 调用领域层同一份聚合函数**（见 lib/drill.ts），
 *      服务端一行未改；界面只在「已下钻」时多出一段面包屑与一个返回按钮，
 *      整体视图（= Step 3 基准图的 `10-reports`）里这些节点不存在。
 */
import { Fragment, useMemo } from 'react';
import type {
  BreakdownDTO,
  CurrencyRowDTO,
  PlatformCurrencyRowDTO,
  ReturnsBreakdownDTO,
  ReturnsPanelDTO,
  ReturnsTrendDTO,
  SnapshotDTO,
  SnapshotSummaryDTO,
  TrendDTO
} from '@app/shared';
import { makeFxContext } from '@app/domain';
import { ep, useApi } from '../../api/index.ts';
import { dtoSnapshotToDomain } from '../../lib/adapt.ts';
import { getBaseCurrency, money, pctText, toYuan, wanText } from '../../lib/money.ts';
import { categoryCurrencyMix, type MixSide } from '../../lib/categoryMix.ts';
import { currencyMetaOf, drillBreakdowns } from '../../lib/drill.ts';
import { dailySeries, lastSnapshot } from '../../lib/series.ts';
import { returnsCompare, returnsCompareHint } from '../../lib/returnsCompare.ts';
import { DIMS, useUi, type RepTab } from '../../state/ui.tsx';
import { CardHd, EmptyBox, EmptyState, Legend, Note, SecTitle, Stat, Tabs } from '../../components/Atoms.tsx';
import { Delta, Pct, PrevCompare } from '../../components/Delta.tsx';
import { BarList, PlatformBars } from '../../components/Bars.tsx';
import { ChartBox } from '../../components/charts/ChartBox.tsx';
import { CategoryMixPie, type CatMixRow } from '../../components/charts/CategoryMixPie.tsx';
import { LineChart, type BaseChangeMarker } from '../../components/charts/LineChart.tsx';
import { CurrencyPie } from '../../components/charts/CurrencyPie.tsx';

const RET_DIMS = ['account', 'platform', 'category', 'currency'] as const;

/** 下钻面包屑上要显示的名字（饼图卡片自己的标题） */
const SIDE_LABEL: Record<MixSide, string> = { asset: '资产配置', liability: '负债结构' };

/** 报表页的两个 tab（需求 #5） */
const REP_TABS: ReadonlyArray<{ value: RepTab; label: string }> = [
  { value: 'asset', label: '资产' },
  { value: 'wealth', label: '理财' }
];

export function ReportsPage({
  snapshotList,
  onStartInventory
}: {
  snapshotList: readonly SnapshotSummaryDTO[];
  onStartInventory: () => void;
}) {
  const { ui, patch } = useUi();
  const base = getBaseCurrency();
  const ds = dailySeries(snapshotList);
  const last = lastSnapshot(snapshotList);
  const lastId = last?.id ?? null;

  const trendMode = ui.repTrendMode;
  const rbDim = ui.repRetDim;
  const tab = ui.repTab;

  /* 三条线的数值点来自同一个响应：metric 不影响返回的字段，三种指标总是齐全 */
  const trend = useApi<TrendDTO>(lastId ? ep.trend('net_worth', trendMode) : null);
  const retTrend = useApi<ReturnsTrendDTO>(ep.returnsTrend());
  const catBd = useApi<BreakdownDTO>(lastId ? ep.breakdown(lastId, 'category', 'origin') : null);
  const tagBd = useApi<BreakdownDTO>(lastId ? ep.breakdown(lastId, 'tag', 'origin') : null);
  const platCur = useApi<{ rows: PlatformCurrencyRowDTO[] }>(
    lastId ? ep.platformCurrency(lastId, 'origin') : null
  );
  const currency = useApi<{ rows: CurrencyRowDTO[] }>(lastId ? ep.currency(lastId, 'origin') : null);
  /* #12：资产配置 / 负债结构的悬浮要显示「该分类的币种构成」—— 没有现成端点，
     明细随快照一起返回，所以在**前端**按分类 × 币种聚合（口径对齐见 lib/categoryMix.ts）。 */
  const detail = useApi<SnapshotDTO>(lastId ? ep.snapshot(lastId, 'origin') : null);
  const panel = useApi<ReturnsPanelDTO>(lastId ? ep.returns(lastId) : null);
  /* #6：本 tab 的收益汇总是**最新一期**的，所以「前一期」就是同日折叠序列里的前一张
     （与首页、快照详情同一个口径）。取数这一句必须在下面 `if (!ds.length || !lastId) return`
     之前 —— 它就是上面那句话说的「Hooks 的调用顺序不能变」的又一处。 */
  const prevId = ds.length >= 2 ? ds[ds.length - 2].id : null;
  const prevPanel = useApi<ReturnsPanelDTO>(prevId ? ep.returns(prevId) : null);
  const rb = useApi<ReturnsBreakdownDTO>(lastId ? ep.returnsBreakdown(lastId, rbDim) : null);

  /* 分类 × 币种（资产侧 / 负债侧各一份）与币种展示名 —— 供两个分类饼图的悬浮用。
     必须放在下面的提前返回之前（Hooks 的调用顺序不能变）。 */
  const catMix = useMemo(() => categoryCurrencyMix(detail.data?.items, 'asset'), [detail.data]);
  const liabMix = useMemo(() => categoryCurrencyMix(detail.data?.items, 'liability'), [detail.data]);
  const curName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of currency.data?.rows ?? []) m.set(r.code, r.name);
    return m;
  }, [currency.data]);

  /* #4：下钻范围（`ui.repDrill`）与「收窄后的三个分布」。同样必须在这里算 ——
     下面有提前返回。`drillBreakdowns` 收窄的是**明细**，再调领域层同一份聚合函数，
     所以下钻看到的口径与整体视图是同一份代码的产物（理由见 lib/drill.ts）。
     币种展示名的原料取整体视图那一次 `/reports/currency`（子集必是其子集）。 */
  const drill = ui.repDrill;
  const subBd = useMemo(
    () =>
      drill && detail.data
        ? drillBreakdowns(
            dtoSnapshotToDomain(detail.data),
            drill,
            'origin',
            makeFxContext(base, []),
            currencyMetaOf(currency.data?.rows ?? [])
          )
        : null,
    [drill, detail.data, currency.data, base]
  );

  if (!ds.length || !lastId) {
    return (
      <div className="card">
        <EmptyState
          icon="◪"
          title="还没有数据可分析"
          desc="至少完成一次盘点后，报表页才会展示趋势与结构分布。"
          action={
            <button className="btn pri" onClick={onStartInventory}>
              开始盘点
            </button>
          }
        />
      </div>
    );
  }

  const crossCur = ds.some(s => s.base_currency !== base);

  /* #4：点扇区下钻 / 再点同一片恢复。
     判「同一片」要**同时**看侧与 key —— 资产配置与负债结构是两张饼、各自有分类 key，
     只比 key 的话「资产侧的 XX」会把「负债侧的 XX」当成同一项而错判为取消。 */
  const toggleDrill = (row: CatMixRow, side: MixSide) => {
    if (drill && drill.side === side && drill.key === row.key) patch({ repDrill: null });
    else patch({ repDrill: { side, key: row.key, name: row.name } });
  };

  /* 下钻后卡片副标题 / 空态要写明范围 —— 否则「平台只剩一个」看起来像数据丢了。 */
  const scoped = (plain: string) => (drill ? `${plain} · 仅「${drill.name}」分类` : plain);

  /* 趋势点：与原型一致取最后 12 个点 */
  const points = (trend.data?.points ?? []).slice(-12);
  const nwSeries = points.map(p => ({ x: p.date, y: p.net_worth === null ? 0 : toYuan(p.net_worth) }));
  const taSeries = points.map(p => ({ x: p.date, y: p.total_assets === null ? 0 : toYuan(p.total_assets) }));
  const tlSeries = points.map(p => ({ x: p.date, y: p.total_liabilities === null ? 0 : toYuan(p.total_liabilities) }));

  const markers: BaseChangeMarker[] = (trend.data?.base_changes ?? [])
    .map(h => {
      const d = h.changed_at.slice(0, 10);
      const idx = nwSeries.findIndex(p => p.x >= d);
      return idx >= 0 ? { index: idx, from: h.from_currency, to: h.to_currency } : null;
    })
    .filter((m): m is BaseChangeMarker => m !== null);

  const retBySnap = new Map((retTrend.data?.points ?? []).map(p => [p.snapshot_id, p]));
  const retSeries = ds.slice(-12).map(s => {
    const p = retBySnap.get(s.id);
    return { x: s.date, y: p ? toYuan(p.cum) : 0 };
  });

  /* 分类饼图的扇区值：资产配置取 `asset`、负债结构取 `liability`。
     保留 `key` 是为了悬浮时能回查该分类的币种构成。 */
  const catRows = (catBd.data?.rows ?? [])
    .filter(g => g.asset > 0)
    .map(g => ({ key: g.key, name: g.name, v: g.asset }));
  const liabRows = (catBd.data?.rows ?? [])
    .filter(g => g.liability > 0)
    .map(g => ({ key: g.key, name: g.name, v: g.liability }));
  const tagRows = (tagBd.data?.rows ?? []).map(g => ({ name: g.name, v: g.asset + g.liability }));

  const catTotal = catRows.reduce((s, x) => s + x.v, 0);
  const liabTotal = liabRows.reduce((s, x) => s + x.v, 0);

  const rp = panel.data;
  /* #6：总本金 / 总市值的环比（累计收益的环比恒等于已删除的「本期收益」，故不加 —— 见 lib/returnsCompare.ts） */
  const rCmp = returnsCompare(rp, prevPanel.data);
  const rbRows = rb.data?.rows ?? [];

  /* #5：报表拆成「资产」与「理财」两个 tab。
     两块内容各自先成一个片段，再按 tab 二选一渲染 —— 这样两块内部的缩进与拆分前
     完全一致，改动面最小；也避免把两百多行 JSX 再包一层导致整体重排缩进。 */
  const assetTab = (
    <>
      {crossCur ? (
        <Note tone="warn">
          检测到本位币变更历史。趋势图默认<b>按原口径分段</b>展示并在变更处加分隔标记，可切换为统一折算视图。
          <div className="seg sm" style={{ marginTop: 9 }}>
            <button
              className={trendMode === 'origin' ? 'on' : ''}
              onClick={() => patch({ repTrendMode: 'origin' })}
            >
              原口径分段
            </button>
            <button
              className={trendMode === 'current' ? 'on' : ''}
              onClick={() => patch({ repTrendMode: 'current' })}
            >
              {`统一按 ${base} 折算`}
            </button>
          </div>
        </Note>
      ) : null}

      <SecTitle first>净资产趋势</SecTitle>
      <div className="card">
        <CardHd
          title="净资产 / 总资产 / 总负债"
          sub="每日取当日最后一张快照"
          right={
            <Legend
              items={[
                { color: 'var(--yellow)', label: '净资产' },
                { color: 'var(--blue)', label: '总资产' },
                { color: 'var(--pink)', label: '总负债' }
              ]}
            />
          }
        />
        <ChartBox className="chartbox" dataChart="rep-trend">
          {w =>
            /* #6：只有 1 个点也要渲染（原先 < 2 就直接空白，用户的账本恰好只有一期） */
            points.length >= 1 ? (
              <LineChart
                w={w}
                height={300}
                series={[
                  { data: taSeries, color: '#7CC6FF' },
                  { data: tlSeries, color: '#FF9BD2' },
                  /* #6：数值标在「净资产」这一条上 —— 三条都标会互相压字。
                     这条也正是图的主题（面积填充 + 内描边）那一条。 */
                  { data: nwSeries, color: '#FFE500', area: true, inner: true, valueLabels: true }
                ]}
                markers={trendMode === 'origin' ? markers : []}
              />
            ) : null
          }
        </ChartBox>
        {markers.length ? (
          <Note tone="warn" style={{ marginTop: 12 }}>
            {`红色虚线为本位币变更分隔点（${markers.map(m => `${m.from}→${m.to}`).join('、')}），两侧数值不同口径，不可直接连线比较。`}
          </Note>
        ) : null}
      </div>

      {/* #12：资产配置与负债结构**等高**（去掉 align-items:start，让 grid 默认的
          stretch 生效），两张卡内部再加一层 `.eq-mid` 让正文垂直居中。
          负债结构在本期没有任何负债时不再留白，而是给出提示（CategoryMixPie 的空态）。
          #4：两张饼的扇区可点 —— 点一下就把下面的「维度分布」收窄到该分类。 */}
      <div className="grid2">
        <div className="card eq">
          <CardHd
            title="资产配置"
            sub={`按分类 · ${last!.date} · 点扇区下钻 · 悬浮看币种构成`}
          />
          <div className="eq-mid">
            <CategoryMixPie
              rows={catRows}
              mix={catMix}
              currencyName={curName}
              side="asset"
              size={200}
              legendMinWidth={220}
              chartAttrs={{ 'data-chart': 'rep-asset-pie' }}
              centerText={{ k: '总资产', v: wanText(catTotal, 1) + '万' }}
              emptyText="本期没有可计入净资产的资产项。"
              onSelectRow={row => toggleDrill(row, 'asset')}
              selectedKey={drill?.side === 'asset' ? drill.key : null}
            />
          </div>
        </div>
        <div className="card eq">
          <CardHd
            title="负债结构"
            sub={`按分类 · ${last!.date} · 点扇区下钻 · 悬浮看币种构成`}
          />
          <div className="eq-mid">
            <CategoryMixPie
              rows={liabRows}
              mix={liabMix}
              currencyName={curName}
              side="liability"
              size={200}
              legendMinWidth={220}
              chartAttrs={{ 'data-chart': 'rep-liab-pie' }}
              centerText={{ k: '总负债', v: wanText(liabTotal, 1) + '万' }}
              emptyText="本期没有负债，无需偿还。记过房贷 / 信用卡等负债账户后这里会有结构分布。"
              onSelectRow={row => toggleDrill(row, 'liability')}
              selectedKey={drill?.side === 'liability' ? drill.key : null}
            />
          </div>
        </div>
      </div>

      <SecTitle>
        维度分布
        {drill ? (
          <>
            <span className="spacer" />
            <span className="drill-crumb">
              {`${SIDE_LABEL[drill.side]} · ${drill.name}`}
            </span>
            <button className="btn xs ghost" onClick={() => patch({ repDrill: null })}>
              ← 返回整体
            </button>
          </>
        ) : null}
      </SecTitle>
      {/* #13：平台分布与币种分布同样**等高** */}
      <div className="grid2">
        <div className="card eq">
          <CardHd title="平台分布" sub={scoped(`折 ${base} · 悬浮查看币种构成`)} />
          <div className="eq-mid">
            <PlatformBars
              rows={subBd ? subBd.platforms : platCur.data?.rows ?? []}
              emptyText={drill ? `该分类下没有可计入的平台项。` : undefined}
            />
          </div>
        </div>
        <div className="card eq">
          {/* #3：维度分布里的币种分布由条形改为饼图 */}
          <CardHd title="币种分布" sub={scoped(`折 ${base} · 悬浮查看币种明细`)} />
          <div className="eq-mid">
            <CurrencyPie
              rows={subBd ? subBd.currencies : currency.data?.rows ?? []}
              size={200}
              legendMinWidth={200}
              /* `data-chart` 沿用本页已有的那套标记（rep-trend / rep-asset-pie …）。
                 它只落一个属性、不参与渲染，纯粹给验收脚本一个稳定的定位点 ——
                 否则「币种分布」这块只能靠 DOM 位置去猜。 */
              chartAttrs={{ 'data-chart': 'rep-currency-pie' }}
            />
          </div>
        </div>
      </div>
      <div className="card">
        <CardHd
          title="标签分布"
          sub={drill ? `仅「${drill.name}」分类 · 一个账户可有多个标签` : '一个账户可有多个标签，故合计大于净资产'}
        />
        <BarList
          rows={subBd ? subBd.tags : tagRows}
          emptyText={drill ? '该分类下没有带标签的项。' : undefined}
        />
      </div>
    </>
  );

  const wealthTab = (
    <>
      <SecTitle first>理财收益</SecTitle>
      {!rp || rp.count + rp.first + rp.missing_base + rp.no_principal === 0 ? (
        <div className="card">
          <EmptyBox text="当前没有开启「跟踪本金」的账户，或这些账户尚未填写本金。" />
        </div>
      ) : (
        <>
          {/* #5：理财侧一律不再出现「本期收益」（4 卡 → 3 卡）#6：总本金 / 总市值加环比 */}
          <div style={{ marginBottom: 16 }}>
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
              <Stat
                tone="purple"
                k="总本金"
                v={money(rp.principal, 0)}
                vStyle={{ fontSize: 22 }}
                d={<PrevCompare diff={rCmp?.principal ?? null} noPrev={prevId === null} />}
              />
              <Stat
                tone="blue"
                k="总市值"
                v={money(rp.market, 0)}
                vStyle={{ fontSize: 22 }}
                d={<PrevCompare diff={rCmp?.market ?? null} noPrev={prevId === null} />}
              />
              <Stat
                tone="green"
                k="累计收益"
                v={money(rp.cum, 0)}
                vStyle={{ fontSize: 22 }}
                d={<Pct v={rp.cum_rate} />}
              />
            </div>
            {/* #6：环比的口径小字（与首页、快照详情共用同一句，见 lib/returnsCompare.ts） */}
            <div className="panel-hint" style={{ marginTop: 8 }}>{returnsCompareHint(rp.count)}</div>
          </div>
          <div className="card">
            <CardHd
              title="收益趋势"
              sub="累计收益"
              right={<Legend items={[{ color: 'var(--purple)', label: '累计收益' }]} />}
            />
            <ChartBox className="chartbox" dataChart="rep-ret">
              {w =>
                /* 与净资产趋势同理：只有一期时也把点画出来（#6 的连带处理） */
                retSeries.length >= 1 ? (
                  <LineChart
                    w={w}
                    height={250}
                    series={[{ data: retSeries, color: '#C4A1FF', area: true, inner: true }]}
                  />
                ) : null
              }
            </ChartBox>
          </div>
          <Tabs
            value={rbDim}
            onChange={v => patch({ repRetDim: v })}
            options={RET_DIMS.map(k => ({ value: k, label: DIMS[k].label }))}
          />
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>维度</th>
                  <th className="num">本金</th>
                  <th className="num">市值</th>
                  <th className="num">累计收益</th>
                  <th className="num">累计收益率</th>
                </tr>
              </thead>
              <tbody>
                {rbRows.length ? (
                  rbRows.map(x => (
                    <tr key={x.key}>
                      <td>
                        <b>{x.name}</b>
                        {rbDim !== 'currency' ? (
                          <Fragment>
                            {' '}
                            <span className="badge mute mono">{x.n}</span>
                          </Fragment>
                        ) : null}
                      </td>
                      <td className="num">{money(x.principal, 0)}</td>
                      <td className="num">{money(x.market, 0)}</td>
                      <td className="num">
                        <Delta v={x.cum} dec={0} />
                      </td>
                      <td className="num">
                        <Pct v={x.cum_rate} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <span className="muted">本期无可纳入统计的账户（跟踪本金且已填本金）。</span>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td>合计</td>
                  <td className="num">{money(rp.principal, 0)}</td>
                  <td className="num">{money(rp.market, 0)}</td>
                  <td className="num">{money(rp.cum, 0)}</td>
                  <td className="num">{pctText(rp.cum_rate)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <Note tone="info" style={{ marginTop: 14 }}>
            收益指标是<b>派生值</b>，实时计算、不落库，且<b>不参与</b>总资产 / 总负债 / 净资产的计算。
          </Note>
        </>
      )}
    </>
  );

  return (
    <>
      <Tabs value={tab} onChange={v => patch({ repTab: v })} options={REP_TABS} />
      {tab === 'asset' ? assetTab : wealthTab}
    </>
  );
}
