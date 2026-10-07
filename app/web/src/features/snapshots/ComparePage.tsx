/**
 * ComparePage.tsx —— 两期对比（PRD §3.5.1 / 规则 8）
 *
 * 对应原型的 `renderCompare`。整个对比结果由 `/snapshots/compare` 一次返回：
 * 早期/晚期由服务端按快照全序判定，前端只负责渲染 —— 因此「A / B 两个下拉
 * 谁早谁晚」不会出现前后端各判一次、判得不一样的情况。
 *
 * 默认期次沿用原型语义：A = 倒数第二新的，B = 最新的（列表按时间倒序）。
 * 这里用**派生值**而不是写回 UI 状态，避免首帧多一次渲染。
 */
import type { CompareDTO, Dim, SnapshotSummaryDTO } from '@app/shared';
import { ep, useApi } from '../../api/index.ts';
import { getBaseCurrency, money, pctText } from '../../lib/money.ts';
import { snapsDesc } from '../../lib/series.ts';
import { DIMS, useUi } from '../../state/ui.tsx';
import { Delta, Pct } from '../../components/Delta.tsx';
import { EmptyState, Note, SecTitle, Stat, Tabs } from '../../components/Atoms.tsx';

const TAB_KEYS: readonly Dim[] = ['account', 'platform', 'category', 'currency', 'tag'];

export function ComparePage({ snapshotList }: { snapshotList: readonly SnapshotSummaryDTO[] }) {
  const { ui, patch } = useUi();
  const list = snapsDesc(snapshotList);

  /* 默认期次：A 较早、B 较晚。若 UI 里存的 id 已不在列表中（例如数据被重置），
     同样落回默认值 —— 原型在这里会直接抛错，React 版收紧。 */
  const ids = new Set(list.map(s => s.id));
  const cmpA = ui.cmpA && ids.has(ui.cmpA) ? ui.cmpA : list.length >= 2 ? list[1].id : null;
  const cmpB = ui.cmpB && ids.has(ui.cmpB) ? ui.cmpB : list.length >= 1 ? list[0].id : null;

  const cmp = useApi<CompareDTO>(
    cmpA && cmpB ? ep.compare(cmpA, cmpB, ui.cmpTab, ui.cmpMode) : null
  );

  if (list.length < 2) {
    return (
      <div className="card">
        <EmptyState icon="◉" title="至少需要两期快照" desc="完成两次盘点后即可进行跨期对比。" />
      </div>
    );
  }

  if (!cmp.data) {
    return (
      <div className="card">
        <EmptyState icon="◉" title="正在准备对比数据" desc="选定两期快照后即可查看变化明细。" />
      </div>
    );
  }

  const r = cmp.data;
  const mode = ui.cmpMode;

  const sel = (which: 'cmpA' | 'cmpB', val: string | null) => (
    <select
      className="inp"
      style={{ width: 'auto' }}
      value={val ?? ''}
      onChange={e => {
        const v = e.target.value;
        if (which === 'cmpA') patch({ cmpA: v });
        else patch({ cmpB: v });
      }}
    >
      {list.map(s => (
        <option value={s.id} key={s.id}>
          {`${s.date} · ${s.note || '无备注'} · ${s.base_currency}`}
        </option>
      ))}
    </select>
  );

  const ret = r.returns;
  const showRet = Boolean(ret.b_principal || ret.a_principal);

  return (
    <>
      <div className="card">
        <div className="card-hd">
          <h3>选择对比期次</h3>
          <span className="sub">左侧为较早一期</span>
        </div>
        <div className="flex wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="field">
            <label>期次 A（较早）</label>
            {sel('cmpA', cmpA)}
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, paddingBottom: 6 }}>→</div>
          <div className="field">
            <label>期次 B（较晚）</label>
            {sel('cmpB', cmpB)}
          </div>
        </div>
        {r.cross_currency ? (
          <Note tone="warn" style={{ marginTop: 14 }}>
            {`两期本位币不同（${r.early.base_currency} → ${r.late.base_currency}）。默认`}
            <b>按原口径分别展示</b>
            {'，各期数值以各自本位币计。'}
            <div className="seg sm" style={{ marginTop: 10 }}>
              <button className={mode === 'origin' ? 'on' : ''} onClick={() => patch({ cmpMode: 'origin' })}>
                原口径分别展示
              </button>
              <button className={mode === 'current' ? 'on' : ''} onClick={() => patch({ cmpMode: 'current' })}>
                {`统一折算为 ${getBaseCurrency()}（参考）`}
              </button>
            </div>
          </Note>
        ) : null}
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 16 }}>
        <Stat
          k="总资产变化"
          v={r.delta_total_assets === null ? '—' : money(r.delta_total_assets, 0)}
          vStyle={{ fontSize: 24 }}
          d={`${money(r.totals_early.total_assets, 0)} → ${money(r.totals_late.total_assets, 0)}`}
        />
        <Stat
          k="总负债变化"
          v={r.delta_total_liabilities === null ? '—' : money(r.delta_total_liabilities, 0)}
          vStyle={{ fontSize: 24 }}
          d={`${money(r.totals_early.total_liabilities, 0)} → ${money(r.totals_late.total_liabilities, 0)}`}
        />
        <Stat
          tone="hero"
          k="净资产变化"
          v={r.delta_net_worth === null ? '—' : money(r.delta_net_worth, 0)}
          vStyle={{ fontSize: 28 }}
          d={
            <>
              {r.rate_net_worth !== null ? <Pct v={r.rate_net_worth} /> : '—'}
              {` · ${money(r.totals_early.net_worth, 0)} → ${money(r.totals_late.net_worth, 0)}`}
            </>
          }
        />
      </div>

      {showRet ? (
        <>
          <SecTitle>理财收益对比</SecTitle>
          <div className="card">
            <div className="grid3">
              <div className="kv">
                <span className="kk">总本金</span>
                <span className="vv">{`${money(ret.a_principal, 0)} → ${money(ret.b_principal, 0)}`}</span>
                <span className="kk">累计收益</span>
                <span className="vv">{`${money(ret.a_cum, 0)} → ${money(ret.b_cum, 0)}`}</span>
                <span className="kk">累计收益率</span>
                <span className="vv">{`${pctText(ret.a_rate)} → ${pctText(ret.b_rate)}`}</span>
              </div>
              <div className="kv">
                <span className="kk">本金净投入</span>
                <span className="vv">
                  <Delta v={ret.b_principal - ret.a_principal} dec={0} />
                </span>
                <span className="kk">收益变化</span>
                <span className="vv">
                  <Delta v={ret.b_cum - ret.a_cum} dec={0} />
                </span>
                <span className="kk">收益率变化</span>
                <span className="vv">
                  {ret.a_rate !== null && ret.b_rate !== null ? pctText(ret.b_rate - ret.a_rate) : '—'}
                </span>
              </div>
              <div className="note info" style={{ margin: 0, fontSize: 11.5 }}>
                本金净投入反映期间资金进出的影响，与收益分开看，避免&quot;追加投入被误判为赚了&quot;。
              </div>
            </div>
          </div>
        </>
      ) : null}

      <SecTitle>变化明细</SecTitle>
      <Tabs
        value={ui.cmpTab}
        onChange={v => patch({ cmpTab: v })}
        options={TAB_KEYS.map(k => ({ value: k, label: k === 'tag' ? '按标签' : DIMS[k].label }))}
      />
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{ui.cmpTab === 'tag' ? '标签' : DIMS[ui.cmpTab].label.slice(1)}</th>
              <th className="num">
                {r.early.date}
                <div className="tiny">{r.early.base_currency}</div>
              </th>
              <th className="num">
                {r.late.date}
                <div className="tiny">{r.late.base_currency}</div>
              </th>
              <th className="num">变化额</th>
              <th className="num">变化率</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map(x => (
              <tr key={x.key}>
                <td>
                  <b>{x.name}</b>
                  {x.is_new ? (
                    <>
                      {' '}
                      <span className="badge ok">新增</span>
                    </>
                  ) : null}
                  {x.is_gone ? (
                    <>
                      {' '}
                      <span className="badge mute">本期缺失</span>
                    </>
                  ) : null}
                </td>
                <td className="num">{x.a === null ? <span className="muted">—</span> : money(x.a, 0)}</td>
                <td className="num">{x.b === null ? <span className="muted">—</span> : money(x.b, 0)}</td>
                <td className="num">
                  <Delta v={x.diff} dec={0} />
                </td>
                <td className="num">
                  {x.rate !== null ? <Pct v={x.rate} /> : <span className="flat">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note" style={{ marginTop: 14 }}>
        变化额为正表示该项净资产增加，按变化额绝对值倒序。净额为负的项（负债主导）不计算变化率，避免「-108%」这类误导性读数。
      </div>
    </>
  );
}
