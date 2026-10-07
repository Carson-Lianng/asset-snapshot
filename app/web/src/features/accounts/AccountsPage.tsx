/**
 * AccountsPage.tsx —— 账户页（PRD §3.2）
 *
 * 数据来源：
 *   账户 / 平台 / 分类 / 标签 / 币种 ← 对应只读端点
 *   「最近金额」                      ← 最新一期快照的明细（/snapshots/:id）
 *   「累计收益」                      ← /snapshots/:id/returns
 *
 * 一处**记录在案的简化**：原型的 recentItemOf 会向更早的快照回溯，
 * 取「该账户最近一次被写入过」的那一期。只读端点里没有等价能力
 * （Step 4 的 `POST /inventory/session` 才有 lastAmounts），
 * 因此这里只在最新一期明细里找；找不到就显示「未盘点」。
 *
 * ============================================================
 * 2026-10-05 视觉迭代：表格 → 资产卡包
 * ============================================================
 * 需求原文：「账户改成资产包的样式，让用户直观感受这是个多币种的钱包。
 * 头部是账户总览，下面是资产卡包（沿用现有的筛选，操作放到下一层页面）」
 *
 * 三处结构性改动：
 *   1. **头部新增账户总览** —— 净资产 / 总资产 / 总负债（取最新一期快照的
 *      冻结汇总列）+ **币种构成条**。币种条才是「多币种钱包」的直接证据：
 *      旧表格里币种只是每行一个 72px 宽的小徽章，扫十行也看不出钱包里有几种钱。
 *   2. **列表由「分组 + 列式行」改为「分组 + 卡片网格」**。金额变成卡上的主角
 *      （原币大字 + 折本位币小字两行），不再是并排的两列。
 *   3. **操作全部下沉** —— 卡内没有任何按钮，整张卡是一个动作：进「账户详情」
 *      （`#account-detail`），编辑 / 归档 / 删除都在那一层。这是需求里
 *      「操作放到下一层页面」的落点。
 *
 * 筛选条**逐字节沿用**（分组 seg / 三个下拉 / 搜索 / 显示已归档 / 标签 chips），
 * 只有两个「列开关」被删除 —— 它们控制的是表格的列，表格没了，语义就不存在了
 * （用户裁决：去掉，卡片固定显示金额与收益）。
 *
 * ⚠ 历史注记：本文件原有一个 `ACC_TEMPLATE` 列模板串 + `ACC_MIN_WIDTH`，
 * 用来解决「表头与内容列位置对不上」（根因是每个 `.arow` 各自成网格、末列写了
 * `auto`，表头 22px vs 数据 124px，差 102px 被 `1.6fr` 吸收 ⇒ 从第三列整体错位）。
 * 改成卡片网格后没有「列」了，两个常量一并删除 —— 那个坑本身仍然成立
 * （见 MEMORY.md 前端约定 16），只是这一页不再踩它。
 *
 * ============================================================
 * 2026-10-05 补上 PRD §3.2.2 的「拖拽排序」
 * ============================================================
 * 此前 `sort` 字段与读序都在，`POST /accounts/reorder` 也在，但**界面上没有任何
 * 调整顺序的入口**，那条 API 全仓没有一处调用。现在做成一个**排序模式**：
 * 工具栏一个入口进入，卡片整张可拖，松手即落库，再点同一个按钮退出。
 *
 * 四个刻意的选择：
 *   1. **拖拽而不是上移/下移按钮**。PRD 写的就是「拖拽排序」，且下面那批卡片是
 *      「整张卡是一个动作」的控件语言，卡内塞两个按钮会立刻破坏它 ——
 *      `verify-pack-ui.mjs` 有一条机械断言：「每张卡内嵌的 `<button>` 数必须是 0」。
 *      排序模式下卡片依然是零按钮（手柄 `≡` 是 `<span>`）。
 *   2. **只允许同一分组内拖拽**。跨组拖到别的折叠块里，语义上等于「把这个账户的
 *      平台/分类改成那一组」，属于**改数据**而不是改顺序 —— 那是编辑表单的事。
 *      所以跨组时既不给落点指示，松手也不生效。
 *   3. **写的是全量 id 顺序**（不是「当前筛选出来的那几张」）。服务端 `reorder()`
 *      只把收到的 id 改写成 1..n，没提到的行保留旧 `sort`、会与新号交错；而本页
 *      的 `accounts` 正是全量（筛选全在前端做，见下面 `groups` 的 useMemo）。
 *   4. **提交后先用本地顺序顶着**（`sortedByOrder` 的第二参数）。`mutate` 是
 *      「写完整体作废」，作废到重新取回之间 `useApi` 交的是上一次成功值 = 旧顺序，
 *      不用本地顺序顶一下就会「先弹回旧序、再跳到新序」。回话落地后由 `accounts`
 *      的引用变化把本地顺序清掉。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  /* React 的合成指针事件与 DOM 的 `PointerEvent` 同名不同物：窗口监听器那里要的是
     DOM 那个（`e.clientX` 直接可用），卡上的 `onPointerDown` 要的是 React 那个。
     两个都留着、各自起名，避免写成一个「看起来通用、其实类型不对」的注解。 */
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import type { AccountDTO, CategoryDTO, PlatformDTO, SnapshotDTO, SnapshotSummaryDTO, TagDTO } from '@app/shared';
import { ep, mutate, useApi, writable } from '../../api/index.ts';
import { messageOf } from '../../api/problem.ts';
import { currencyColorOf } from '../../lib/palette.ts';
import { getBaseCurrency, money, pctText } from '../../lib/money.ts';
import { moveId, sortedByOrder, type DropPos } from '../../lib/reorder.ts';
import { dailySeries, lastSnapshot } from '../../lib/series.ts';
import { CatBadge, EmptyState, Stat, TagBadges } from '../../components/Atoms.tsx';
import { Delta } from '../../components/Delta.tsx';
import { Collapse } from '../../components/Collapse.tsx';
import { useToast } from '../../components/Toast.tsx';
import { RETURN_TAG, useUi, type AccGroup, type AccFilter } from '../../state/ui.tsx';

/** 拖拽落点：目标卡片 id + 插到它之前还是之后 */
interface DropTarget {
  id: string;
  pos: DropPos;
}

/**
 * 命中测试：屏幕坐标落在哪张卡上、插到它之前还是之后。
 *
 * 用 `elementFromPoint` 拿不到「左半 / 右半」，所以这里遍历卡片矩形自己判：
 * 指针在卡片**水平中线左侧** ⇒ 插到它之前，右侧 ⇒ 之后（网格是多列的，
 * 用纵向中线判会在同一行内来回跳）。
 *
 * 三种情况一律返回 null（= 当前没有合法落点）：
 *   · 坐标不在任何卡上；
 *   · 落点就是被拖的那张自己；
 *   · 落点在**别的折叠块**里 —— 跨组拖拽语义上等于改平台/分类，不做（见文件头）。
 *
 * `root` 传 `.acc-pack` 元素本身（而不是写死 `#view-accounts`）：
 * 组件不该知道自己被挂在哪个容器 id 下，写死了容器一改名这里就静默失效。
 */
function hitTest(root: HTMLElement, x: number, y: number, dragId: string): DropTarget | null {
  const src = root.querySelector(`.acc-card[data-acc="${CSS.escape(dragId)}"]`);
  const srcGroup = src ? src.closest('.collapse-block') : null;
  const cards = [...root.querySelectorAll('.acc-card')];
  for (const el of cards) {
    const b = el.getBoundingClientRect();
    if (x < b.left || x > b.right || y < b.top || y > b.bottom) continue;
    if (el === src) return null;
    if ((el.closest('.collapse-block') ?? null) !== srcGroup) return null;
    return { id: el.getAttribute('data-acc') ?? '', pos: x < b.left + b.width / 2 ? 'a' : 'b' };
  }
  return null;
}

interface ItemReturnLike {
  account_id: string;
  status: keyof typeof RETURN_TAG;
  cum: number | null;
  cum_rate: number | null;
}

export function AccountsPage({
  accounts,
  platforms,
  categories,
  tags,
  snapshotList,
  onOpenAccount,
  onOpenAccountDetail
}: {
  accounts: readonly AccountDTO[];
  platforms: readonly PlatformDTO[];
  categories: readonly CategoryDTO[];
  tags: readonly TagDTO[];
  snapshotList: readonly SnapshotSummaryDTO[];
  /** 「新增账户」——空态里的 CTA 与顶栏按钮共用同一个入口（`null` = 新建） */
  onOpenAccount: (id: string | null) => void;
  /** 点整张卡 → 下一层「账户详情」。编辑 / 归档 / 删除都在那一层 */
  onOpenAccountDetail: (id: string) => void;
}) {
  const { ui, patch } = useUi();
  const toast = useToast();
  const base = getBaseCurrency();
  const last = lastSnapshot(snapshotList);
  const lastId = last?.id ?? null;

  /* ---- 排序模式的本地状态 ----
     ⚠ 刻意**不放进 UiState**：它是「正在整理顺序」这一动作的临时态，
     离开这一页就该结束。放进 UiState 会跟着视图切换活下来（那套状态是
     刻意跨页保留的），回到账户页会莫名其妙还是排序态。 */
  const [sortMode, setSortMode] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  /** 指针抬起时读的那一份落点。state 只服务渲染，提交必须读这个 ref —— 见下面的注释 */
  const dropRef = useRef<DropTarget | null>(null);
  /** 提交后的本地顺序（等服务端回话落地即弃）。理由见文件头第 4 条 */
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const packRef = useRef<HTMLDivElement | null>(null);

  const detail = useApi<SnapshotDTO>(lastId ? ep.snapshot(lastId, 'origin') : null);
  const itemReturns = useApi<{ items: ItemReturnLike[] }>(lastId ? ep.snapshotReturns(lastId) : null);

  const P = useMemo(() => new Map(platforms.map(p => [p.id, p])), [platforms]);
  const C = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);
  const T = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags]);
  const retByAccount = useMemo(() => {
    const m = new Map<string, ItemReturnLike>();
    for (const r of itemReturns.data?.items ?? []) m.set(r.account_id, r);
    return m;
  }, [itemReturns.data]);
  const itemByAccount = useMemo(() => {
    const m = new Map<string, SnapshotDTO['items'][number]>();
    for (const it of detail.data?.items ?? []) m.set(it.account_id, it);
    return m;
  }, [detail.data]);

  /* ---- 账户总览的取数 ----
     「较上期」用**当日折叠序列**的相邻两期（与首页同一口径，见 lib/series.ts）：
     同一天有多张快照时，只有当日最后一张参与比较。 */
  const daily = dailySeries(snapshotList);
  const prevDaily = daily.length >= 2 ? daily[daily.length - 2] : null;
  const dNw = last && prevDaily ? last.net_worth - prevDaily.net_worth : null;
  const dNwRate = dNw !== null && prevDaily && prevDaily.net_worth !== 0 ? dNw / Math.abs(prevDaily.net_worth) : null;

  /**
   * 币种构成（未归档账户）。
   *
   * 口径刻意用「未归档」：已归档的账户是**封存的钱包**，把它们算进「钱包里有
   * 几种钱」会让这个数字随历史沉积越来越大。这里也与卡片列表的默认视图一致
   * （`显示已归档` 不勾选时看到的正是这一批）。
   * 不随筛选条变化 —— 它是页面级总览，跟着筛选跳会让人以为总览也是筛选结果。
   */
  const byCurrency = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) if (!a.archived) m.set(a.currency, (m.get(a.currency) ?? 0) + 1);
    return [...m.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  }, [accounts]);
  const liveCount = useMemo(() => accounts.filter(a => !a.archived).length, [accounts]);

  const { list, groups, groupOrder, nameOf } = useMemo(() => {
    const q = ui.accQuery.trim().toLowerCase();
    let arr = [...accounts];
    const f = ui.accFilter;
    if (f.platform) arr = arr.filter(a => (a.platform_id || 'none') === f.platform);
    if (f.category) arr = arr.filter(a => a.category_id === f.category);
    if (f.currency) arr = arr.filter(a => a.currency === f.currency);
    if (f.tag) arr = arr.filter(a => a.tags.includes(f.tag as string));
    if (!f.archived) arr = arr.filter(a => !a.archived);
    if (q) {
      arr = arr.filter(a =>
        `${a.name} ${P.get(a.platform_id ?? '')?.name ?? ''} ${C.get(a.category_id)?.name ?? ''}`
          .toLowerCase()
          .includes(q)
      );
    }

    const keyOf = (a: AccountDTO) =>
      ui.accGroup === 'platform' ? a.platform_id || 'none' : ui.accGroup === 'currency' ? a.currency : a.category_id;
    const name = (k: string) =>
      ui.accGroup === 'platform'
        ? k === 'none'
          ? '未指定平台'
          : P.get(k)?.name ?? k
        : ui.accGroup === 'currency'
          ? k
          : C.get(k)?.name ?? k;

    const map = new Map<string, AccountDTO[]>();
    const order: string[] = [];
    for (const a of sortedByOrder(arr, localOrder)) {
      const k = keyOf(a);
      if (!map.has(k)) {
        map.set(k, []);
        order.push(k);
      }
      map.get(k)!.push(a);
    }
    return { list: arr, groups: map, groupOrder: order, nameOf: name };
  }, [accounts, ui.accQuery, ui.accFilter, ui.accGroup, P, C, localOrder]);

  const setFilter = (k: keyof AccFilter, v: string | boolean | undefined) =>
    patch({ accFilter: { ...ui.accFilter, [k]: v } });

  /* ============================================================
     拖拽排序
     ============================================================ */

  /**
   * 当前**显示**次序的 id 全量 —— 排序写的就是它（理由见文件头第 3 条）。
   *
   * ⚠ 取「显示次序」而不是「服务端次序」：写完到重新取回之间 `accounts` 还是旧的，
   * 若用旧的当基准，这个窗口里再拖一次就会把上一步的结果一起写丢。
   * 显示次序（`localOrder`）里已经含了上一步，两次拖拽能叠加。
   */
  const globalIds = useMemo(() => sortedByOrder(accounts, localOrder).map(a => a.id), [accounts, localOrder]);

  /**
   * 落库之后服务端会重新取一遍 `accounts`，那一份数据的引用是新的 ⇒ 在这里
   * 把本地顺序交还给它。放在 effect 里而不是「提交成功回调里清」：回调只代表
   * 我们没写失败，界面真正变得可信是**新数据到达**那一刻。
   */
  useEffect(() => {
    setLocalOrder(null);
  }, [accounts]);

  function commitDrop(dragId: string, targetId: string, pos: DropPos): void {
    const next = moveId(globalIds, dragId, targetId, pos);
    if (next.join('\u0000') === globalIds.join('\u0000')) return; // 落点没产生变化
    setLocalOrder(next);
    void (async () => {
      try {
        await mutate(ds => ds.send('POST', '/accounts/reorder', { ids: next }));
        toast('顺序已保存', 'ok');
      } catch (err) {
        setLocalOrder(null);
        toast(`排序失败：${messageOf(err)}`, 'err', 4200);
      }
    })();
  }

  /**
   * 拖拽期间的监听器挂在 window 上：指针移出卡片、移出折叠块甚至移出网格都
   * 要能继续跟。依赖只有 `[sortMode, draggingId]` —— **整个拖拽过程只订阅一次**，
   * 所以提交函数经 ref 取「最新那一份」，否则闭包里会是开始拖拽那一刻的
   * `globalIds`（拖到一半改了顺序就会写丢）。
   */
  const commitRef = useRef(commitDrop);
  useEffect(() => {
    commitRef.current = commitDrop;
  });

  useEffect(() => {
    if (!sortMode || !draggingId) return;
    const onMove = (e: PointerEvent): void => {
      const root = packRef.current;
      const t = root ? hitTest(root, e.clientX, e.clientY, draggingId) : null;
      dropRef.current = t;
      /* 落点没变就把旧对象原样还回去 —— React 按引用比较，返回同一个引用不重渲染 */
      setDropTarget(prev => (prev && t && prev.id === t.id && prev.pos === t.pos ? prev : t));
    };
    const onUp = (): void => {
      const t = dropRef.current;
      dropRef.current = null;
      setDropTarget(null);
      setDraggingId(null);
      if (t) commitRef.current(draggingId, t.id, t.pos);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [sortMode, draggingId]);

  function toggleSort(): void {
    if (sortMode) {
      setSortMode(false);
      return;
    }
    /* 离线源拦在这里而不是把按钮置灰：离线下的控件仍然可点、点了给一句话，
       与详情页的归档 / 删除同一套（置灰会让人以为「这个功能不存在」）。 */
    if (!writable()) {
      toast('当前是离线数据源（?data=fixture），排序不可用', 'warn');
      return;
    }
    setSortMode(true);
  }

  const groupOptions: Array<{ value: AccGroup; label: string }> = [
    { value: 'platform', label: '按平台' },
    { value: 'currency', label: '按币种' },
    { value: 'category', label: '按分类' }
  ];

  return (
    <>
      {/* ============ 头部 · 账户总览 ============ */}
      <div style={{ marginBottom: 16 }}>
        <div className="stat-grid" style={{ gridTemplateColumns: '1.7fr 1fr 1fr' }}>
          <Stat
            tone="hero"
            k={`当前净资产 · ${base}`}
            v={last ? money(last.net_worth) : '—'}
            d={
              last ? (
                prevDaily ? (
                  <>
                    {'较上期 '}
                    <Delta v={dNw} dec={0} />
                    {`（${pctText(dNwRate)}）`}
                  </>
                ) : (
                  <span className="flat">首次快照，无可比期</span>
                )
              ) : (
                <span className="flat">还没有快照</span>
              )
            }
          />
          <Stat
            tone="blue"
            k="总资产"
            v={last ? money(last.total_assets, 0) : '—'}
            d={<span className="flat">{`折 ${base}`}</span>}
          />
          <Stat
            tone="pink"
            k="总负债"
            v={last ? money(last.total_liabilities, 0) : '—'}
            d={<span className="flat">{`折 ${base}`}</span>}
          />
        </div>

        {/* 币种构成条 —— 「这是个多币种的钱包」最直接的一眼证据 */}
        <div className="acc-curbar">
          <span className="panel-hint">{`币种 ${byCurrency.length} 种`}</span>
          {byCurrency.map(([code, n]) => (
            <span key={code} className="acc-curchip" style={{ background: currencyColorOf(code) }}>
              {`${code} × ${n}`}
            </span>
          ))}
        </div>

        <div className="acc-ov-meta">
          {last
            ? `口径：最新一期快照 ${last.date}（共 ${snapshotList.length} 期）`
            : '还没有快照 —— 完成第一次盘点后这里会显示净资产'}
          {` · 币种构成按未归档账户（${liveCount} 个）统计`}
        </div>
      </div>

      {/* ============ 筛选条（沿用现有） ============ */}
      <div className="toolbar">
        <div className="seg">
          {groupOptions.map(o => (
            <button
              key={o.value}
              className={ui.accGroup === o.value ? 'on' : ''}
              onClick={() => patch({ accGroup: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>

        <select
          className="inp"
          style={{ width: 'auto' }}
          value={ui.accFilter.platform ?? ''}
          onChange={e => setFilter('platform', e.target.value)}
        >
          <option value="">全部平台</option>
          <option value="none">未指定平台</option>
          {platforms.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          className="inp"
          style={{ width: 'auto' }}
          value={ui.accFilter.category ?? ''}
          onChange={e => setFilter('category', e.target.value)}
        >
          <option value="">全部分类</option>
          {categories.map(c => (
            <option key={c.id} value={c.id}>
              {c.type === 'asset' ? '资产' : '负债'} · {c.name}
            </option>
          ))}
        </select>

        <select
          className="inp"
          style={{ width: 'auto' }}
          value={ui.accFilter.currency ?? ''}
          onChange={e => setFilter('currency', e.target.value)}
        >
          <option value="">全部币种</option>
          {currenciesOf(accounts).map(code => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>

        <div className="searchbox">
          <input
            placeholder="搜索账户 / 平台"
            value={ui.accQuery}
            onChange={e => patch({ accQuery: e.target.value })}
          />
          <button onClick={() => patch({ accQuery: '' })}>×</button>
        </div>

        <label className="chk">
          <input
            type="checkbox"
            checked={!!ui.accFilter.archived}
            onChange={e => setFilter('archived', e.target.checked)}
          />
          显示已归档
        </label>

        {/* 排序入口。放在工具栏这一层、**不进卡片** —— 卡片内是零按钮的（见文件头） */}
        <button
          className={'btn sm' + (sortMode ? ' pri' : '')}
          onClick={toggleSort}
          title="拖动卡片调整账户顺序"
        >
          {sortMode ? '✓ 完成排序' : '⇅ 排序'}
        </button>
      </div>

      <div className="toolbar" style={{ marginTop: -6 }}>
        <span className="panel-hint">标签筛选：</span>
        <div className="chips">
          <button className={'chip ' + (!ui.accFilter.tag ? 'on' : '')} onClick={() => setFilter('tag', '')}>
            全部
          </button>
          {tags.map(t => (
            <button
              key={t.id}
              className={'chip ' + (ui.accFilter.tag === t.id ? 'on' : '')}
              onClick={() => setFilter('tag', t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {/* ============ 资产卡包 ============ */}
      {!list.length ? (
        <div className="card">
          <EmptyState
            icon="▤"
            title="没有匹配的账户"
            desc="换个筛选条件，或新建一个账户。"
            action={
              <button className="btn pri" onClick={() => onOpenAccount(null)}>
                ＋ 新增账户
              </button>
            }
          />
        </div>
      ) : (
        <div className={'acc-pack' + (sortMode ? ' sorting' : '')} ref={packRef}>
          {sortMode ? (
            <div className="sort-bar">
              <span>拖动整张卡片调整位置</span>
              <span className="sort-sep">·</span>
              <span>仅限同一分组内</span>
              <span className="sort-sep">·</span>
              <span>松手即保存，顺序对所有账户生效</span>
            </div>
          ) : null}
          {groupOrder.map(k => {
            const arr = groups.get(k)!;
            const sumAsset = arr
              .filter(a => a.type === 'asset')
              .reduce((s, a) => s + (itemByAccount.get(a.id)?.amount_in_base ?? 0), 0);
            const sumLiab = arr
              .filter(a => a.type === 'liability')
              .reduce((s, a) => s + (itemByAccount.get(a.id)?.amount_in_base ?? 0), 0);
            return (
              <Collapse
                key={k}
                header={
                  <>
                    <span>{nameOf(k)}</span>
                    <span className="badge cur">{arr.length} 个</span>
                    <span className="spacer" style={{ flex: 1 }} />
                    <span className="mono tiny muted">
                      资产 {money(sumAsset, 0)} · 负债 {money(sumLiab, 0)}
                    </span>
                  </>
                }
              >
                <div className="acc-grid">
                  {arr.map(a => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      category={C.get(a.category_id) ?? null}
                      platformName={a.platform_id ? P.get(a.platform_id)?.name ?? '未指定平台' : '未指定平台'}
                      tags={a.tags.map(id => T.get(id) ?? { id, name: id })}
                      item={itemByAccount.get(a.id) ?? null}
                      snapshotDate={detail.data?.date ?? null}
                      ret={retByAccount.get(a.id) ?? null}
                      base={base}
                      sorting={sortMode}
                      dragging={draggingId === a.id}
                      drop={dropTarget && dropTarget.id === a.id ? dropTarget.pos : null}
                      onGrab={e => {
                        /* 阻止默认行为：不这样做，拖到卡上的文字会被选中（原生选择区） */
                        e.preventDefault();
                        setDraggingId(a.id);
                      }}
                      onOpen={() => onOpenAccountDetail(a.id)}
                    />
                  ))}
                </div>
              </Collapse>
            );
          })}
        </div>
      )}
    </>
  );
}

/** 币种筛选下拉：原型用的是 DB.currencies（含未启用），这里从账户并集推导等价集合 */
function currenciesOf(accounts: readonly AccountDTO[]): string[] {
  const seen = new Set<string>();
  for (const a of accounts) seen.add(a.currency);
  return [...seen].sort();
}

/**
 * 一张账户卡。整张是 `<button>` —— 卡上没有任何操作按钮，点它进下一层。
 *
 * 排序模式下同一个元素换三个身份：`data-acc` 供命中测试认出它、`onPointerDown`
 * 起拖、`onClick` 摘掉（拖完松手不该顺手跳进详情页）。**它仍然是零按钮的卡**，
 * 手柄 `≡` 是 `<span>`；`.acc-card-go` 与 `.acc-grip` 只是互斥的两个指示符。
 *
 * ⚠ 用 `<span>` 而不是 `<div>` 承载内部结构：`<button>` 的内容模型是
 * 「短语内容」，`div` 在里面属于非法嵌套。`.acc-card-body` 是 flex 列，
 * 它的直接子元素会被块级化，所以 `margin-top` 这类垂直间距照常生效。
 */
function AccountCard({
  account: a,
  category: c,
  platformName,
  tags,
  item,
  snapshotDate,
  ret,
  base,
  sorting,
  dragging,
  drop,
  onGrab,
  onOpen
}: {
  account: AccountDTO;
  category: CategoryDTO | null;
  platformName: string;
  tags: Array<{ id: string; name: string }>;
  item: SnapshotDTO['items'][number] | null;
  snapshotDate: string | null;
  ret: ItemReturnLike | null;
  base: string;
  /** 排序模式：整卡可拖、不导航 */
  sorting: boolean;
  /** 正在被拖的是这一张 */
  dragging: boolean;
  /** 落点指示：`a` 插到这张之前、`b` 之后；`null` = 它现在不是落点 */
  drop: DropPos | null;
  onGrab: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onOpen: () => void;
}) {
  const color = currencyColorOf(a.currency);

  /* 收益行。非跟踪本金的账户显示「未跟踪本金」而不是「—」——
     两者含义不同：前者是**配置**，后者是**数据缺失**（RETURN_TAG 的五个态同理）。 */
  let retBody: ReactNode;
  if (!a.track_principal) {
    retBody = '未跟踪本金';
  } else if (ret && ret.cum !== null) {
    retBody = (
      <>
        {`累计收益 ${money(ret.cum, 0, a.currency)}`}
        {ret.cum_rate !== null ? `（${pctText(ret.cum_rate)}）` : ''}
      </>
    );
  } else {
    retBody = ret ? (RETURN_TAG[ret.status]?.t ?? '—') : '—';
  }

  return (
    <button
      type="button"
      className={'acc-card' + (dragging ? ' dragging' : '') + (drop ? ` drop-${drop}` : '')}
      data-acc={a.id}
      onClick={sorting ? undefined : onOpen}
      onPointerDown={sorting ? onGrab : undefined}
      title={sorting ? `拖动「${a.name}」调整顺序` : `查看 ${a.name} 的详情`}
    >
      <span className="acc-card-band" style={{ background: color }} />
      <span className="acc-card-body">
        <span className="acc-top">
          <span className="acc-ccy" style={{ background: color }}>
            {a.currency}
          </span>
          <CatBadge name={c ? c.name : '—'} type={a.type} />
          <span className="spacer" style={{ flex: 1 }} />
          {a.archived ? <span className="badge mute">已归档</span> : null}
          {!a.include_in_net_worth ? <span className="badge warn">不计净值</span> : null}
          {/* 同一个位置的两种含义：平时是「点得进去」的凭据（`›`），
              排序模式下换成「拖得动」的凭据（`≡`）—— 位置共用顶行最右端，
              理由：右下角被「折 CNY …」这行文字占着，硬挤会读成「…¥12,345 ›」。 */}
          {sorting ? (
            <span className="acc-grip" aria-hidden="true">
              ≡
            </span>
          ) : (
            <span className="acc-card-go" aria-hidden="true">
              ›
            </span>
          )}
        </span>

        <span className="acc-nm">{a.name}</span>
        <span className="acc-sub">{platformName}</span>

        <span className="acc-amt">
          {item ? money(item.original_amount, 2, a.currency) : <span className="muted">未盘点</span>}
        </span>
        <span className="acc-foot">
          {item ? (
            <>
              {`折 ${base} ${money(item.amount_in_base, 0, false)} · ${snapshotDate ?? '—'}`}
              {item.is_carried_over ? ' · 沿用' : ''}
            </>
          ) : (
            '—'
          )}
        </span>

        {tags.length ? (
          <span className="acc-tags">
            <TagBadges tags={tags} max={3} />
          </span>
        ) : null}

        <span className="acc-ret">{retBody}</span>
      </span>
    </button>
  );
}
