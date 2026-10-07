/**
 * App.tsx —— 外壳：侧栏 + 顶栏 + 当前视图
 *
 * DOM 与原型一致：`.sidebar` 与 `.main > (.topbar + section.view)` 并列。
 * 顶栏的标题 / 面包屑 / 操作按钮由这里按路由推导 —— 原型是用
 * `$('#pgTitle').textContent = ...` 逐个赋值的，语义相同但不依赖渲染顺序。
 *
 * Step 4 起写路径已接通：账户新增/编辑弹窗与标签管理弹窗挂在这里（顶栏与账户页
 * 共用同一入口，见 `acctEdit` / `tagOpen`）。
 * Step 5 起顶栏的「导出全量备份 / 导出备份」也是真的导出（走 `lib/download.ts`）——
 * `notYet` 这个占位通道至此全部退场，界面上不再有「点了只给提示」的按钮。
 * 按钮文字与位置一字未动，所以基准截图不受影响。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AccountDTO,
  CategoryDTO,
  CurrencyDTO,
  GoLiveResultDTO,
  PlatformDTO,
  SettingsDTO,
  SnapshotSummaryDTO,
  TagDTO
} from '@app/shared';
import { ep, mutate, useApi, writable } from './api/index.ts';
import { messageOf } from './api/problem.ts';
import { downloadFile } from './lib/download.ts';
import { setBaseCurrency, setCurrencyTable } from './lib/money.ts';
import { lastSnapshot } from './lib/series.ts';
import { useRoute, setHash, type View, type RouteOpts } from './router.ts';
import { UiProvider, useUi } from './state/ui.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { ConfirmModal } from './components/Modal.tsx';
import { ToastProvider, useToast } from './components/Toast.tsx';
import { HomePage } from './features/home/HomePage.tsx';
import { AccountsPage } from './features/accounts/AccountsPage.tsx';
import { AccountDetailPage } from './features/accounts/AccountDetailPage.tsx';
import { AccountModal } from './features/accounts/AccountModal.tsx';
import { SnapshotsListPage } from './features/snapshots/SnapshotsListPage.tsx';
import { SnapshotDetailPage } from './features/snapshots/SnapshotDetailPage.tsx';
import { ComparePage } from './features/snapshots/ComparePage.tsx';
import { ReportsPage } from './features/reports/ReportsPage.tsx';
import { SettingsPage } from './features/settings/SettingsPage.tsx';
import { TagModal } from './features/settings/TagModal.tsx';
import { InventoryPage } from './features/inventory/InventoryPage.tsx';
import { HelpPage } from './features/help/HelpPage.tsx';

interface ListResponse<T> {
  items: T[];
}

export function App() {
  return (
    <ToastProvider>
      <UiProvider>
        <Shell />
      </UiProvider>
    </ToastProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { ui, patch } = useUi();
  const toast = useToast();

  /* ---- 外壳级数据（与 Step 2 的只读端点一一对应） ---- */
  const settings = useApi<SettingsDTO>(ep.settings());
  const currencies = useApi<ListResponse<CurrencyDTO>>(ep.currencies(true));
  const platforms = useApi<ListResponse<PlatformDTO>>(ep.platforms(true));
  const categories = useApi<ListResponse<CategoryDTO>>(ep.categories(true));
  const tags = useApi<ListResponse<TagDTO>>(ep.tags(true));
  const accounts = useApi<ListResponse<AccountDTO>>(ep.accounts());
  const snapshots = useApi<ListResponse<SnapshotSummaryDTO>>(ep.snapshots());

  /* 币种符号表供 money() 显示 ¥ / $ / HK$ …；本位币供各处文案与折算上下文使用。
     两者都是模块级 memo 表，在渲染期赋值与 fixture 的同步取数语义一致。 */
  if (settings.data) setBaseCurrency(settings.data.base_currency);
  if (currencies.data && settings.data) {
    setCurrencyTable(currencies.data.items, settings.data.base_currency);
  }

  const base = settings.data?.base_currency ?? 'CNY';
  const snapshotList = snapshots.data?.items ?? [];
  const last = lastSnapshot(snapshotList);

  /* 快照详情看的是哪一期：显式选择优先，否则最新一期 */
  const snapSel = ui.snapSel ?? last?.id ?? null;
  const selectedSnap = snapshotList.find(s => s.id === snapSel) ?? null;

  /* 账户详情看的是哪一个：显式选择优先，否则第一个（与 snapSel 的回退同构）。
     `#account-detail` 是裸深链、不带 id，所以必须有回退，否则刷新就落在空页上。 */
  const accountList = accounts.data?.items ?? [];
  const accSel = ui.accSel ?? accountList[0]?.id ?? null;
  const selectedAccount = accountList.find(a => a.id === accSel) ?? null;

  /* 盘点会话：每次「开始盘点」换 key 重挂，等价于原型的 invFresh()。
     步骤本身写进 hash，因此深链与顶栏文案都以 route.invStep 为准。 */
  const [invSession, setInvSession] = useState(0);

  /* 账户弹窗：`null` = 未打开；`{ id: null }` = 新建；`{ id }` = 编辑。
     挂在 Shell 是因为两个入口分处两棵子树（顶栏按钮 / 账户页行内按钮），
     与本项目所有其它弹窗不同 —— 那些只有页面内一个入口，就地渲染即可。 */
  const [acctEdit, setAcctEdit] = useState<{ id: string | null } | null>(null);
  const openAccount = useCallback((id: string | null) => setAcctEdit({ id }), []);

  /* 标签管理弹窗：入口只在账户页顶栏，但状态同样放在 Shell —— 按钮由 App 渲染 */
  const [tagOpen, setTagOpen] = useState(false);
  const openTags = useCallback(() => setTagOpen(true), []);

  const startInventory = useCallback(() => {
    setInvSession(n => n + 1);
    setHash('inventory');
  }, []);

  const navigate = useCallback((view: View, opts?: RouteOpts) => {
    setHash(view, opts);
  }, []);

  /* 视图切换后把主滚动容器归零。
     `accMode` 也在依赖里：账户列表滚到底再点开详情时，详情页要回到顶部
     （详情与列表共用一个 `.view`，不换组件子树就不会自己滚回去）。 */
  useEffect(() => {
    const main = document.getElementById('main');
    if (main) main.scrollTop = 0;
  }, [route.view, route.snapMode, route.accMode, route.invStep]);

  /**
   * 顶栏的「导出全量备份 / 导出备份」。
   *
   * Step 5 起它是**真的导出** —— 与设置页的导出按钮共用同一个 `downloadFile`，
   * 所以不存在「顶栏导出的和设置页导出的不是一回事」。
   */
  const exportFull = useCallback(async () => {
    try {
      const name = await downloadFile('/export/full', 'asset-snapshot.json', 'application/json');
      toast(`已开始下载 ${name}`, 'ok', 3200);
    } catch (err) {
      toast(messageOf(err), 'err', 4200);
    }
  }, [toast]);

  /* ---- 演示模式 ----
     两个条件**都要**成立才提示：
       · `writable` —— 离线 fixture（`?data=fixture`）里没有真库可切，
         「开始正式记账」在那儿按下去只会抛只读错误。顺带也保证 Step 3 的
         外观基准不受影响（截图全部走 fixture）。
       · `data_mode === 'demo'` —— 库确实是演示数据。缺这个字段时按 `live` 处理，
         所以老库不会平白冒出一条提示（详由见服务端 `db/seed.ts` 的 `getDataMode`）。 */
  const demoMode = writable() && settings.data?.data_mode === 'demo';
  const [askGoLive, setAskGoLive] = useState(false);

  /**
   * 清空演示数据、开始记自己的账。
   *
   * 服务端会**独立地再判一次** `data_mode`（不是 `demo` 就 409），所以这里
   * 不是唯一的门 —— 界面藏按钮、服务端拒绝，两道各自成立。
   */
  const doGoLive = useCallback(async () => {
    try {
      const res = await mutate(ds => ds.send<GoLiveResultDTO>('POST', '/go-live'));
      toast(
        `已清空 ${res.cleared.accounts} 个账户与 ${res.cleared.snapshots} 期快照（演示数据），` +
          '币种 / 平台 / 分类等字典已保留。现在可以开始记你自己的账了。',
        'ok',
        7000
      );
    } catch (err) {
      toast(`切换失败：${messageOf(err)}`, 'err', 4600);
    }
  }, [toast]);

  const chrome = useMemo(
    () =>
      buildChrome({
        route,
        base,
        accounts: accounts.data?.items ?? [],
        platforms: platforms.data?.items ?? [],
        snapshotList,
        selectedSnap,
        selectedAccount,
        settings: settings.data,
        onNavigate: navigate,
        onStartInventory: startInventory,
        onOpenAccount: openAccount,
        onOpenTags: openTags,
        onExportFull: exportFull
      }),
    [
      route,
      base,
      accounts.data,
      platforms.data,
      snapshotList,
      selectedSnap,
      selectedAccount,
      settings.data,
      navigate,
      startInventory,
      openAccount,
      openTags,
      exportFull
    ]
  );

  /* ---- 当前视图 ---- */
  let page: ReactNode;
  if (route.view === 'home') {
    page = (
      <HomePage
        snapshotList={snapshotList}
        onNavigate={navigate}
        onStartInventory={startInventory}
        onOpenSnapshot={id => {
          patch({ snapSel: id, snapTab: 'platform' });
          navigate('snapshots', { snapMode: 'detail' });
        }}
      />
    );
  } else if (route.view === 'accounts') {
    if (route.accMode === 'detail') {
      /* 下一层：账户详情。编辑走 Shell 的弹窗，归档 / 删除在页内 —— 这是
         「操作放到下一层页面」的落点。 */
      page = (
        <AccountDetailPage
          accountId={accSel}
          accounts={accountList}
          platforms={platforms.data?.items ?? []}
          categories={categories.data?.items ?? []}
          tags={tags.data?.items ?? []}
          snapshotList={snapshotList}
          onEdit={id => openAccount(id)}
          onBack={() => navigate('accounts')}
        />
      );
    } else {
      page = (
        <AccountsPage
          accounts={accountList}
          platforms={platforms.data?.items ?? []}
          categories={categories.data?.items ?? []}
          tags={tags.data?.items ?? []}
          snapshotList={snapshotList}
          onOpenAccount={openAccount}
          onOpenAccountDetail={id => {
            patch({ accSel: id });
            navigate('accounts', { accMode: 'detail' });
          }}
        />
      );
    }
  } else if (route.view === 'snapshots') {
    if (route.snapMode === 'detail') {
      page = (
        <SnapshotDetailPage
          snapshotId={snapSel}
          snapshotList={snapshotList}
          /* 删完必须回列表：留在详情页会指向一张已经不存在的快照。
             顺带清掉 snapSel，否则下一次进详情会先落在一个空选中上。 */
          onDeleted={() => {
            patch({ snapSel: null });
            navigate('snapshots', { snapMode: 'list' });
          }}
        />
      );
    } else if (route.snapMode === 'compare') {
      page = <ComparePage snapshotList={snapshotList} />;
    } else {
      page = (
        <SnapshotsListPage
          snapshotList={snapshotList}
          onStartInventory={startInventory}
          onOpenSnapshot={(id: string) => {
            patch({ snapSel: id, snapTab: 'platform' });
            navigate('snapshots', { snapMode: 'detail' });
          }}
        />
      );
    }
  } else if (route.view === 'reports') {
    page = <ReportsPage snapshotList={snapshotList} onStartInventory={startInventory} />;
  } else if (route.view === 'settings') {
    page = (
      <SettingsPage
        settings={settings.data}
        platforms={platforms.data?.items ?? []}
        categories={categories.data?.items ?? []}
        tags={tags.data?.items ?? []}
        accounts={accounts.data?.items ?? []}
        snapshotList={snapshotList}
      />
    );
  } else if (route.view === 'help') {
    /* 使用手册：不依赖任何服务端数据（纯静态内容），离线 fixture 下同样能读。
       目录点选走 hash（`#help?sec=…`），因此前进/后退与分享深链都成立。 */
    page = <HelpPage sec={route.helpSec} onPick={sec => navigate('help', { helpSec: sec })} />;
  } else {
    page = (
      <InventoryPage
        key={invSession}
        step={route.invStep}
        onStepChange={s => setHash('inventory', { invStep: s })}
        accounts={accounts.data?.items ?? []}
        platforms={platforms.data?.items ?? []}
        snapshotList={snapshotList}
        onNavigate={navigate}
        onOpenSnapshot={id => {
          patch({ snapSel: id, snapTab: 'platform' });
          navigate('snapshots', { snapMode: 'detail' });
        }}
        /* 「与上期对比」：本期是刚保存的这一张，基准是比它更早的最新一张。
           预设好两侧的选择，用户落地即见结果，不必自己在下拉里挑两次。 */
        onCompare={id => {
          const me = snapshotList.find(s => s.id === id);
          const earlier = me
            ? [...snapshotList].filter(s => s.date < me.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0]
            : undefined;
          patch({ cmpA: earlier?.id ?? null, cmpB: id, cmpMode: 'origin', cmpTab: 'account' });
          navigate('snapshots', { snapMode: 'compare' });
        }}
      />
    );
  }

  return (
    <>
      <Sidebar
        activeView={route.view}
        snapshots={snapshotList}
        accountCount={accounts.data?.items.length ?? 0}
        onNavigate={navigate}
        onStartInventory={startInventory}
      />
      <main className="main" id="main">
        <div className="topbar">
          <div>
            <h1 id="pgTitle">{chrome.title}</h1>
            <div className="crumb" id="pgCrumb">
              {chrome.crumb}
            </div>
          </div>
          <div className="spacer" />
          <div className="flex" style={{ gap: 8 }} id="topActions">
            {chrome.actions}
          </div>
        </div>
        {demoMode ? (
          <div className="demo-notice" id="demoNotice">
            <span className="badge warn">演示数据</span>
            <div className="demo-notice-text">
              当前库里是<b>演示数据</b>：{accounts.data?.items.length ?? 0} 个账户、
              {snapshotList.length} 期快照全部是示例，可以随便改着试。
              想开始记自己的账，一键换成你的空白账本。
            </div>
            <button className="btn sm" onClick={() => setAskGoLive(true)}>
              开始正式记账
            </button>
          </div>
        ) : null}
        <section className={'view'} id={'view-' + route.view}>
          {page}
        </section>
      </main>
      <div id="modalRoot" />
      {askGoLive ? (
        <ConfirmModal
          title="开始正式记账？"
          okText="清空演示数据并开始"
          onClose={() => setAskGoLive(false)}
          onOk={() => void doGoLive()}
          body={
            <>
              <p>
                将<b>清空</b>当前的 {accounts.data?.items.length ?? 0} 个账户与{' '}
                {snapshotList.length} 期快照 —— 它们都是演示数据。
              </p>
              <p>
                币种 / 汇率 / 平台 / 分类 / 标签<b>会保留</b>：那是记账要用的字典，
                清掉反而得重建。
              </p>
              <p>
                演示数据不会丢，随时可以用 <span className="mono">npm run db:seed -- --yes</span>{' '}
                重新灌回来。这一步之后界面上的演示提示会消失。
              </p>
            </>
          }
        />
      ) : null}
      {acctEdit ? (
        <AccountModal
          accountId={acctEdit.id}
          accounts={accounts.data?.items ?? []}
          platforms={platforms.data?.items ?? []}
          categories={categories.data?.items ?? []}
          tags={tags.data?.items ?? []}
          currencies={currencies.data?.items ?? []}
          onClose={() => setAcctEdit(null)}
        />
      ) : null}
      {tagOpen ? (
        <TagModal
          tags={tags.data?.items ?? []}
          accounts={accounts.data?.items ?? []}
          onClose={() => setTagOpen(false)}
        />
      ) : null}
    </>
  );
}

/* ============================================================
   顶栏内容（原型里散落在各 renderX 开头的赋值）
   ============================================================ */

interface ChromeInput {
  route: ReturnType<typeof useRoute>;
  base: string;
  accounts: readonly AccountDTO[];
  platforms: readonly PlatformDTO[];
  snapshotList: readonly SnapshotSummaryDTO[];
  selectedSnap: SnapshotSummaryDTO | null;
  /** 账户详情页看的是哪一个账户（`#account-detail` 是裸深链，故允许为空） */
  selectedAccount: AccountDTO | null;
  settings: SettingsDTO | null;
  onNavigate: (view: View, opts?: RouteOpts) => void;
  onStartInventory: () => void;
  /** 打开账户弹窗：`null` = 新建。顶栏与账户页共用同一个入口 */
  onOpenAccount: (id: string | null) => void;
  /** 打开标签管理弹窗（原型 `openTagModal`），入口只在账户页顶栏 */
  onOpenTags: () => void;
  /** 顶栏的「导出全量备份」/「导出备份」。Step 5 起是两个按钮共用的真实导出 */
  onExportFull: () => void;
}

function buildChrome(input: ChromeInput): { title: string; crumb: string; actions: ReactNode } {
  const {
    route,
    base,
    accounts,
    platforms,
    snapshotList,
    selectedSnap,
    selectedAccount,
    settings,
    onNavigate,
    onStartInventory,
    onOpenAccount,
    onOpenTags,
    onExportFull
  } = input;

  const btn = (label: ReactNode, onClick: () => void, cls = '') => (
    <button className={'btn' + (cls ? ' ' + cls : '')} onClick={onClick}>
      {label}
    </button>
  );

  if (route.view === 'home') {
    return {
      title: '首页',
      crumb: `净资产总览 · 本位币 ${base}`,
      actions: (
        <>
          {btn('查看快照', () => onNavigate('snapshots'))}
          {btn('开始盘点', onStartInventory, 'pri')}
        </>
      )
    };
  }

  if (route.view === 'accounts') {
    /* 详情层的顶栏只留「返回」—— 编辑 / 归档 / 删除在页内（操作下沉）。
       顶栏若再放一遍，就成了两处入口维护同一份逻辑。 */
    if (route.accMode === 'detail' && selectedAccount) {
      return {
        title: `账户详情 · ${selectedAccount.name}`,
        crumb: `${selectedAccount.currency} · ${selectedAccount.type === 'asset' ? '资产' : '负债'} · ` +
          `${selectedAccount.archived ? '已归档' : '使用中'} · 更新于 ${selectedAccount.updated_at}`,
        actions: <>{btn('← 返回列表', () => onNavigate('accounts'))}</>
      };
    }
    return {
      title: '账户',
      crumb: `${accounts.length} 个账户 · ${platforms.length} 个平台`,
      actions: (
        <>
          {btn('＋ 标签', onOpenTags)}
          {btn('＋ 新增账户', () => onOpenAccount(null), 'pri')}
        </>
      )
    };
  }

  if (route.view === 'snapshots') {
    if (route.snapMode === 'detail' && selectedSnap) {
      return {
        title: `快照详情 · ${selectedSnap.date}`,
        crumb: `${selectedSnap.note || '无备注'} · 保存于 ${selectedSnap.created_at}`,
        actions: (
          <>
            {btn('← 返回列表', () => onNavigate('snapshots', { snapMode: 'list' }))}
            {btn('与上期对比', () => onNavigate('snapshots', { snapMode: 'compare' }))}
          </>
        )
      };
    }
    if (route.snapMode === 'compare') {
      return {
        title: '两期对比',
        crumb: '按 ID 匹配，账户 / 平台 / 分类 / 标签改名不影响对齐',
        actions: <>{btn('← 返回列表', () => onNavigate('snapshots', { snapMode: 'list' }))}</>
      };
    }
    return {
      title: '快照',
      crumb: `${snapshotList.length} 期快照 · 只读锁定，修改需删除重做`,
      actions: (
        <>
          {btn('两期对比', () => onNavigate('snapshots', { snapMode: 'compare' }))}
          {btn('开始盘点', onStartInventory, 'pri')}
        </>
      )
    };
  }

  if (route.view === 'reports') {
    return {
      title: '报表',
      crumb: '趋势 · 结构分布 · 理财收益统计',
      actions: <>{btn('导出全量备份', onExportFull)}</>
    };
  }

  if (route.view === 'settings') {
    return {
      title: '设置',
      crumb: `本位币 ${base} · schema v${settings?.schema_version ?? '—'} · app v${settings?.app_version ?? '—'}`,
      actions: (
        <>
          {btn('导出备份', onExportFull)}
          {btn('开始盘点', onStartInventory, 'pri')}
        </>
      )
    };
  }

  if (route.view === 'help') {
    return {
      title: '使用手册',
      crumb: '概念 · 场景 · 常见问题 · 名词速查',
      actions: <>{btn('开始盘点', onStartInventory, 'pri')}</>
    };
  }

  return {
    title: '盘点',
    crumb: '开始盘点 → 确认汇率 → 录入金额 → 保存快照',
    actions: (
      <>
        {/* 「退出（保存草稿）」只是离开向导：草稿在每次改动后 700ms 就已落到服务端，
            卸载时还会补一次，所以这里不需要（也确实没法）再阻塞地等一次写入。
            按钮文案保持与原型逐字符一致 —— 它在基准图里。 */}
        {route.invStep < 4
          ? btn('退出（保存草稿）', () => onNavigate('home'))
          : btn('返回首页', () => onNavigate('home'))}
      </>
    )
  };
}
