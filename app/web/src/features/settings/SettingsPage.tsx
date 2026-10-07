/**
 * SettingsPage.tsx —— 设置页（PRD §3.7 §6.4 §6.5）
 *
 * 对应原型的 `renderSettings` 与其 9 个分页（SET_TABS）。
 *
 * Step 4 起，币种 / 汇率 / 平台 / 分类 / 标签五组写路径全部接通服务端；
 * Step 5 起导入导出与备份恢复也接通，但**拆到了 `DataTabs.tsx`** ——
 * 它们要的是文件流与整库替换，和其余五组的「一次 JSON 调用」不是一回事。
 * 至此设置页 9 个分页不再有任何占位按钮。
 *
 * ── 2026-10-04 第三批 #5：元数据改为「草稿 + 点保存才写」（本文件最大的一次改动）──
 * 需求原文：「设置里面的元数据目前是直接修改的，需要增加保存机制，用户点击保存才去保存」，
 * 用户随后把口径定为最宽档 —— **文本字段、启用勾选、新增、删除全部走草稿**。
 *
 * 改动落点：
 *   · 币种 / 平台 / 分类 / 标签四张表（`base` 与 `rate` 两个分页不在范围内，
 *     汇率有自己的刷新入口，见 #1/#2）；
 *   · 四份草稿由 `features/settings/draft.ts` 的引擎托管，四张表的**行渲染路径
 *     只有一条**（已存在行与待新增行共用同一段 JSX，靠 `val()` / `edit()` 两个
 *     访问器分流）—— 否则「新建的行没有某些列的编辑能力」这类漂移迟早会出现；
 *   · 表尾出现「N 项未保存 + 保存 / 放弃」（`.draft-bar`），无改动时不渲染；
 *   · 一次保存可能发 N 条请求（改 5 个平台名 = 5 条 PATCH），所以用
 *     `useCatalogWrite().writeQuiet` 串行发、**只在末尾失效一次缓存**，
 *     失败的项留在草稿里并汇总成一条提示（逐条弹会淹掉真正有用的那句）。
 *
 * 三处刻意的取舍（前两条沿用原实现，第三条是本批新增）：
 *   1. **删除被引用项的提示文案用服务端原话**。原型是在前端自己数一遍再拼串
 *      （'该平台下仍有 N 个账户…'），这里不再复刻 —— 同一条判定有两份实现，
 *      迟早会有一份先被改掉；服务端的 409 里带着真实计数（币种还多一层快照明细）。
 *   2. **汇率行的「最近更新」保持字面量**，不接 `rate_updated_at`。原型从未给
 *      `DB.rateUpdated` 赋值，基准图里这一列恒为 '2026-10-03 10:00'；接上真实时间戳
 *      会让汇率分页与基准图不一致，属于外观漂移。要接需同时更新基准图。
 *   3. **离开分页时确认并丢弃草稿**。草稿是页面内的一等状态，跨分页默默留着
 *      更危险 —— 用户在「平台」改了三处、切去「标签」看了一圈、再切回来点保存，
 *      会把一批自己已经忘了的改动一起提交。确认框把这件事摆到明面上。
 *
 * 「使用中」的判定口径与原型一致：**账户币种 ∪ 全部快照明细的币种**。
 * 因此这里需要逐张读 `/snapshots/:id`，与盘点页共用同一组缓存路径。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  AccountDTO,
  BaseCurrencyChangeDTO,
  CategoryDTO,
  CurrencyDTO,
  PlatformDTO,
  SettingsDTO,
  SnapshotDTO,
  SnapshotSummaryDTO,
  TagDTO
} from '@app/shared';
import { cached, ep, invalidate, mutate, useApi, usePaths, writable } from '../../api/index.ts';
import { messageOf } from '../../api/problem.ts';
import { getBaseCurrency, rateText } from '../../lib/money.ts';
import { microFromYuan, yuanFromMicro } from '../../lib/units.ts';
import { useCatalogWrite } from '../../lib/catalogWrite.ts';
import { refreshRates, refreshSummary } from '../../lib/refreshRates.ts';
import { SET_TABS, useUi } from '../../state/ui.tsx';
import { Note } from '../../components/Atoms.tsx';
import { useToast } from '../../components/Toast.tsx';
import { IoPanel, BackupPanel } from './DataTabs.tsx';
import { useDraft, type Draft, type DraftPlan, type FieldMap } from './draft.ts';

interface ListResponse<T> {
  items: T[];
}

/**
 * 四张表的行主键 —— **必须定义在模块级**。
 *
 * 写成内联箭头（`useDraft(c => c.code)`）会让 `keyOf` 每次渲染都换一个引用，
 * 引擎里依赖它的 `view` / `isDirty` / `set` 就全都跟着重建，整页的
 * `useCallback` 缓存每次渲染都作废。功能上不会错，但把「本地草稿」这种
 * 每帧都要比较的东西挂在一串失效的闭包上，是没必要的开销，也容易在下一次
 * 改动里被误当成「有意的依赖」。
 */
const keyOfCurrency = (c: CurrencyDTO): string => c.code;
const keyOfPlatform = (p: PlatformDTO): string => p.id;
const keyOfCategory = (c: CategoryDTO): string => c.id;
const keyOfTag = (t: TagDTO): string => t.id;

interface RateTable {
  base_currency: string;
  rates: Record<string, number>;
}

interface NbPreview {
  from: string;
  to: string;
  rows: Array<{ code: string; old: string; nv: string }>;
}

const PLATFORM_TYPES: ReadonlyArray<[string, string]> = [
  ['bank', '银行'],
  ['broker', '券商'],
  ['payment', '支付平台'],
  ['other', '其他']
];

/**
 * 一组的提交规格：路径前缀 + 两个「把草稿字段挑成请求体」的函数。
 *
 * 两个函数都必须**显式列举**要提交的字段，不能把整行原样送出去 ——
 * 行走的是 DTO（币种带着 `rate_to_base` / `rate_updated_at`，平台带着
 * `account_count`），原样 PATCH 会撞上 zod 的 `.strict()`-式语义或被服务端忽略，
 * 「改了没生效」这种最难查的问题就是这么来的。
 */
interface GroupSpec {
  /** 路径前缀，`<base>/<key>`；新增走 `<base>` */
  base: string;
  patchBody: (f: FieldMap) => unknown;
  createBody: (f: FieldMap) => unknown;
}

/** 一组的守卫：返回非空字符串则整组不提交（用于「本位币不可停用/删除」这类硬规则） */
type GroupGuard = (plan: DraftPlan) => string | null;

export function SettingsPage({
  settings,
  platforms,
  categories,
  tags,
  accounts,
  snapshotList
}: {
  settings: SettingsDTO | null;
  platforms: readonly PlatformDTO[];
  categories: readonly CategoryDTO[];
  tags: readonly TagDTO[];
  accounts: readonly AccountDTO[];
  snapshotList: readonly SnapshotSummaryDTO[];
}) {
  const { ui, patch } = useUi();
  const toast = useToast();
  const tab = ui.setTab;

  const currencies = useApi<ListResponse<CurrencyDTO>>(ep.currencies(true));
  const rates = useApi<RateTable>(ep.rates());
  const history = useApi<ListResponse<BaseCurrencyChangeDTO>>(ep.baseCurrencyHistory());

  /* 快照明细：只为「币种使用中」的判定，与盘点页同一批路径 */
  const snapPaths = snapshotList.map(s => ep.snapshot(s.id, 'origin'));
  usePaths(snapPaths);
  const snapDocs = snapPaths.map(p => cached<SnapshotDTO>(p)).filter((d): d is SnapshotDTO => d !== null);

  const [nbCur, setNbCur] = useState('USD');
  const [nbRateVal, setNbRateVal] = useState('');
  const [preview, setPreview] = useState<NbPreview | null>(null);
  const [applying, setApplying] = useState(false);

  const base = settings?.base_currency ?? getBaseCurrency();
  const all = currencies.data?.items ?? [];
  const enabled = all.filter(c => c.enabled);
  const rateTable = rates.data?.rates ?? {};

  const nameOf = (code: string) => all.find(c => c.code === code)?.name ?? '';

  /* ---- 提前算好各分页真正用到的派生量（避免每个分页都重新扫一遍） ---- */
  const usedCurrencies = new Set<string>();
  for (const a of accounts) usedCurrencies.add(a.currency);
  for (const doc of snapDocs) for (const it of doc.items) usedCurrencies.add(it.currency);

  const accountCountOfPlatform = (id: string) => accounts.filter(a => a.platform_id === id).length;
  const accountCountOfCategory = (id: string) => accounts.filter(a => a.category_id === id).length;
  const accountCountOfTag = (id: string) => accounts.filter(a => a.tags.indexOf(id) >= 0).length;

  /* ---- 新增表单的输入值（原型里是几个裸 input，取值时才读）---- */
  const [newCur, setNewCur] = useState({ code: '', name: '', symbol: '' });
  const [newPlat, setNewPlat] = useState({ name: '', type: 'bank' });
  const [newCat, setNewCat] = useState<{ asset: string; liability: string }>({ asset: '', liability: '' });
  const [newTag, setNewTag] = useState('');

  /* ============================================================
     草稿（#5）
     ============================================================ */

  const curDraft = useDraft<CurrencyDTO>(keyOfCurrency);
  const platDraft = useDraft<PlatformDTO>(keyOfPlatform);
  const catDraft = useDraft<CategoryDTO>(keyOfCategory);
  const tagDraft = useDraft<TagDTO>(keyOfTag);

  const dirtyOf: Record<string, number> = {
    currency: curDraft.count(all),
    platform: platDraft.count(platforms),
    category: catDraft.count(categories),
    tag: tagDraft.count(tags)
  };
  const dirtyTotal = Object.values(dirtyOf).reduce((s, n) => s + n, 0);

  const discardAll = useCallback(() => {
    curDraft.reset();
    platDraft.reset();
    catDraft.reset();
    tagDraft.reset();
  }, [curDraft, platDraft, catDraft, tagDraft]);

  /* 关页面/刷新时拦一道 —— 浏览器只允许「确认离开」这一种文案，故不传自定义文本 */
  useEffect(() => {
    if (!dirtyTotal) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirtyTotal]);

  const [saving, setSaving] = useState(false);
  const { write, writeQuiet } = useCatalogWrite();

  /**
   * 提交一组的草稿。
   *
   * 串行发（不是 `Promise.all`）：本机单用户的写入量极小，而串行的好处是
   * 「失败的项留在草稿里、成功的项已经落库」这件事在日志里是**有序**的，
   * 排查时不必去猜哪一条先到。缓存只在全部发完后失效一次 —— 每写一条就失效
   * 一次的话，5 条请求会触发 5 轮全量重取。
   */
  async function commitGroup<T extends object>(
    spec: GroupSpec,
    draft: Draft<T>,
    rows: readonly T[],
    guard?: GroupGuard
  ): Promise<void> {
    const plan = draft.plan(rows);
    const total =
      plan.edits.reduce((s, e) => s + Object.keys(e.fields).length, 0) +
      plan.deletes.length +
      plan.adds.length;
    if (!total || saving) return;

    const blocked = guard?.(plan);
    if (blocked) {
      toast(blocked, 'err', 4600);
      return;
    }

    setSaving(true);
    const failed: string[] = [];
    let done = 0;

    /* 顺序：新增 → 修改 → 删除。删除放最后，免得先删掉一个刚被改过的行 */
    for (const a of plan.adds) {
      const r = await writeQuiet('POST', spec.base, spec.createBody(a.fields));
      if (r.ok) {
        /* 新增行**必须**从草稿里摘掉：留着它下一次保存会再 POST 一次 */
        draft.removeAdd(a.key);
        done++;
      } else {
        failed.push(r.message);
      }
    }
    for (const e of plan.edits) {
      const r = await writeQuiet('PATCH', `${spec.base}/${encodeURIComponent(e.key)}`, spec.patchBody(e.fields));
      if (r.ok) done++;
      else failed.push(r.message);
    }
    for (const k of plan.deletes) {
      const r = await writeQuiet('DELETE', `${spec.base}/${encodeURIComponent(k)}`, undefined);
      if (r.ok) done++;
      else failed.push(r.message);
    }

    invalidate();
    setSaving(false);

    if (failed.length) {
      /* 只报第一条的原话，其余计数 —— 服务端文案里有引用计数这类唯一信息，
         但一屏五条红字反而会把它淹掉。失败的项仍在草稿里，可以逐条重试。 */
      toast(`${done} 项已保存，${failed.length} 项失败：${failed[0]}`, 'err', 5600);
    } else {
      toast(`已保存 ${done} 项修改`, 'ok');
    }
  }

  /* ============================================================
     四组的提交规格与守卫
     ============================================================ */

  const CURRENCY_SPEC: GroupSpec = {
    base: '/currencies',
    patchBody: f => {
      const b: FieldMap = {};
      if ('name' in f) b.name = f.name;
      if ('symbol' in f) b.symbol = f.symbol;
      if ('enabled' in f) b.enabled = f.enabled;
      return b;
    },
    createBody: f => ({ code: f.code, name: f.name, symbol: f.symbol, enabled: f.enabled })
  };
  const PLATFORM_SPEC: GroupSpec = {
    base: '/platforms',
    patchBody: f => {
      const b: FieldMap = {};
      if ('name' in f) b.name = f.name;
      if ('type' in f) b.type = f.type;
      if ('note' in f) b.note = f.note;
      if ('enabled' in f) b.enabled = f.enabled;
      return b;
    },
    createBody: f => ({ name: f.name, type: f.type, note: f.note ?? '' })
  };
  const CATEGORY_SPEC: GroupSpec = {
    base: '/categories',
    patchBody: f => {
      const b: FieldMap = {};
      if ('name' in f) b.name = f.name;
      if ('default_track_principal' in f) b.default_track_principal = f.default_track_principal;
      if ('enabled' in f) b.enabled = f.enabled;
      return b;
    },
    createBody: f => ({
      name: f.name,
      type: f.type,
      default_track_principal: f.default_track_principal === true
    })
  };
  const TAG_SPEC: GroupSpec = {
    base: '/tags',
    patchBody: f => {
      const b: FieldMap = {};
      if ('name' in f) b.name = f.name;
      if ('enabled' in f) b.enabled = f.enabled;
      return b;
    },
    createBody: f => ({ name: f.name })
  };

  /**
   * 本位币的守卫。
   *
   * 原先这条规则在**点击时**拦（`toggleCurrency` 里 `if (c.code === base && !on)`）。
   * 改成草稿后勾选本身不再落库，拦截必须移到保存前 —— 否则用户勾掉「启用」、
   * 点保存、拿到一条服务端的 422，而其余四项已经写进去了（半成功）。
   * 服务端那一道守卫照旧留着（见 modules/catalog.ts），这里只是把话提前说。
   */
  const CURRENCY_GUARD: GroupGuard = plan => {
    if (plan.deletes.includes(base)) return `「${nameOf(base)}」是本位币，不能删除；请先变更本位币`;
    for (const e of plan.edits) {
      if (e.key === base && e.fields.enabled === false) {
        return `「${nameOf(base)}」是本位币，不能停用；请先变更本位币`;
      }
    }
    return null;
  };
  /* ---- 汇率与本位币两处分页仍走「即时写入」（不在 #5 的范围内）---- */

  const [refreshing, setRefreshing] = useState(false);
  const [gen, setGen] = useState(0);
  const redraw = useCallback(() => setGen(n => n + 1), []);
  const save = useCallback(
    async (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body: unknown, ok: string) => {
      const done = await write(method, path, body, ok);
      if (!done) redraw();
      return done;
    },
    [write, redraw]
  );

  async function saveRate(c: CurrencyDTO, raw: string): Promise<void> {
    const n = Number.parseFloat(raw);
    const micro = Number.isFinite(n) && n > 0 ? microFromYuan(n) : null;
    if (micro === null || micro <= 0) {
      toast('汇率必须为正数', 'err');
      redraw();
      return;
    }
    await save('PUT', '/rates', { rates: { [c.code]: micro } }, `${c.code} 汇率已更新为 ${n}`);
  }

  /** 取倒数：新汇率 = 1 / 旧汇率。与原型同一算式，只是这里在元与微元之间明确换算一次。 */
  async function invertRate(c: CurrencyDTO): Promise<void> {
    const oldYuan = yuanFromMicro(rateTable[c.code] ?? 1_000_000);
    if (oldYuan === null || oldYuan <= 0) {
      toast(`${c.code} 当前汇率无效，无法取倒数`, 'err');
      return;
    }
    const inv = 1 / oldYuan;
    const micro = microFromYuan(inv);
    if (micro === null || micro <= 0) {
      toast(`${c.code} 取倒数后超出可表示范围`, 'err');
      return;
    }
    await save('PUT', '/rates', { rates: { [c.code]: micro } }, `${c.code} 汇率已更新为 ${inv}`);
  }

  /**
   * 从公开源**手动**取一次汇率（#1 / #2）。
   *
   * 与上面两条写路径一样是即时写入 —— 「即时 / 草稿」的分界是**元数据**（名称、启停…），
   * 汇率不在那条线上：它的值来自外部、有明确的时点含义，攒在草稿里点保存反而不清楚
   * 「这份表是哪一刻的」。改完立刻落库，页面上的「最近更新」才有意义。
   *
   * 请求期间禁用按钮：服务端有 8s 超时，不置忙用户会连点，一次点击 = 一次外部请求。
   */
  async function refreshFromSource(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    const res = await refreshRates();
    setRefreshing(false);
    if (!res.ok) {
      toast(res.message, res.offline ? 'warn' : 'err', 4600);
      return;
    }
    const s = refreshSummary(res.dto);
    toast(s.text, s.tone, 4800);
  }

  /* ---- 新增：只把行**放进草稿**，不落库（#5）---- */

  function stageCurrency(): void {
    const code = newCur.code.trim().toUpperCase();
    const name = newCur.name.trim();
    if (!code || !name) {
      toast('请填写币种代码与名称', 'err');
      return;
    }
    if (code === base || all.some(c => c.code === code) || curDraft.adds.some(a => a.row.code === code)) {
      toast(`币种 ${code} 已存在`, 'err');
      return;
    }
    /* 原型：符号留空则退回代码本身（`$('#ncs').value.trim() || code`） */
    const symbol = newCur.symbol.trim() || code;
    curDraft.add({ code, name, symbol, enabled: true, sort: 0, rate_to_base: 0, rate_updated_at: null });
    setNewCur({ code: '', name: '', symbol: '' });
  }

  function stagePlatform(): void {
    const name = newPlat.name.trim();
    if (!name) {
      toast('请填写平台名称', 'err');
      return;
    }
    platDraft.add({ id: '', name, type: newPlat.type, note: '', sort: 0, enabled: true, account_count: 0 });
    setNewPlat(v => ({ ...v, name: '' }));
  }

  function stageCategory(type: 'asset' | 'liability'): void {
    const name = newCat[type].trim();
    if (!name) {
      toast('请填写分类名', 'err');
      return;
    }
    catDraft.add({
      id: '',
      name,
      type,
      default_track_principal: false,
      sort: 0,
      enabled: true,
      account_count: 0
    });
    setNewCat(v => ({ ...v, [type]: '' }));
  }

  function stageTag(): void {
    const name = newTag.trim();
    if (!name) {
      toast('请填写标签名', 'err');
      return;
    }
    tagDraft.add({ id: '', name, sort: 0, enabled: true, account_count: 0 });
    setNewTag('');
  }

  /* ---- 本位币变更（不变）---- */

  const calcPreview = () => {
    if (nbCur === base) {
      toast('新本位币与当前相同', 'err');
      return;
    }
    const R = Number.parseFloat(nbRateVal);
    if (!R || R <= 0 || Number.isNaN(R)) {
      toast(`请填写有效的换算比价（1 ${base} = ? ${nbCur}）`, 'err');
      return;
    }
    setPreview({
      from: base,
      to: nbCur,
      rows: enabled.map(c => {
        const oldMicro = c.code === base ? 1_000_000 : rateTable[c.code] ?? 1_000_000;
        const old = oldMicro / 1e6;
        return {
          code: c.code,
          old: String(old),
          nv: c.code === nbCur ? (1).toFixed(4) : (old * R).toFixed(6)
        };
      })
    });
  };

  /**
   * 确认变更本位币（`POST /settings/base-currency`，单事务）。
   *
   * 提交的是**预览表里那一列**（`rates`），不只是「to + 比价」——
   * 界面上写着「可逐条修正后再保存」，用户改过的那几行必须一起带上，
   * 否则会被服务端的反算结果静默覆盖，那句话就成了假承诺。
   * 服务端的口径是「先整表反算，再用这一列覆盖」，所以这里只送启用中的币种也不会漏。
   *
   * 成功后 `mutate` 会清空整个取数缓存：本位币变了，全站每一个数字都跟着变，
   * 这时做精细的依赖追踪没有意义（也是错的）。
   */
  async function applyBaseChange(): Promise<void> {
    if (!preview || applying) return;
    if (!writable()) {
      toast('当前是离线数据源（?data=fixture），变更本位币不可用', 'warn');
      return;
    }
    const rMicro = microFromYuan(Number.parseFloat(nbRateVal));
    if (rMicro === null || rMicro <= 0) {
      toast('换算比价无效，请重新计算预览', 'err');
      return;
    }
    const ratesToSend: Record<string, number> = {};
    for (const row of preview.rows) {
      const m = microFromYuan(Number.parseFloat(row.nv));
      if (m === null || m <= 0) {
        toast(`「${row.code}」的新汇率无效，请修正后再保存`, 'err');
        return;
      }
      ratesToSend[row.code] = m;
    }

    setApplying(true);
    try {
      const to = preview.to;
      await mutate(ds =>
        ds.send('POST', '/settings/base-currency', {
          to,
          conversion_rate: rMicro,
          rates: ratesToSend
        })
      );
      setPreview(null);
      setNbRateVal('');
      toast(`本位币已变更为 ${to}。历史快照保留原口径，可切换查看。`, 'ok', 4200);
    } catch (err) {
      toast(`变更失败：${messageOf(err)}`, 'err', 4200);
    } finally {
      setApplying(false);
    }
  }

  const switchTab = (next: string): void => {
    if (next === tab) return;
    if (dirtyTotal > 0) {
      const ok = window.confirm(`有 ${dirtyTotal} 项未保存的修改，切换分页会丢弃它们。确定要切换吗？`);
      if (!ok) return;
      discardAll();
    }
    patch({ setTab: next });
  };

  return (
    <>
      <div className="tabs">
        {SET_TABS.map(t => (
          <button key={t[0]} className={'tab ' + (tab === t[0] ? 'on' : '')} onClick={() => switchTab(t[0])}>
            {t[1]}
            {/* 未保存的改动在 tab 上留一个记号 —— 否则用户切到别的分页后，
                草稿就成了看不见的状态，回来点保存会提交一批已经忘了的改动 */}
            {t[0] !== 'base' && t[0] !== 'rate' && dirtyOf[t[0]] ? (
              <span className="badge warn" style={{ marginLeft: 6 }}>{dirtyOf[t[0]]}</span>
            ) : null}
          </button>
        ))}
      </div>
      {tab === 'base' ? (
        /* ============ 本位币 ============ */
        <div className="card">
          <div className="card-hd">
            <h3>本位币设置与变更</h3>
            <span className="sub">全局唯一，用于汇总展示</span>
          </div>
          <div className="grid3">
            <div className="field">
              <label>当前本位币</label>
              <input className="inp" value={`${base} · ${nameOf(base)}`} disabled readOnly />
            </div>
            <div className="field">
              <label>变更为</label>
              <select
                className="inp"
                value={nbCur}
                onChange={e => {
                  setNbCur(e.target.value);
                  setPreview(null);
                }}
              >
                {enabled.map(c => (
                  <option key={c.code} value={c.code} disabled={c.code === base}>
                    {`${c.code} · ${c.name}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{`换算比价：1 ${base} = ? 新本位币 *`}</label>
              <input
                className="inp num"
                placeholder="如 0.1374"
                value={nbRateVal}
                onChange={e => {
                  setNbRateVal(e.target.value);
                  setPreview(null);
                }}
              />
              <span className="tiny muted">新本位币自身无需填写比价</span>
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn pri" onClick={calcPreview}>
              计算并预览汇率表 →
            </button>
          </div>

          {preview ? (
            <>
              <div className="sec-title">汇率表反算预览（新汇率 = 旧汇率 × R）</div>
              <Note tone="info">
                {`旧汇率：1 原币 = X ${preview.from}；新汇率：1 原币 = X ${preview.to}。可逐条修正后再保存。`}
              </Note>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>币种</th>
                      <th className="num">{`旧汇率（${preview.from}）`}</th>
                      <th className="num">{`新汇率（${preview.to}）`}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={r.code}>
                        <td>
                          <b>{r.code}</b>
                          {r.code === preview.to ? <> <span className="badge ok">新本位币</span></> : null}
                          {r.code === preview.from ? <> <span className="badge cur">旧本位币</span></> : null}
                        </td>
                        <td className="num muted">{r.old}</td>
                        <td className="num">
                          <input
                            className="inp num"
                            style={{ width: 120 }}
                            value={r.nv}
                            onChange={e => {
                              const nv = e.target.value;
                              setPreview(p =>
                                p ? { ...p, rows: p.rows.map((x, j) => (j === i ? { ...x, nv } : x)) } : p
                              );
                            }}
                          />
                        </td>
                        <td className="tiny muted">
                          {r.code === preview.to ? '固定为 1' : `1 ${r.code} = X ${preview.to}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="btn-row" style={{ marginTop: 14 }}>
                <button className="btn ink" onClick={() => void applyBaseChange()}>
                  确认变更本位币
                </button>
                <button className="btn" onClick={() => setPreview(null)}>
                  取消
                </button>
              </div>
            </>
          ) : null}

          <div className="hr" />
          <div className="card-hd">
            <h3>本位币变更历史</h3>
            <span className="sub">用于把历史快照折算为当前本位币口径</span>
          </div>
          {(history.data?.items.length ?? 0) > 0 ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>变更时间</th>
                    <th>原本位币</th>
                    <th>新本位币</th>
                    <th className="num">比价</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(history.data?.items ?? [])]
                    .sort((a, b) => (a.changed_at < b.changed_at ? 1 : -1))
                    .map(h => (
                      <tr key={h.id}>
                        <td className="mono">{h.changed_at}</td>
                        <td>{h.from_currency}</td>
                        <td>{h.to_currency}</td>
                        <td className="num">
                          {`1 ${h.from_currency} = ${h.conversion_rate} ${h.to_currency}`}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Note tone="info">
              暂无变更记录。变更后，旧快照保留原本位币口径（唯一事实来源），并可切换为「当前本位币口径」查看（标注为参考值）。
            </Note>
          )}
        </div>
      ) : tab === 'currency' ? (
        /* ============ 币种 ============ */
        <div className="card">
          <div className="card-hd">
            <h3>币种管理</h3>
            <span className="sub">改动先进草稿，点保存才生效；已被使用的币种不可删除，只能停用</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>符号</th>
                  <th className="num">当前汇率</th>
                  <th className="mid">使用中</th>
                  <th className="mid">启用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {all.map(c => {
                  const v = curDraft.view(c);
                  const gone = curDraft.isDeleted(c);
                  return (
                    <tr key={c.code} className={gone ? 'draft-row-off' : undefined}>
                      <td>
                        <b>{c.code}</b>
                        {c.code === base ? <> <span className="badge ok">本位币</span></> : null}
                        {gone ? <> <span className="badge warn">待删除</span></> : null}
                      </td>
                      <td>
                        {gone ? (
                          <span>{v.name}</span>
                        ) : (
                          /* 图片化前的原实现是 defaultValue + onBlur（每次编辑一次请求）；
                             改成草稿后必须受控 —— 值不再来自服务端，而来自本地草稿。 */
                          <input
                            className={'inp' + (curDraft.isDirty(c, 'name') ? ' dirty' : '')}
                            style={{ width: 110, padding: '4px 8px' }}
                            value={v.name}
                            onChange={e => curDraft.set(c, 'name', e.target.value)}
                          />
                        )}
                      </td>
                      <td>
                        {gone ? (
                          <span>{v.symbol}</span>
                        ) : (
                          <input
                            className={'inp' + (curDraft.isDirty(c, 'symbol') ? ' dirty' : '')}
                            style={{ width: 62, padding: '4px 8px' }}
                            value={v.symbol}
                            onChange={e => curDraft.set(c, 'symbol', e.target.value)}
                          />
                        )}
                      </td>
                      <td className="num">
                        {c.code === base ? '1（固定）' : rateTable[c.code] !== undefined ? rateText(rateTable[c.code]) : '—'}
                      </td>
                      <td className="mid">
                        {usedCurrencies.has(c.code) ? <span className="badge ok">是</span> : <span className="badge mute">否</span>}
                      </td>
                      <td className="mid">
                        {gone ? (
                          <span className="muted tiny">—</span>
                        ) : (
                          <label className="chk" style={{ justifyContent: 'center' }}>
                            <input
                              type="checkbox"
                              checked={v.enabled}
                              onChange={e => curDraft.set(c, 'enabled', e.target.checked)}
                            />
                          </label>
                        )}
                      </td>
                      <td>
                        <button className="btn xs danger" onClick={() => curDraft.toggleDelete(c)}>
                          {gone ? '撤销' : '删'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {curDraft.adds.map(a => {
                  const v = curDraft.viewAdd(a.key) as CurrencyDTO;
                  return (
                    <tr key={a.key}>
                      <td>
                        <input
                          className="inp"
                          style={{ width: 90, padding: '4px 8px' }}
                          value={v.code}
                          onChange={e => curDraft.setAdd(a.key, 'code', e.target.value.toUpperCase())}
                        />
                        <span className="badge ok">待新增</span>
                      </td>
                      <td>
                        <input
                          className="inp"
                          style={{ width: 110, padding: '4px 8px' }}
                          value={v.name}
                          onChange={e => curDraft.setAdd(a.key, 'name', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="inp"
                          style={{ width: 62, padding: '4px 8px' }}
                          value={v.symbol}
                          onChange={e => curDraft.setAdd(a.key, 'symbol', e.target.value)}
                        />
                      </td>
                      <td className="num muted tiny">—</td>
                      <td className="mid">
                        <span className="badge mute">否</span>
                      </td>
                      <td className="mid">
                        <label className="chk" style={{ justifyContent: 'center' }}>
                          <input
                            type="checkbox"
                            checked={v.enabled}
                            onChange={e => curDraft.setAdd(a.key, 'enabled', e.target.checked)}
                          />
                        </label>
                      </td>
                      <td>
                        <button className="btn xs" onClick={() => curDraft.removeAdd(a.key)}>
                          撤销
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="hr" />
          <div className="flex" style={{ gap: 8 }}>
            <input
              className="inp"
              placeholder="代码 如 JPY"
              style={{ width: 110 }}
              value={newCur.code}
              onChange={e => setNewCur(v => ({ ...v, code: e.target.value }))}
            />
            <input
              className="inp"
              placeholder="名称"
              style={{ width: 140 }}
              value={newCur.name}
              onChange={e => setNewCur(v => ({ ...v, name: e.target.value }))}
            />
            <input
              className="inp"
              placeholder="符号"
              style={{ width: 80 }}
              value={newCur.symbol}
              onChange={e => setNewCur(v => ({ ...v, symbol: e.target.value }))}
            />
            <button className="btn pri" onClick={stageCurrency}>
              ＋ 新增币种
            </button>
          </div>
          <DraftBar
            count={dirtyOf.currency}
            saving={saving}
            onDiscard={curDraft.reset}
            onSave={() => void commitGroup(CURRENCY_SPEC, curDraft, all, CURRENCY_GUARD)}
          />
        </div>
      ) : tab === 'rate' ? (
        /* ============ 汇率 ============ */
        <div className="card">
          <div className="card-hd">
            <h3>汇率管理</h3>
            <span className="sub">{`方向统一：1 单位原币 = X ${base}；仅作盘点默认值，历史以快照为准`}</span>
            <span className="spacer" />
            <button className="btn" disabled={refreshing} onClick={() => void refreshFromSource()}>
              {refreshing ? '获取中…' : '获取实时汇率'}
            </button>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>币种</th>
                  <th className="num">{`1 原币 = X ${base}`}</th>
                  <th>最近更新</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {enabled.map(c => {
                  const fixed = c.code === base;
                  /* key 带上汇率与 `gen`：写成功后重挂这一行，输入框回到服务端规范化后的值
                     （未受控输入的 value 只在挂载时从 defaultValue 取，不重挂就会停在用户手打的
                     字面量上，例如 7.1234567 与落库后的 7.123457 对不上）。
                     `gen` 覆盖的是「写被拒」那一侧 —— 那时汇率没变、key 不变，
                     重挂才是把非法输入清掉的唯一办法。 */
                  return (
                    <tr key={`${c.code}:${rateTable[c.code] ?? ''}:${gen}`}>
                      <td>
                        <b>{c.code}</b> <span className="muted tiny">{c.name}</span>
                      </td>
                      <td className="num">
                        {fixed ? (
                          <>
                            <span className="mono bold">1.0000</span> <span className="badge ok">固定</span>
                          </>
                        ) : (
                          <input
                            className="inp num"
                            style={{ width: 120 }}
                            defaultValue={rateTable[c.code] !== undefined ? rateText(rateTable[c.code]) : ''}
                            onBlur={e => void saveRate(c, e.target.value)}
                          />
                        )}
                      </td>
                      {/* 刻意保持字面量：原型从未给 DB.rateUpdated 赋值，基准图里这一列
                          恒为 '2026-10-03 10:00'。接上 /currencies 的 rate_updated_at 会
                          让汇率分页与基准图不一致（外观漂移），故不接 —— 见文件头第 2 条。 */}
                      <td className="mono tiny muted">{'2026-10-03 10:00'}</td>
                      <td>
                        {fixed ? null : (
                          <button className="btn xs" onClick={() => void invertRate(c)}>
                            取倒数
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Note tone="warn" style={{ marginTop: 14 }}>
            盘点时这些汇率会被带出并冻结进快照，之后修改汇率<b>不会</b>影响已保存的历史快照。
          </Note>
        </div>
      ) : tab === 'platform' ? (
        /* ============ 平台 ============ */
        <div className="card">
          <div className="card-hd">
            <h3>平台管理</h3>
            <span className="sub">改动先进草稿，点保存才生效；平台不记金额，只是账户的归属</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>备注</th>
                  <th className="num">账户数</th>
                  <th className="mid">启用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {platforms.map(p => {
                  const v = platDraft.view(p);
                  const gone = platDraft.isDeleted(p);
                  const n = accountCountOfPlatform(p.id);
                  return (
                    <tr key={p.id} className={gone ? 'draft-row-off' : undefined}>
                      <td>
                        {gone ? (
                          <>
                            <span>{v.name}</span> <span className="badge warn">待删除</span>
                          </>
                        ) : (
                          <input
                            className={'inp' + (platDraft.isDirty(p, 'name') ? ' dirty' : '')}
                            style={{ width: 130, padding: '4px 8px' }}
                            value={v.name}
                            onChange={e => platDraft.set(p, 'name', e.target.value)}
                          />
                        )}
                      </td>
                      <td>
                        {gone ? (
                          <span>{PLATFORM_TYPES.find(t => t[0] === v.type)?.[1] ?? v.type}</span>
                        ) : (
                          <select
                            className={'inp' + (platDraft.isDirty(p, 'type') ? ' dirty' : '')}
                            style={{ width: 110, padding: '4px 8px' }}
                            value={v.type}
                            onChange={e => platDraft.set(p, 'type', e.target.value)}
                          >
                            {PLATFORM_TYPES.map(t => (
                              <option key={t[0]} value={t[0]}>
                                {t[1]}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        {gone ? (
                          <span>{v.note || '—'}</span>
                        ) : (
                          <input
                            className={'inp' + (platDraft.isDirty(p, 'note') ? ' dirty' : '')}
                            style={{ width: 140, padding: '4px 8px' }}
                            value={v.note}
                            onChange={e => platDraft.set(p, 'note', e.target.value)}
                          />
                        )}
                      </td>
                      <td className="num">
                        {n ? <span className="badge ok mono">{n}</span> : <span className="muted">0</span>}
                      </td>
                      <td className="mid">
                        {gone ? (
                          <span className="muted tiny">—</span>
                        ) : (
                          <input
                            type="checkbox"
                            checked={v.enabled}
                            onChange={e => platDraft.set(p, 'enabled', e.target.checked)}
                          />
                        )}
                      </td>
                      <td>
                        <button className="btn xs danger" onClick={() => platDraft.toggleDelete(p)}>
                          {gone ? '撤销' : '删'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {platDraft.adds.map(a => {
                  const v = platDraft.viewAdd(a.key) as PlatformDTO;
                  return (
                    <tr key={a.key}>
                      <td>
                        <input
                          className="inp"
                          style={{ width: 130, padding: '4px 8px' }}
                          value={v.name}
                          onChange={e => platDraft.setAdd(a.key, 'name', e.target.value)}
                        />
                        <span className="badge ok">待新增</span>
                      </td>
                      <td>
                        <select
                          className="inp"
                          style={{ width: 110, padding: '4px 8px' }}
                          value={v.type}
                          onChange={e => platDraft.setAdd(a.key, 'type', e.target.value)}
                        >
                          {PLATFORM_TYPES.map(t => (
                            <option key={t[0]} value={t[0]}>
                              {t[1]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="inp"
                          style={{ width: 140, padding: '4px 8px' }}
                          placeholder="备注（可选）"
                          value={v.note}
                          onChange={e => platDraft.setAdd(a.key, 'note', e.target.value)}
                        />
                      </td>
                      <td className="num muted">0</td>
                      <td className="mid">
                        <input
                          type="checkbox"
                          checked={v.enabled}
                          onChange={e => platDraft.setAdd(a.key, 'enabled', e.target.checked)}
                        />
                      </td>
                      <td>
                        <button className="btn xs" onClick={() => platDraft.removeAdd(a.key)}>
                          撤销
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="hr" />
          <div className="flex" style={{ gap: 8 }}>
            <input
              className="inp"
              placeholder="平台名称"
              style={{ width: 170 }}
              value={newPlat.name}
              onChange={e => setNewPlat(v => ({ ...v, name: e.target.value }))}
            />
            <select
              className="inp"
              style={{ width: 130 }}
              value={newPlat.type}
              onChange={e => setNewPlat(v => ({ ...v, type: e.target.value }))}
            >
              {PLATFORM_TYPES.map(t => (
                <option key={t[0]} value={t[0]}>
                  {t[1]}
                </option>
              ))}
            </select>
            <button className="btn pri" onClick={stagePlatform}>
              ＋ 新增平台
            </button>
          </div>
          <DraftBar
            count={dirtyOf.platform}
            saving={saving}
            onDiscard={platDraft.reset}
            onSave={() => void commitGroup(PLATFORM_SPEC, platDraft, platforms)}
          />
          <Note tone="info" style={{ marginTop: 12 }}>
            平台改名后，历史快照仍按<b>平台 ID</b> 匹配，两期对比不会错位。
          </Note>
        </div>
      ) : tab === 'category' ? (
        /* ============ 分类 ============ */
        <>
          {(['asset', 'liability'] as const).map(type => (
            <CategoryBlock
              key={type}
              type={type}
              draft={catDraft}
              categories={categories}
              countOf={accountCountOfCategory}
              draftName={newCat[type]}
              onDraftName={v => setNewCat(prev => ({ ...prev, [type]: v }))}
              onStage={() => stageCategory(type)}
            />
          ))}
          <DraftBar
            count={dirtyOf.category}
            saving={saving}
            onDiscard={catDraft.reset}
            onSave={() => void commitGroup(CATEGORY_SPEC, catDraft, categories)}
          />
        </>
      ) : tab === 'tag' ? (
        /* ============ 标签 ============ */
        <div className="card">
          <div className="card-hd">
            <h3>标签管理</h3>
            <span className="sub">改动先进草稿，点保存才生效；跨平台、跨分类的自定义属性，一个账户可有多个</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>标签名</th>
                  <th className="num">使用账户数</th>
                  <th className="mid">启用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tags.map(t => {
                  const v = tagDraft.view(t);
                  const gone = tagDraft.isDeleted(t);
                  const n = accountCountOfTag(t.id);
                  return (
                    <tr key={t.id} className={gone ? 'draft-row-off' : undefined}>
                      <td>
                        {gone ? (
                          <>
                            <span>{v.name}</span> <span className="badge warn">待删除</span>
                          </>
                        ) : (
                          <input
                            className={'inp' + (tagDraft.isDirty(t, 'name') ? ' dirty' : '')}
                            style={{ width: 150, padding: '4px 8px' }}
                            value={v.name}
                            onChange={e => tagDraft.set(t, 'name', e.target.value)}
                          />
                        )}
                      </td>
                      <td className="num">
                        {n ? <span className="badge ok mono">{n}</span> : <span className="muted">0</span>}
                      </td>
                      <td className="mid">
                        {gone ? (
                          <span className="muted tiny">—</span>
                        ) : (
                          <input
                            type="checkbox"
                            checked={v.enabled}
                            onChange={e => tagDraft.set(t, 'enabled', e.target.checked)}
                          />
                        )}
                      </td>
                      <td>
                        <button className="btn xs danger" onClick={() => tagDraft.toggleDelete(t)}>
                          {gone ? '撤销' : '删'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {tagDraft.adds.map(a => {
                  const v = tagDraft.viewAdd(a.key) as TagDTO;
                  return (
                    <tr key={a.key}>
                      <td>
                        <input
                          className="inp"
                          style={{ width: 150, padding: '4px 8px' }}
                          value={v.name}
                          onChange={e => tagDraft.setAdd(a.key, 'name', e.target.value)}
                        />
                        <span className="badge ok">待新增</span>
                      </td>
                      <td className="num muted">0</td>
                      <td className="mid">
                        <input
                          type="checkbox"
                          checked={v.enabled}
                          onChange={e => tagDraft.setAdd(a.key, 'enabled', e.target.checked)}
                        />
                      </td>
                      <td>
                        <button className="btn xs" onClick={() => tagDraft.removeAdd(a.key)}>
                          撤销
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="hr" />
          <div className="flex" style={{ gap: 8 }}>
            <input
              className="inp"
              placeholder="新标签名"
              style={{ width: 170 }}
              value={newTag}
              onChange={e => setNewTag(e.target.value)}
            />
            <button className="btn pri" onClick={stageTag}>
              ＋ 新增标签
            </button>
          </div>
          <DraftBar
            count={dirtyOf.tag}
            saving={saving}
            onDiscard={tagDraft.reset}
            onSave={() => void commitGroup(TAG_SPEC, tagDraft, tags)}
          />
          <Note tone="info" style={{ marginTop: 12 }}>
            标签横跨账户 → 盘点 → 快照 → 汇总 → 对比 → 报表，属于重资产维度。标签分组的精细管理在 P2（REQ-023）。
          </Note>
        </div>
      ) : tab === 'io' ? (
        /* ============ 导入导出（Step 5 接通，见 DataTabs.tsx） ============ */
        <IoPanel snapshotList={snapshotList} />
      ) : tab === 'backup' ? (
        /* ============ 备份恢复（Step 5 接通，见 DataTabs.tsx） ============ */
        <BackupPanel
          settings={settings}
          snapshotCount={snapshotList.length}
          accountCount={accounts.length}
        />
      ) : (
        /* ============ 关于 ============ */
        /* 2026-10-05：在应用信息之下加「作者品牌区」。
           四块内容各自换容器，而不是排成四个同级小标题 ——
           作者卡是「名片」（--paper-3 底 + 8px 左竖线 + 姓氏方块标），
           「为什么做这个」是引言（同一套左竖线，但去掉整圈边框，靠这一层差异与名片分开），
           「产品理念」是并列主张（黄底黑边小方块的列表），
           「联系方式」用两列网格收口。样式全在 mount.css 的 `.about-*` 段。
           ⚠ 上面的「产品」行是产品名的三个「单一来源」之一（另两处：
             Sidebar.tsx 的 .brand-txt、app/web/index.html 的 <title>），改名字要三处同改。
           ⚠ 原「开发者」行已删：邮箱只在「联系方式」出现一次，避免同一页两处重复。 */
        <div className="card">
          <div className="card-hd">
            <h3>关于</h3>
          </div>
          <div className="kv" style={{ maxWidth: 420 }}>
            <span className="kk">产品</span>
            <span className="vv">家底快照 —— 记录你的净值轨迹</span>
            <span className="kk">版本</span>
            <span className="vv">{`v${settings?.app_version ?? '—'}`}</span>
            <span className="kk">schema_version</span>
            <span className="vv">{settings?.schema_version ?? '—'}</span>
            <span className="kk">形态</span>
            <span className="vv">单端本地应用 · 无服务端 · 可离线</span>
            <span className="kk">存储</span>
            <span className="vv">本地 SQLite</span>
          </div>

          <div className="hr" />

          <div className="about-author">
            <div className="about-mark" aria-hidden="true">
              C
            </div>
            <div className="about-author-txt">
              <div className="about-name">Carson</div>
              <div className="about-role">独立开发者，关注个人财务与效率工具</div>
            </div>
          </div>

          <div className="about-sec">
            <h4>为什么做这个</h4>
            <div className="about-quote">
              我自己有境外银行、券商、支付宝多个账户，币种也不同。市面上的工具要么太重，要么要记账，要么不支持多币种。我只想每隔一段时间盘一下，看看净值变化。于是做了家底快照。
            </div>
          </div>

          <div className="about-sec">
            <h4>产品理念</h4>
            <ul className="about-list">
              <li>
                <b>轻量优先</b>
                <span>不做记账，只做盘点</span>
              </li>
              <li>
                <b>数据自持</b>
                <span>本地存储，可导出备份</span>
              </li>
              <li>
                <b>克制功能</b>
                <span>只做真正需要的</span>
              </li>
            </ul>
          </div>

          <div className="about-sec">
            <h4>联系方式</h4>
            <div className="about-contact">
              <span className="k">邮箱</span>
              <span>
                <a href="mailto:casum.liang@gmail.com">casum.liang@gmail.com</a>
              </span>
              <span className="k">X / Twitter</span>
              <span className="about-none">— 暂未提供</span>
              <span className="k">GitHub</span>
              <span className="about-none">— 暂未提供</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================================================
   草稿保存条（#5）
   ============================================================ */

function DraftBar({
  count,
  saving,
  onDiscard,
  onSave
}: {
  count: number;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  /* 无改动时整条不渲染 —— 设置页的基准图拍的是「本位币」分页，
     但那只是运气；这一条让另外四个分页在「什么都没改」时也与改动前逐像素一致。 */
  if (!count) return null;
  return (
    <div className="draft-bar" data-draft-bar={count}>
      <span className="badge warn">{`${count} 项未保存`}</span>
      <span className="tiny muted">改动只在本地，点「保存」才写入</span>
      <span className="spacer" style={{ flex: 1 }} />
      <button className="btn" onClick={onDiscard} disabled={saving}>
        放弃
      </button>
      <button className="btn pri" onClick={onSave} disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  );
}

/* ============================================================
   分类分页（资产 / 负债各一块）
   ============================================================ */

function CategoryBlock({
  type,
  draft,
  categories,
  countOf,
  draftName,
  onDraftName,
  onStage
}: {
  type: 'asset' | 'liability';
  draft: Draft<CategoryDTO>;
  categories: readonly CategoryDTO[];
  countOf: (id: string) => number;
  /** 新增输入框的值（原型两个块各有一个 input，这里按类型分槽存同一份 state） */
  draftName: string;
  onDraftName: (v: string) => void;
  onStage: () => void;
}): ReactNode {
  const label = type === 'asset' ? '资产' : '负债';
  return (
    <div className="card" key={type}>
      <div className="card-hd">
        <h3>{`${label}分类`}</h3>
        <span className="sub">
          {type === 'asset' ? '可配置「默认跟踪本金」' : '负债账户不可开启本金跟踪'}
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>分类名</th>
              <th className="mid">默认跟踪本金</th>
              <th className="num">账户数</th>
              <th className="mid">启用</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {categories
              .filter(c => c.type === type)
              .map(c => {
                const v = draft.view(c);
                const gone = draft.isDeleted(c);
                const n = countOf(c.id);
                return (
                  <tr key={c.id} className={gone ? 'draft-row-off' : undefined}>
                    <td>
                      {gone ? (
                        <>
                          <span>{v.name}</span> <span className="badge warn">待删除</span>
                        </>
                      ) : (
                        <input
                          className={'inp' + (draft.isDirty(c, 'name') ? ' dirty' : '')}
                          style={{ width: 130, padding: '4px 8px' }}
                          value={v.name}
                          onChange={e => draft.set(c, 'name', e.target.value)}
                        />
                      )}
                    </td>
                    <td className="mid">
                      {type === 'asset' && !gone ? (
                        <label className="chk" style={{ justifyContent: 'center' }}>
                          <input
                            type="checkbox"
                            checked={v.default_track_principal}
                            onChange={e => draft.set(c, 'default_track_principal', e.target.checked)}
                          />
                        </label>
                      ) : (
                        <span className="muted tiny">{type === 'asset' ? '—' : '不适用'}</span>
                      )}
                    </td>
                    <td className="num">
                      {n ? <span className="badge ok mono">{n}</span> : <span className="muted">0</span>}
                    </td>
                    <td className="mid">
                      {gone ? (
                        <span className="muted tiny">—</span>
                      ) : (
                        <input
                          type="checkbox"
                          checked={v.enabled}
                          onChange={e => draft.set(c, 'enabled', e.target.checked)}
                        />
                      )}
                    </td>
                    <td>
                      <button className="btn xs danger" onClick={() => draft.toggleDelete(c)}>
                        {gone ? '撤销' : '删'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            {draft.adds
              .filter(a => a.row.type === type)
              .map(a => {
                const v = draft.viewAdd(a.key) as CategoryDTO;
                return (
                  <tr key={a.key}>
                    <td>
                      <input
                        className="inp"
                        style={{ width: 130, padding: '4px 8px' }}
                        value={v.name}
                        onChange={e => draft.setAdd(a.key, 'name', e.target.value)}
                      />
                      <span className="badge ok">待新增</span>
                    </td>
                    <td className="mid">
                      {type === 'asset' ? (
                        <label className="chk" style={{ justifyContent: 'center' }}>
                          <input
                            type="checkbox"
                            checked={v.default_track_principal}
                            onChange={e => draft.setAdd(a.key, 'default_track_principal', e.target.checked)}
                          />
                        </label>
                      ) : (
                        <span className="muted tiny">不适用</span>
                      )}
                    </td>
                    <td className="num muted">0</td>
                    <td className="mid">
                      <input
                        type="checkbox"
                        checked={v.enabled}
                        onChange={e => draft.setAdd(a.key, 'enabled', e.target.checked)}
                      />
                    </td>
                    <td>
                      <button className="btn xs" onClick={() => draft.removeAdd(a.key)}>
                        撤销
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <div className="flex" style={{ gap: 8, marginTop: 12 }}>
        <input
          className="inp"
          placeholder="新分类名"
          style={{ width: 170 }}
          value={draftName}
          onChange={e => onDraftName(e.target.value)}
        />
        <button className="btn pri" onClick={onStage}>
          {`＋ 新增${label}分类`}
        </button>
      </div>
    </div>
  );
}
