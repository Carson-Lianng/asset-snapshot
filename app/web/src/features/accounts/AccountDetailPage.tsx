/**
 * AccountDetailPage.tsx —— 账户详情（2026-10-05 视觉迭代新增）
 *
 * 这一页是账户页的「下一层」：需求原文是「操作放到下一层页面」，
 * 所以编辑 / 归档 / 删除三个动作从列表行里搬到了这里，
 * 列表那边只留「整张卡可点」。
 *
 * 为什么是独立页面而不是复用已有的编辑弹窗：
 *   · 与 `#snapshot-detail` 同构 —— 列表 → 详情的两层结构在两页上一致；
 *   · 弹窗只装得下表单，装不下「最近一期盘点结果 + 较上一期变化 + 账户档案」
 *     这些**只读**内容，而它们正是「这个账户现在什么状况」的答案。
 *
 * 取数只用 2 个请求，与列表页完全相同：
 *   `/snapshots/:id`          → 该账户在本期的原币金额 / 汇率 / 折本位币 / 本金 / 是否沿用
 *   `/snapshots/:id/returns`  → 累计收益、累计收益率、净投入，以及 **`prev_amount`**
 *                               （比本期更早、且包含该账户的最新一期里的原币金额）
 *
 * ⚠ 为什么不做「该账户的历史走势」：现有端点里没有「单账户跨期序列」
 *   （`/reports/returns-breakdown` 是**按快照**、按维度聚合的，不是按账户跨期）。
 *   要画走势就得为每一期各发一次请求，或者新增一个后端端点 —— 两者都超出
 *   「视觉迭代」的范围。所以这里用「较上一期变化」作为替代，它由 `prev_amount`
 *   直接得到，零额外请求。
 *
 * 「看的是哪一个账户」放在 UiState（`ui.accSel`），URL 只表达「在第几层」
 * （`#account-detail`）—— 与 `snapSel` / `#snapshot-detail` 同一套写法。
 */
import { useState } from 'react';
import type {
  AccountDTO,
  CategoryDTO,
  ItemReturnDTO,
  PlatformDTO,
  SnapshotDTO,
  SnapshotSummaryDTO,
  TagDTO
} from '@app/shared';
import { ep, mutate, useApi, writable } from '../../api/index.ts';
import { messageOf } from '../../api/problem.ts';
import { currencyColorOf } from '../../lib/palette.ts';
import { getBaseCurrency, money, pctText, rateText } from '../../lib/money.ts';
import { dailySeries } from '../../lib/series.ts';
import { CatBadge, CardHd, Note, SecTitle, Stat, TagBadges } from '../../components/Atoms.tsx';
import { Delta } from '../../components/Delta.tsx';
import { ConfirmModal } from '../../components/Modal.tsx';
import { useToast } from '../../components/Toast.tsx';
import { RETURN_TAG } from '../../state/ui.tsx';

interface ListResponse<T> {
  items: T[];
}

export function AccountDetailPage({
  accountId,
  accounts,
  platforms,
  categories,
  tags,
  snapshotList,
  onEdit,
  onBack
}: {
  accountId: string | null;
  accounts: readonly AccountDTO[];
  platforms: readonly PlatformDTO[];
  categories: readonly CategoryDTO[];
  tags: readonly TagDTO[];
  snapshotList: readonly SnapshotSummaryDTO[];
  /** 「编辑」仍走 Shell 那个弹窗（与顶栏、空态同一个入口） */
  onEdit: (id: string) => void;
  /** 返回列表；删除成功后也走这里 */
  onBack: () => void;
}) {
  const toast = useToast();
  const base = getBaseCurrency();
  const [askDelete, setAskDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const account = accountId ? accounts.find(a => a.id === accountId) ?? null : null;

  /* 「本期」用**当日折叠序列**（同一天多张只取最后一张），与首页、账户总览同一口径。
     ⚠ 「上期」**不能**同样取 `daily` 的相邻一期 —— 理由见下面 `dAmount` 的注释。 */
  const daily = dailySeries(snapshotList);
  const last = daily.length ? daily[daily.length - 1] : null;

  /* —— 下面两个 useApi 必须在早退之前调用（Hook 顺序）—— */
  const detail = useApi<SnapshotDTO>(last ? ep.snapshot(last.id, 'origin') : null);
  const returns = useApi<ListResponse<ItemReturnDTO>>(last ? ep.snapshotReturns(last.id) : null);

  if (!account) {
    return (
      <div className="card">
        <CardHd title="账户不存在" sub="它可能已被删除，请回到账户列表重新选择。" />
      </div>
    );
  }

  const color = currencyColorOf(account.currency);
  const platformName = account.platform_id
    ? platforms.find(p => p.id === account.platform_id)?.name ?? '未指定平台'
    : '未指定平台';
  const category = categories.find(c => c.id === account.category_id) ?? null;
  const tagList = account.tags.map(id => tags.find(t => t.id === id) ?? { id, name: id });

  const item = detail.data?.items.find(x => x.account_id === account.id) ?? null;
  const ret = returns.data?.items.find(x => x.account_id === account.id) ?? null;

  /**
   * 较上一期（**原币**口径）。`prev_amount` 来自 `/snapshots/:id/returns`，
   * 就是上一期里这个账户的原币金额 —— 缺它时给 null。
   *
   * ⚠ 为什么**不写**「上一期 <日期>」：`prev_amount` 是服务端 `prevItemOf()` 挑出来的，
   *   它的定义是「比本期更早、**且包含这个账户**的最新一张」；而 `dailySeries` 只按快照
   *   日期折叠，不知道某一期里有没有这个账户。两者在「当日多张」或「该账户在紧邻的
   *   那一期缺席」时会挑到**不同的**期 —— 这时前端写出的日期就是假的。
   *   前端手上拿不到真正的基准日期（要拿就得为每个候选期各发一次请求），
   *   所以这里只说明**口径**（原币 / 上次记录），不点名日期。
   */
  const dAmount = item && ret && ret.prev_amount !== null ? item.original_amount - ret.prev_amount : null;

  /* 基准不可用时只给「不可用」这一个结论，不猜原因：可能是账户未跟踪本金、
     当期未填本金、或更早的期里没有这个账户 —— 三种原因都能让 `prev_amount` 为 null，
     在前端凭 `ret.status` 反推到底哪一种，等于把服务端实现细节说成业务事实。 */
  const dNote = dAmount !== null ? '原币 · 上次记录' : '无可用对比基准';

  const retTag = ret ? RETURN_TAG[ret.status] ?? null : null;

  async function doArchive(): Promise<void> {
    if (!account) return;
    if (!writable()) {
      toast('当前是离线数据源（?data=fixture），归档不可用', 'warn');
      return;
    }
    const next = !account.archived;
    try {
      await mutate(ds => ds.send<AccountDTO>('PATCH', `/accounts/${account.id}`, { archived: next }));
      toast(`账户已${next ? '归档' : '取消归档'}：${account.name}`, 'ok');
    } catch (err) {
      toast(`操作失败：${messageOf(err)}`, 'err', 4200);
    }
  }

  async function doDelete(): Promise<void> {
    if (!account || busy) return;
    if (!writable()) {
      toast('当前是离线数据源（?data=fixture），删除不可用', 'warn');
      setAskDelete(false);
      return;
    }
    setBusy(true);
    try {
      await mutate(ds => ds.send('DELETE', `/accounts/${account.id}`));
      toast(`已删除账户：${account.name}`, 'ok');
      onBack();
    } catch (err) {
      toast(`删除失败：${messageOf(err)}`, 'err', 4200);
    } finally {
      setBusy(false);
      setAskDelete(false);
    }
  }

  return (
    <>
      {/* ============ 账户名片 + 操作 ============ */}
      <div className="card" style={{ display: 'flex', alignItems: 'stretch', padding: 0, overflow: 'hidden' }}>
        <span style={{ width: 10, flex: '0 0 10px', background: color, borderRight: '3px solid var(--ink)' }} />
        <div style={{ flex: 1, minWidth: 0, padding: '14px 16px' }}>
          <div className="flex wrap" style={{ gap: 8 }}>
            <span className="acc-ccy" style={{ background: color, height: 28, lineHeight: 24, minWidth: 48 }}>
              {account.currency}
            </span>
            <span style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-0.4px' }}>{account.name}</span>
            <CatBadge name={category ? category.name : '—'} type={account.type} />
            {account.archived ? <span className="badge mute">已归档</span> : null}
            {!account.include_in_net_worth ? <span className="badge warn">不计净值</span> : null}
            <span className="spacer" style={{ flex: 1 }} />
            {/* 操作就在这里 —— 列表页一个按钮都没有 */}
            <button className="btn sm" onClick={() => onEdit(account.id)}>
              编辑
            </button>
            <button className="btn sm" onClick={() => void doArchive()}>
              {account.archived ? '取消归档' : '归档'}
            </button>
            <button className="btn sm danger" onClick={() => setAskDelete(true)}>
              删除
            </button>
          </div>
          <div className="acc-sub" style={{ marginTop: 6 }}>
            {`${platformName} · ${account.type === 'asset' ? '资产' : '负债'}`}
          </div>
          {tagList.length ? (
            <div className="acc-tags" style={{ marginTop: 8 }}>
              <TagBadges tags={tagList} max={8} />
            </div>
          ) : null}
        </div>
      </div>

      {/* ============ 最近一期盘点结果 ============ */}
      <SecTitle>最近一期盘点结果</SecTitle>
      {!last || !item ? (
        <div className="card">
          <Note tone="plain" style={{ margin: 0 }}>
            {last
              ? `该账户没有出现在最新一期快照（${last.date}）里 —— 它可能是新建的，或已从盘点中排除。`
              : '还没有任何快照 —— 完成第一次盘点后，这里会显示这个账户的最近金额与收益。'}
          </Note>
        </div>
      ) : (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: '1.6fr 1fr 1fr', marginBottom: 16 }}>
            <Stat
              tone="hero"
              k={`最近金额 · 原币 ${account.currency}`}
              v={money(item.original_amount, 2, account.currency)}
              d={
                <>
                  {`折 ${base} ${money(item.amount_in_base, 0, false)} · ${last.date}`}
                  {item.is_carried_over ? ' · 沿用上次' : ''}
                </>
              }
            />
            <Stat
              tone="blue"
              k="较上一期"
              v={dAmount !== null ? <Delta v={dAmount} dec={2} cur={account.currency} /> : '—'}
              d={<span className="flat">{dNote}</span>}
            />
            <Stat
              tone="green"
              k="累计收益"
              v={ret && ret.cum !== null ? money(ret.cum, 0, account.currency) : retTag ? retTag.t : '—'}
              d={
                ret && ret.cum_rate !== null ? (
                  <span className="flat">{pctText(ret.cum_rate)}</span>
                ) : (
                  <span className="flat">{account.track_principal ? '累计口径' : '未跟踪本金'}</span>
                )
              }
            />
          </div>

          <div className="card">
            <CardHd title="本期明细" sub={`快照 ${last.date} · 冻结口径，不随设置变化`} />
            <div className="kv" style={{ maxWidth: 520 }}>
              <span className="kk">原币金额</span>
              <span className="vv">{money(item.original_amount, 2, account.currency)}</span>
              <span className="kk">汇率</span>
              <span className="vv">{`${account.currency} ${rateText(item.exchange_rate)}`}</span>
              <span className="kk">{`折 ${base}`}</span>
              <span className="vv">{money(item.amount_in_base, 0)}</span>
              <span className="kk">本期本金</span>
              <span className="vv">
                {item.principal !== null ? money(item.principal, 2, account.currency) : '—'}
              </span>
              <span className="kk">净投入</span>
              <span className="vv">{ret && ret.net_invest !== null ? money(ret.net_invest, 0, account.currency) : '—'}</span>
              <span className="kk">数据来源</span>
              <span className="vv">{item.is_carried_over ? '沿用上次盘点' : '本期填写'}</span>
            </div>
            {!account.track_principal ? (
              <Note tone="plain" style={{ margin: '12px 0 0', fontSize: 11 }}>
                该账户未开启本金跟踪，因此不参与收益统计（市值照常计入净资产）。
              </Note>
            ) : null}
          </div>
        </>
      )}

      {/* ============ 账户档案 ============ */}
      <SecTitle>账户档案</SecTitle>
      <div className="card">
        <div className="kv" style={{ maxWidth: 520 }}>
          <span className="kk">账户 ID</span>
          <span className="vv">{account.id}</span>
          <span className="kk">平台</span>
          <span className="vv">{platformName}</span>
          <span className="kk">分类</span>
          <span className="vv">{category ? category.name : '—'}</span>
          <span className="kk">类型</span>
          <span className="vv">{account.type === 'asset' ? '资产' : '负债'}</span>
          <span className="kk">币种</span>
          <span className="vv">{account.currency}</span>
          <span className="kk">计入净值</span>
          <span className="vv">{account.include_in_net_worth ? '是' : '否'}</span>
          <span className="kk">跟踪本金</span>
          <span className="vv">{account.track_principal ? '是' : '否'}</span>
          <span className="kk">排序</span>
          <span className="vv">{account.sort}</span>
          <span className="kk">创建时间</span>
          <span className="vv">{account.created_at}</span>
          <span className="kk">更新时间</span>
          <span className="vv">{account.updated_at}</span>
          <span className="kk">备注</span>
          <span className="vv">{account.note || '—'}</span>
        </div>
      </div>

      {/* 文案与原型 `delAccount` 逐字符对齐。必须说明「历史快照不受影响」——
          删掉的只是账户定义，历史明细靠冗余字段自洽（PRD 规则 6）。 */}
      {askDelete ? (
        <ConfirmModal
          title="删除账户"
          okText="删除"
          onClose={() => setAskDelete(false)}
          onOk={() => void doDelete()}
          body={
            <>
              {`确定删除 `}
              <b>{account.name}</b>
              {`？`}
              <br />
              <span className="muted small">
                历史快照中的冗余信息（账户名、平台、金额）会保留，不受影响。
              </span>
            </>
          }
        />
      ) : null}
    </>
  );
}
