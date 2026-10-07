/**
 * SnapshotsListPage.tsx —— 快照列表（PRD §3.3.4 §3.5.1）· 快照卡包
 *
 * ============================================================
 * 2026-10-05 视觉迭代：表格 → 快照卡包 + 时间筛选
 * ============================================================
 * 需求原文：「快照也需要设计成快照包的样式，列表页增加时间筛选，操作放到下一层页面」
 *
 * 三处结构性改动：
 *   1. **新增时间筛选**（列表页顶部，快捷档 + 自定义起止）；
 *   2. **列表由「一张 10 列的大表」改为「按月分组的卡片网格」**；
 *   3. **删除下沉重做** —— 卡内不再有按钮，整张卡点击进快照详情，
 *      「删除这一期」搬到详情页（那里同时说明「只读、只能删了重做」的原因）。
 *
 * ⚠ 时间筛选**必须在前端做**，不能走 `/snapshots?from=&to=`：
 *   后端确实支持这两个参数（`snapshotListQuerySchema`），但**离线 fixture 里只有裸键
 *   `/snapshots`** —— `app/web/public/fixture.json` 的 547 条路由没有任何 `?from=&to=`
 *   变体。改成服务端筛选，`?data=fixture` 下会取不到数据，而 Step 3 的 11 张基准图
 *   **全部走 fixture**，会整片崩。所以这里对已取的 `snapshotList` 做筛选，零新请求。
 *
 * 「较上期」用当日序列的相邻两期（同名快照只算当日最后一张）；
 * 「累计收益」取 /reports/returns-trend 的同一张快照一行 —— 该端点返回**全部快照**的
 * 收益面板，因此这里只有一次请求，不会随快照数量增长成 N+1。
 */
import { useMemo } from 'react';
import type { ReturnsTrendDTO, SnapshotSummaryDTO } from '@app/shared';
import { ep, useApi } from '../../api/index.ts';
import { money, money0, todayISO } from '../../lib/money.ts';
import { dailySeries, duplicateCount, filterBySnapRange, snapRangeBounds, snapsDesc, type SnapRange } from '../../lib/series.ts';
import { Delta } from '../../components/Delta.tsx';
import { EmptyState, Note } from '../../components/Atoms.tsx';
import { Collapse } from '../../components/Collapse.tsx';
import { useUi } from '../../state/ui.tsx';

const RANGE_OPTS: ReadonlyArray<{ value: SnapRange; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'year', label: '今年' },
  { value: '6m', label: '近 6 个月' },
  { value: '3m', label: '近 3 个月' },
  { value: 'custom', label: '自定义' }
];

export function SnapshotsListPage({
  snapshotList,
  onStartInventory,
  onOpenSnapshot
}: {
  snapshotList: readonly SnapshotSummaryDTO[];
  onStartInventory: () => void;
  onOpenSnapshot: (id: string) => void;
}) {
  const { ui, patch } = useUi();
  const retTrend = useApi<ReturnsTrendDTO>(ep.returnsTrend());
  const retBySnapshot = new Map((retTrend.data?.points ?? []).map(p => [p.snapshot_id, p]));

  const list = useMemo(() => snapsDesc(snapshotList), [snapshotList]);
  const daily = useMemo(() => dailySeries(snapshotList), [snapshotList]);

  /* ---- 时间筛选（口径在 lib/series.ts，只有一份；这里只是取值）---- */
  const { from, to } = snapRangeBounds(ui.snapRange, { from: ui.snapFrom, to: ui.snapTo });
  const filtered = useMemo(
    () => filterBySnapRange(list, ui.snapRange, { from: ui.snapFrom, to: ui.snapTo }),
    [list, ui.snapRange, ui.snapFrom, ui.snapTo]
  );

  /* ---- 按月分组（列表已是倒序，首次出现的顺序即分组顺序）---- */
  const groups = useMemo(() => {
    const m = new Map<string, SnapshotSummaryDTO[]>();
    for (const s of filtered) {
      const k = s.date.slice(0, 7);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return [...m.entries()];
  }, [filtered]);

  const today = todayISO();

  if (!list.length) {
    return (
      <div className="card">
        <EmptyState
          icon="◉"
          title="还没有快照"
          desc="完成第一次盘点后，这里会按时间倒序展示所有历史快照。"
          action={
            <button className="btn pri" onClick={onStartInventory}>
              开始盘点
            </button>
          }
        />
      </div>
    );
  }

  const setRange = (r: SnapRange) => patch({ snapRange: r });

  return (
    <>
      <Note tone="info">
        快照一经保存即<b>只读</b>，汇率与口径被冻结在明细里。同一日期允许多张快照，趋势图与按日期对比取
        <b>当日最后一张</b>。
      </Note>

      {/* ============ 时间筛选 ============ */}
      <div className="snap-filter">
        <div className="seg">
          {RANGE_OPTS.map(o => (
            <button key={o.value} className={ui.snapRange === o.value ? 'on' : ''} onClick={() => setRange(o.value)}>
              {o.label}
            </button>
          ))}
        </div>

        {/* 日期输入只在「自定义」档出现 —— 其余四档是相对区间，填了也会被忽略 */}
        {ui.snapRange === 'custom' ? (
          <>
            <input
              className="inp dt"
              type="date"
              value={ui.snapFrom}
              max={ui.snapTo || today}
              onChange={e => patch({ snapFrom: e.target.value })}
            />
            <span className="panel-hint">～</span>
            <input
              className="inp dt"
              type="date"
              value={ui.snapTo}
              min={ui.snapFrom || undefined}
              onChange={e => patch({ snapTo: e.target.value })}
            />
            <button
              className="btn xs ghost"
              onClick={() => patch({ snapFrom: '', snapTo: '' })}
              disabled={!ui.snapFrom && !ui.snapTo}
            >
              清除
            </button>
          </>
        ) : null}

        <span className="snap-hit">
          {from || to ? `命中 ${filtered.length} / 共 ${list.length} 期` : `共 ${list.length} 期`}
        </span>
      </div>

      {/* ============ 快照卡包 ============ */}
      {!filtered.length ? (
        <div className="card">
          <EmptyState
            icon="◔"
            title="该时间范围内没有快照"
            desc={`共 ${list.length} 期快照，当前筛选区间为 ${from ?? '最早'} ～ ${to ?? '最新'}。`}
            action={
              <button className="btn" onClick={() => patch({ snapRange: 'all', snapFrom: '', snapTo: '' })}>
                清除时间筛选
              </button>
            }
          />
        </div>
      ) : (
        <div className="snap-pack">
          {groups.map(([ym, arr]) => {
            const [y, m] = ym.split('-');
            /* 组头右侧：组内首末净资产（arr 是倒序，arr[0] 最新、arr[arr.length-1] 最早） */
            const newest = arr[0];
            const oldest = arr[arr.length - 1];
            return (
              <Collapse
                key={ym}
                header={
                  <>
                    <span>{`${y} 年 ${Number(m)} 月`}</span>
                    <span className="badge cur">{`${arr.length} 期`}</span>
                    <span className="spacer" style={{ flex: 1 }} />
                    <span className="mono tiny muted">
                      {arr.length > 1
                        ? `净资产 ${money(oldest.net_worth, 0)} → ${money(newest.net_worth, 0)}`
                        : `净资产 ${money(newest.net_worth, 0)}`}
                    </span>
                  </>
                }
              >
                <div className="snap-grid">
                  {arr.map(s => {
                    const dups = duplicateCount(snapshotList, s.date);
                    const idx = daily.findIndex(d => d.id === s.id);
                    const prev = idx > 0 ? daily[idx - 1] : null;
                    const d = prev ? s.net_worth - prev.net_worth : null;
                    const rp = retBySnapshot.get(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className="snap-card"
                        onClick={() => onOpenSnapshot(s.id)}
                        title={`查看 ${s.date} 的快照详情`}
                      >
                        <span className="snap-card-band" />
                        <span className="snap-card-body">
                          <span className="snap-top">
                            <span className="snap-date">{s.date}</span>
                            {dups > 1 ? <span className="badge dup">同日多张</span> : null}
                            <span className="spacer" style={{ flex: 1 }} />
                            {/* 与账户卡同一个「点得进去」凭据；理由见 mount.css */}
                            <span className="snap-card-go" aria-hidden="true">›</span>
                          </span>
                          <span className="snap-note">{s.note || '—'}</span>
                          <span className="snap-amt">{money(s.net_worth, 0)}</span>
                          <span className="snap-foot">
                            {d !== null ? (
                              <>
                                {'较上期 '}
                                <Delta v={d} dec={0} />
                              </>
                            ) : dups > 1 ? (
                              '同日重复 · 不计环比'
                            ) : (
                              '最早一期 · 无可比期'
                            )}
                          </span>
                          <span className="snap-meta">
                            {`总资产 ${money(s.total_assets, 0)} · 总负债 ${money(s.total_liabilities, 0)}`}
                            <br />
                            {`${s.base_currency} · ${s.item_count} 条明细`}
                            {s.carried_over ? ` · ${s.carried_over} 条沿用` : ''}
                            <br />
                            {rp && rp.count ? (
                              <>
                                {'累计收益 '}
                                <span className={rp.cum >= 0 ? 'up' : 'down'}>{money0(rp.cum)}</span>
                              </>
                            ) : (
                              '累计收益 —'
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Collapse>
            );
          })}
        </div>
      )}

      <Note style={{ marginTop: 16 }} tone="plain">
        点「两期对比」可任选两期，按账户 / 平台 / 分类 / 币种 / 标签查看变化（以 ID 匹配，改名不受影响）。
        删除某一期需要先点进它的详情页 —— 那是全站唯一不可撤销的操作。
      </Note>
    </>
  );
}
