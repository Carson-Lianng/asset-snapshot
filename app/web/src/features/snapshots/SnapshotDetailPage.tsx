/**
 * SnapshotDetailPage.tsx —— 快照详情（PRD §3.3.4 §3.1.1 §3.4.4）
 *
 * 对应原型的 `renderSnapshotDetail` + `itemRowHTML` + `groupItems`。
 *
 * 三处「口径」的取值来源刻意分开，与原型一致：
 *   1. 净资产 / 总资产 / 总负债  → 领域层 `snapTotalsIn(snapshot, mode, ctx)`。
 *      当前本位币口径下这一步是**二级折算**（快照本位币 → 当前本位币），
 *      必须与后端同一份代码，因此不重写、也不拿 DTO 的落库值凑。
 *   2. 明细行的「折本位币」→ 同样是领域层 `itemValueIn`，断裂时返回 null
 *      （界面显示「折算链断裂」，**不得当 0 用**）。
 *   3. 明细行的收益指标 → 取 `/snapshots/:id/returns`。该端点的口径就是
 *      `returnsOf(item, prevItemOf(series, account_id, snapshot))`，与原型逐字一致，
 *      因此不必把整个快照序列搬到前端来重算一遍。
 *
 * 另注：`view` 查询参数对 `/snapshots/:id` 没有影响（服务端返回的永远是落库值），
 * 折算完全在前端做。
 *
 * 2026-10-04 第二批界面需求：
 *   #4 去掉「口径切换」卡 —— 详情页固定展示**原口径**（快照冻结口径，唯一事实来源），
 *      见下方 `mode` 的注释。`ui.snapMode0` 字段随之删除。
 *   #5 理财收益面板去掉「本期收益」（4 卡 → 3 卡），提示只再提「未填本金」——
 *      其余两类（首期 / 基准缺失）自 PRD v1.3 起**照常计入累计**，不属于「未纳入统计」。
 *
 * 2026-10-05 视觉迭代：**「删除这一期」从列表页搬到这里**。
 * 列表页现在是纯只读的卡包（点卡片才进得来），删除作为全站唯一一个不可撤销的操作，
 * 在这里出现时旁边正好可以放上「为什么只能删」的原因 —— 这在列表页是一句没有上下文的
 * 提示，在这里是这一次操作的说明。
 */
import { Fragment, useMemo, useState } from 'react';
import type {
  BaseCurrencyChangeDTO,
  ItemReturnDTO,
  ReturnsPanelDTO,
  SnapshotDTO,
  SnapshotItemDTO,
  SnapshotSummaryDTO
} from '@app/shared';
import { itemValueIn, snapTotalsIn, type FxContext, type Snapshot, type SnapshotItem } from '@app/domain';
import { ep, mutate, useApi, writable } from '../../api/index.ts';
import { messageOf } from '../../api/problem.ts';
import { dtoSnapshotToDomain, fxOf } from '../../lib/adapt.ts';
import { getBaseCurrency, microOf, money, pctText, rateText } from '../../lib/money.ts';
import { dailySeries, previousInDaily } from '../../lib/series.ts';
import { returnsCompare, returnsCompareHint } from '../../lib/returnsCompare.ts';
import { DIMS, RETURN_TAG, useUi, type SnapTab } from '../../state/ui.tsx';
import { CardHd, SecTitle, Stat, Tabs, TagBadges } from '../../components/Atoms.tsx';
import { Delta, Pct, PrevCompare } from '../../components/Delta.tsx';
import { ConfirmModal } from '../../components/Modal.tsx';
import { useToast } from '../../components/Toast.tsx';

interface ListResponse<T> {
  items: T[];
}

const TAB_KEYS: readonly SnapTab[] = ['platform', 'currency', 'category', 'account'];

export function SnapshotDetailPage({
  snapshotId,
  snapshotList,
  onDeleted
}: {
  snapshotId: string | null;
  snapshotList: readonly SnapshotSummaryDTO[];
  /** 删除成功后返回列表（由 Shell 决定去哪，页面本身不认识路由） */
  onDeleted: () => void;
}) {
  const { ui, patch } = useUi();
  const toast = useToast();

  /* 待确认删除的那一期；非 null 时弹确认框 */
  const [askDelete, setAskDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const detail = useApi<SnapshotDTO>(snapshotId ? ep.snapshot(snapshotId, 'origin') : null);
  const returns = useApi<{ snapshot_id: string; items: ItemReturnDTO[] }>(
    snapshotId ? ep.snapshotReturns(snapshotId) : null
  );
  const panel = useApi<ReturnsPanelDTO>(snapshotId ? ep.returns(snapshotId) : null);
  const history = useApi<ListResponse<BaseCurrencyChangeDTO>>(ep.baseCurrencyHistory());

  const ctx: FxContext = useMemo(
    () => fxOf(getBaseCurrency(), history.data?.items ?? []),
    [history.data]
  );

  const daily = dailySeries(snapshotList);
  /* 前一期**必须在这里算出来**（Hook 顺序）：下面 `if (!snapshotId || !detail.data) return`
     之后就再加不了 Hook。用 `snapshotId` 而不是 `snap.id` —— 两者是同一个值
     （`snap` 由 `ep.snapshot(snapshotId)` 的响应构造），而 `snap` 要等早退之后才有。 */
  const prevId = snapshotId ? (previousInDaily(daily, snapshotId)?.id ?? null) : null;
  /* #6：总本金 / 总市值的环比要用上一期的收益面板（累计收益的环比恒等于已删除的
     「本期收益」，故不加 —— 见 lib/returnsCompare.ts） */
  const prevPanel = useApi<ReturnsPanelDTO>(prevId ? ep.returns(prevId) : null);

  if (!snapshotId || !detail.data) {
    return (
      <div className="card">
        <CardHd title="快照不存在" sub="该快照可能已被删除，请回到列表重新选择。" />
      </div>
    );
  }

  const dto = detail.data;
  const snap: Snapshot = dtoSnapshotToDomain(dto);
  /**
   * 详情页固定展示**原口径**（快照冻结口径，唯一事实来源）。
   *
   * 原先这里读 `ui.snapMode0`，页面上有一张「口径切换」卡可以在「原口径 / 当前本位币口径」
   * 之间切。2026-10-04 按需求把那张卡去掉了（它同时承载着「参考值 · 二级换算存在精度损失」
   * 的警示），所以状态位与其在 `ui.tsx` 里的字段一并删除 —— 留着就是一个永远为 'origin'
   * 的死状态。`itemValueIn` / `snapTotalsIn` 仍支持 'current'，能力没有删，只是不再从这里进入。
   */
  const mode = 'origin' as const;
  const totals = snapTotalsIn(snap, mode, ctx);
  const rp = panel.data;
  /* #6：总本金 / 总市值的环比 */
  const rCmp = returnsCompare(rp, prevPanel.data);

  const prev = previousInDaily(daily, snap.id);

  /**
   * 删除这一期。走 `mutate` 而不是裸 `send`：删掉一期会让快照列表、各报表趋势、
   * 账户页的「最近金额」与收益列、首页的最近两期对照全部失效 ——
   * 这些关系靠人手维护必然漏，交给「写完就整体作废」这一次动作。
   *
   * 这是全站唯一一个**不可撤销**的操作，因此走二次确认，且确认框里必须写清
   * 「净资产多少、共几条明细、删了不可恢复」—— 文案与原型 `delSnapshot` 逐字符一致。
   */
  async function doDelete(): Promise<void> {
    if (!snapshotId || busy) return;
    if (!writable()) {
      toast('当前是离线数据源（?data=fixture），删除不可用', 'warn');
      setAskDelete(false);
      return;
    }
    setBusy(true);
    try {
      await mutate(ds => ds.send<{ deleted: string }>('DELETE', `/snapshots/${snapshotId}`));
      toast(`已删除快照 ${dto.date}`, 'ok');
      onDeleted();
    } catch (err) {
      toast(`删除失败：${messageOf(err)}`, 'err', 4200);
    } finally {
      setBusy(false);
      setAskDelete(false);
    }
  }

  /* 原型：`prev ? r2(s.net_worth - prev.net_worth) : null`。
     它用的是**原口径落库值** —— 与展示口径无关，因此「口径切换」去掉之后这个取法一行都不用改。 */
  const dNw = prev ? microOf(snap.net_worth)! - prev.net_worth : null;

  const retByItem = new Map((returns.data?.items ?? []).map(r => [r.item_id, r]));
  const items = [...snap.items].sort((a, b) => a.sort - b.sort);
  const tab = ui.snapTab;
  const groups = tab === 'account' ? null : groupItems(items, tab);

  return (
    <>
      <div className="stat-grid" style={{ gridTemplateColumns: '1.5fr 1fr 1fr', marginBottom: 16 }}>
        <Stat
          tone="hero"
          k={`净资产 · 原口径 ${snap.base_currency}`}
          v={money(microOf(totals.nw))}
          d={
            dNw !== null ? (
              <>
                {'较前一期 '}
                <Delta v={dNw} dec={0} />
              </>
            ) : (
              <span className="flat">最新一期</span>
            )
          }
        />
        <Stat tone="blue" k="总资产" v={money(microOf(totals.ta), 0)} />
        <Stat tone="pink" k="总负债" v={money(microOf(totals.tl), 0)} />
      </div>

      {/* 只读说明 + 删除入口。二者刻意放在一起：这一页没有「编辑」，
          唯一的补救手段就是删了重做，所以按钮旁边必须写清这件事。 */}
      <div className="flex between wrap" style={{ gap: 10, marginBottom: 16 }}>
        <span className="panel-hint">
          快照保存后即<b>只读</b> —— 汇率与口径已冻结在明细里。如需修正，只能删除这一期后重新盘点。
        </span>
        <button className="btn sm danger" onClick={() => setAskDelete(true)}>
          删除这一期
        </button>
      </div>

      {rp && rp.count + rp.first + rp.missing_base + rp.no_principal > 0 ? (
        <>
          <SecTitle>理财收益面板（本位币口径）</SecTitle>
          {/* #5：去掉「本期收益」（原先 4 卡）。三类失败标记（首期 / 基准缺失 / 未填本金）
              里只有「未填本金」是真正被排除在统计之外的，见下方提示。 */}
          <div style={{ marginBottom: 16 }}>
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
              <Stat
                tone="purple"
                k="总本金"
                v={money(rp.principal, 0)}
                vStyle={{ fontSize: 22 }}
                d={<PrevCompare diff={rCmp?.principal ?? null} noPrev={prevId === null} label="较前一期" />}
              />
              <Stat
                tone="blue"
                k="总市值"
                v={money(rp.market, 0)}
                vStyle={{ fontSize: 22 }}
                d={<PrevCompare diff={rCmp?.market ?? null} noPrev={prevId === null} label="较前一期" />}
              />
              <Stat
                tone="green"
                k="累计收益"
                v={money(rp.cum, 0)}
                vStyle={{ fontSize: 22 }}
                d={<Pct v={rp.cum_rate} />}
              />
            </div>
            {/* #6：环比的口径小字。原先挂在「总本金」卡上的「N 个账户纳入统计」挪到这一行 ——
                `.d` 一行只放一件事，两张卡都留给环比才不会一张有一张没有。 */}
            <div className="panel-hint" style={{ marginTop: 8 }}>{returnsCompareHint(rp.count)}</div>
          </div>
          {rp.no_principal > 0 ? (
            <div className="note warn" style={{ marginTop: 12 }}>
              {'未纳入统计：'}
              <b>{`未填本金 ${rp.no_principal}`}</b>
              {' 个。这些账户的市值已计入净资产，但不参与收益统计。'}
            </div>
          ) : null}
        </>
      ) : null}

      <SecTitle>汇率面板（快照冻结值）</SecTitle>
      <div className="card">
        <div className="flex wrap" style={{ gap: 10 }}>
          <span className="badge cur">{`1 原币 = X ${snap.base_currency}`}</span>
          {Object.keys(dto.rates)
            .filter(c => c !== snap.base_currency)
            .map(c => (
              <span className="badge" style={{ background: 'var(--paper-3)' }} key={c}>
                {`${c} ${rateText(dto.rates[c])}`}
              </span>
            ))}
          <span className="badge" style={{ background: 'var(--paper-3)' }}>
            {`${snap.base_currency} 1（固定）`}
          </span>
        </div>
      </div>

      <SecTitle>明细</SecTitle>
      <Tabs
        value={tab}
        onChange={v => patch({ snapTab: v })}
        options={TAB_KEYS.map(k => ({ value: k, label: DIMS[k].label }))}
      />
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>账户 / 分类</th>
              <th>平台 / 币种</th>
              <th className="num">原币金额</th>
              <th className="num">汇率</th>
              <th className="num">{`折 ${snap.base_currency}`}</th>
              <th className="num">本金</th>
              <th className="num">累计收益</th>
              <th>状态</th>
              <th>标签</th>
            </tr>
          </thead>
          <tbody>
            {groups
              ? groups.map(g => (
                  <Fragment key={'g-' + g.key}>
                    <tr className="rowgrp">
                      <td colSpan={9}>
                        {`${g.name} · ${g.list.length} 项 · 折本位币净额 `}
                        {money(g.net, 0)}
                      </td>
                    </tr>
                    {g.list.map(it => (
                      <ItemRow
                        key={it.id}
                        item={it}
                        raw={dto.items.find(x => x.id === it.id)}
                        snap={snap}
                        mode={mode}
                        ctx={ctx}
                        metrics={retByItem.get(it.id)}
                      />
                    ))}
                  </Fragment>
                ))
              : items.map(it => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    raw={dto.items.find(x => x.id === it.id)}
                    snap={snap}
                    mode={mode}
                    ctx={ctx}
                    metrics={retByItem.get(it.id)}
                  />
                ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>合计（仅计入净值账户）</td>
              <td className="num">
                {totals.ta !== null && totals.tl !== null
                  ? money(microOf(totals.ta)! - microOf(totals.tl)!, 0)
                  : '—'}
              </td>
              <td colSpan={4}>
                {`总资产 ${money(microOf(totals.ta), 0)} − 总负债 ${money(microOf(totals.tl), 0)}`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 全站唯一一个不可撤销的操作，因此走二次确认。文案与原型 `delSnapshot`
          逐字符对齐（含 `净资产 …，共 … 条明细。删除后不可恢复，如需修正请重新盘点。`）。 */}
      {askDelete ? (
        <ConfirmModal
          title="删除快照"
          okText="删除"
          onClose={() => setAskDelete(false)}
          onOk={() => void doDelete()}
          body={
            <>
              {`确定删除 `}
              <b>{dto.date}</b>
              {` 的快照？`}
              <br />
              <span className="muted small">
                {`净资产 ${money(dto.net_worth, 0)}，共 ${dto.item_count} 条明细。删除后不可恢复，如需修正请重新盘点。`}
              </span>
            </>
          }
        />
      ) : null}
    </>
  );
}

/* ============================================================
   明细行（原型 itemRowHTML）
   ============================================================ */

function ItemRow({
  item,
  raw,
  snap,
  mode,
  ctx,
  metrics
}: {
  item: SnapshotItem;
  /** 同一行的传输形态：汇率要按原样显示，故直接取冻结值而不重新换算 */
  raw: SnapshotItemDTO | undefined;
  snap: Snapshot;
  mode: 'origin' | 'current';
  ctx: FxContext;
  metrics: ItemReturnDTO | undefined;
}) {
  const rateMicro = raw ? raw.exchange_rate : microOf(item.exchange_rate) ?? 0;

  const v = itemValueIn(item, snap, mode, ctx);
  const excl = !item.include_in_net_worth;

  const cum = metrics?.cum ?? null;
  const cumRate = metrics?.cum_rate ?? null;
  const netInvest = metrics?.net_invest ?? null;
  const tag = metrics ? RETURN_TAG[metrics.status] ?? null : null;

  return (
    <tr style={excl ? { opacity: 0.55 } : undefined}>
      <td>
        <b>{item.account_name_snapshot}</b>
        {item.is_carried_over ? (
          <Fragment>
            {' '}
            <span className="badge carry">沿用上次</span>
          </Fragment>
        ) : null}
        {excl ? (
          <Fragment>
            {' '}
            <span className="badge warn">不计净值</span>
          </Fragment>
        ) : null}
        <div className="tiny muted">
          {`${item.category_name_snapshot} · ${item.type === 'asset' ? '资产' : '负债'}`}
        </div>
      </td>
      <td>
        {item.platform_name_snapshot}
        <div className="tiny muted mono">{item.currency}</div>
      </td>
      <td className="num">{money(microOf(item.original_amount), 2, item.currency)}</td>
      <td className="num muted">{rateText(rateMicro)}</td>
      <td className="num bold">
        {v === null ? <span className="badge warn">折算链断裂</span> : money(microOf(v))}
      </td>
      <td className="num">
        {item.principal !== null ? (
          money(microOf(item.principal), 2, item.currency)
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="num">
        {cum !== null ? (
          <Fragment>
            <Delta v={cum} dec={2} cur={item.currency} />
            <div className="tiny muted">{pctText(cumRate)}</div>
          </Fragment>
        ) : tag ? (
          <span className={'badge ' + tag.c}>{tag.t}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {netInvest !== null && netInvest !== 0 ? (
          <span className={'badge ' + (netInvest > 0 ? 'ok' : 'warn')}>
            {`净投入 ${netInvest > 0 ? '+' : ''}${money(netInvest, 0, item.currency)}`}
          </span>
        ) : (
          <span className="muted tiny">—</span>
        )}
      </td>
      <td>
        <TagBadges tags={item.tags_snapshot} max={3} />
      </td>
    </tr>
  );
}

/* ============================================================
   分组（原型 groupItems）
   ============================================================ */

interface Group {
  key: string;
  name: string;
  list: SnapshotItem[];
  /** 折本位币净额，微元。**原口径**累加，与展示口径无关（原型同样写法） */
  net: number;
}

function groupItems(items: readonly SnapshotItem[], dim: SnapTab): Group[] {
  const map = new Map<string, Group>();
  const order: string[] = [];

  for (const it of items) {
    let key: string;
    let name: string;
    if (dim === 'platform') {
      key = it.platform_id_snapshot || 'none';
      name = it.platform_name_snapshot || '未指定平台';
    } else if (dim === 'currency') {
      key = it.currency;
      name = it.currency;
    } else {
      key = it.category_id_snapshot || 'none';
      name = it.category_name_snapshot;
    }
    let g = map.get(key);
    if (!g) {
      g = { key, name, list: [], net: 0 };
      map.set(key, g);
      order.push(key);
    }
    g.list.push(it);
    if (it.include_in_net_worth) {
      const d = it.type === 'asset' ? it.amount_in_base.toMicro() : -it.amount_in_base.toMicro();
      g.net += Number(d);
    }
  }

  return order.map(k => map.get(k) as Group);
}
