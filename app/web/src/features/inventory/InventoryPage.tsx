/**
 * InventoryPage.tsx —— 盘点向导（PRD §3.3.1 §6.1 §6.2）
 *
 * 对应原型的 `renderInventory` 及其四个步骤：选择日期 → 确认汇率 → 录入金额 → 确认保存。
 *
 * ── 两处与原型不同的实现选择，都是为了「口径不漂移」──
 * 1. 上次金额（`prevItemForInventory`）与实时收益预览（`returnsOf`）直接用 `@app/domain`：
 *    这两个函数就是服务端的同一份代码，前端重写一份必然会漂。
 *    代价是把全部快照的明细读进浏览器 —— fixture 已全量预热，所以不产生额外请求。
 * 2. 实时汇总用 `planItems` + `inventoryTotals`，而不是「逐行 number 相乘后相加」。
 *    原型是浮点累加再 `r2()`，领域层是 bigint 定点 —— 后者才是保存后的权威值，
 *    预览必须与保存后一致，否则会出现「确认页显示 A、保存后是 B」。
 *
 * ── 与原型一致、容易被误改的地方 ──
 * · 步骤同时存两处：URL（`#inventory?step=`，深链与截图用）与本地 state（交互用）。
 *   URL 是契约来源 —— App 顶栏的 `route.invStep < 4` 也读它。
 * · 「上次金额」列取进入向导时算出的 `entry.prev`，而「收益预览」按**当次** `inv.date`
 *   现算 —— 原型的 `invRefreshRow` 就是这么做的，日期被改过时两者会不同。
 *
 * 2026-10-04 第二批界面需求 #6：收益预览列**不再显示「首期」**，直接给「本次金额 − 本金」
 *   （即 `returnsOf().cum`，它不依赖上期基准）。实现见 `InvRow` 的 `retNode`。
 * · Step 4 的布局由 `inv.lastSaved` 驱动；它只在**本次保存成功**后才有值，
 *   因此深链到 `#inventory?step=4` 会看到兜底卡片 —— 这是对的，刷新后不该假装刚保存过。
 *
 * ── Step 4 接上写入路径后的三处结构变化（改动的边界就在这里）──
 * · **草稿由服务端持有**：进入向导先 `POST /inventory/session`，有草稿就恢复；
 *   之后每次改动防抖 700ms 落一次 `PUT /inventory/draft`（带 `version` 乐观锁）。
 *   界面上**不加任何状态指示** —— 原型没有，加了就是外观漂移。
 * · **确认页取服务端权威计数**：`POST /inventory/preview`。两处调的是同一份
 *   `@app/planItems`，"确认页显示 A、保存后是 B" 在结构上不可能发生；
 *   服务端多算出来的部分（客户端漏送的账户）也能在这里被发现。
 * · **离线源（`?data=fixture`）下全部写路径只跳过行为、不改 DOM**：
 *   `writable()` 为 false 时不发请求、点按钮给一条提示。按钮该长什么样还是什么样 ——
 *   基准图里它们都在，少一个或加个 `disabled` 就比对不过。
 *
 * ── 2026-10-04 第三批 ──
 * · #8（金额支持 2 位小数）：金额 / 本金 / 第 2 步的汇率框全部换成 `DecimalInput`。
 *   原先三处都是「受控 + `value={String(...)}`」，敲「123.」时 `Number('123.') === 123`
 *   会把小数点当场抹掉 —— 小数根本打不进去。**第 2 步的汇率框是同一处缺陷**：
 *   `value={rates[c] ?? 0}` 让 JPY 的 0.0486 在界面上实际改不动。
 *   同一处顺带把行级「折本位币」从 `money(…, 0)` 改成 `moneyAuto`，
 *   否则带分位的金额在列表里会被显示成整数（演示数据有 19/144 条带分位）。
 * · #1 / #2（实时汇率）：第 2 步的汇率表头加「获取实时汇率」，走
 *   `lib/refreshRates.ts`（与服务端 `/rates/refresh` 一对一）。它是**整表覆盖**，
 *   所以在用户已改过本步汇率时先确认一次（`refreshRatesHere`）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AccountDTO,
  CategoryDTO,
  CurrencyDTO,
  InventoryDraftDTO,
  InventoryPreviewDTO,
  InventorySessionDTO,
  PlatformDTO,
  ReturnsPanelDTO,
  SnapshotDTO,
  SnapshotSummaryDTO
} from '@app/shared';
import {
  Money,
  inventoryTotals,
  planItems,
  prevItemForInventory,
  returnsOf,
  type Account,
  type EntryDraft,
  type EntryState,
  type PrevRef,
  type Snapshot,
  type SnapshotItem
} from '@app/domain';
import { cached, ep, useApi, usePaths, writable } from '../../api/index.ts';
import { dtoAccountToDomain, dtoSnapshotToDomain } from '../../lib/adapt.ts';
import { getBaseCurrency, microOf, money, moneyAuto, pctText, todayISO, toYuan, yuanOf } from '../../lib/money.ts';
import { dailySeries } from '../../lib/series.ts';
import { Collapse } from '../../components/Collapse.tsx';
import { CurBadge, EmptyBox, Note, RoleDot } from '../../components/Atoms.tsx';
import { DecimalInput } from '../../components/DecimalInput.tsx';
import { Delta, Pct } from '../../components/Delta.tsx';
import { useToast } from '../../components/Toast.tsx';
import { ChartBox } from '../../components/charts/ChartBox.tsx';
import { LineChart } from '../../components/charts/LineChart.tsx';
import {
  fromEntriesDTO,
  isIsoDate,
  openSession,
  previewSnapshot,
  putDraft,
  saveSnapshot
} from './session.ts';
import { yuanFromMicro } from '../../lib/units.ts';
import { refreshRates, refreshSummary } from '../../lib/refreshRates.ts';
import { messageOf, problemOf } from '../../api/problem.ts';
import type { View } from '../../router.ts';

interface ListResponse<T> {
  items: T[];
}

/* ============================================================
   向导状态（原型的 UI.inv）
   ============================================================ */

interface Entry {
  /** 「元」数值，null 表示未填 */
  amount: number | null;
  principal: number | null;
  state: EntryState;
  /** 进入向导时算出的「上次明细」，供「上次金额」列使用 */
  prev: SnapshotItem | null;
  prevDate: string | null;
  touched: boolean;
}

interface InvState {
  date: string;
  note: string;
  /**
   * 元 / 单位原币，缺省来自 `/rates`。
   *
   * `null` = **用户把这一格清空了**（不是 0）——#8 之后汇率框能真正被清空，
   * 落草稿时会整条丢掉、由服务端 DB 汇率兜底（见 session.ts 的 `toRatesDTO`）。
   * 计算侧一律 `?? 0`，与服务端「缺汇率就该被门禁拦下」的口径一致。
   */
  rates: Record<string, number | null>;
  entries: Record<string, Entry>;
  groupBy: 'platform' | 'currency';
  showArchived: boolean;
  confirmed: boolean;
  /** 保存成功后的快照 id。Step 3 没有写入路径，因此恒为 null */
  lastSaved: string | null;
}

interface RowGroup {
  key: string;
  name: string;
  list: Account[];
}

/**
 * 「录入金额」表的列模板（需求 #9：分类与币种从账户名下面拆出来做独立列）。
 * 表头行与数据行共用这一份定义，改列宽只需改这里。
 */
const GRID = '1.5fr 104px 76px 96px 128px 116px 128px 150px 76px';
/** 列变多后给内部一个最小宽度，配合容器的横向滚动 */
const GRID_MIN_WIDTH = 1080;
const STEPS = ['选择日期', '确认汇率', '录入金额与本金', '确认并保存'];

export function InventoryPage({
  step,
  onStepChange,
  accounts,
  platforms,
  snapshotList,
  onNavigate,
  onOpenSnapshot,
  onCompare
}: {
  step: number;
  onStepChange: (s: number) => void;
  accounts: readonly AccountDTO[];
  platforms: readonly PlatformDTO[];
  snapshotList: readonly SnapshotSummaryDTO[];
  onNavigate: (view: View) => void;
  /** 保存成功后跳去刚生成的那张快照 */
  onOpenSnapshot: (snapshotId: string) => void;
  /** 保存成功后与上一期对比 */
  onCompare: (snapshotId: string) => void;
}) {
  const toast = useToast();
  const base = getBaseCurrency();
  const canWrite = writable();
  const currencies = useApi<ListResponse<CurrencyDTO>>(ep.currencies(true));
  const categories = useApi<ListResponse<CategoryDTO>>(ep.categories(true));
  const rates = useApi<{ base_currency: string; rates: Record<string, number> }>(ep.rates());

  const snapPaths = snapshotList.map(s => ep.snapshot(s.id, 'origin'));
  usePaths(snapPaths);

  /* 全部快照的明细：上次金额与收益预览的唯一来源。
   *
   * 这里**刻意不用 `useMemo`**。`cached()` 读的是模块级缓存，而缓存是**异步**填进来的：
   * 路径（`snapPaths`）没变、数据到了，以路径为依赖的 memo 不会重算，
   * `series` 就会永远停在空数组上 —— 表现为 `localReady` 恒为 false，
   * 向导永久停在「正在准备盘点数据…」。
   *
   * 为什么 Step 3 没暴露：那时的数据源是离线 fixture，`cached()` **同步**就有值，
   * 首帧算出来的就是最终值。Step 4 默认换成 HTTP 之后这个 memo 才变成缺陷。
   *
   * `usePaths` 会在数据到达后强制重渲染，所以每次渲染直接读缓存拿到的就是最新值。
   * 与设置页 `snapDocs` 的写法保持一致（那里本来就没有 memo）。 */
  const series: Snapshot[] = snapPaths
    .map(p => cached<SnapshotDTO>(p))
    .filter((d): d is SnapshotDTO => d !== null)
    .map(dtoSnapshotToDomain);

  const domAccounts: Account[] = useMemo(() => accounts.map(dtoAccountToDomain), [accounts]);

  /* ---- 服务端会话（离线源不开会：一切走本地，行为与 Step 3 完全一致） ---- */
  const [session, setSession] = useState<InventorySessionDTO | null>(null);
  const [sessionErr, setSessionErr] = useState<Error | null>(null);

  useEffect(() => {
    if (!canWrite) return;
    let alive = true;
    setSessionErr(null);
    openSession().then(
      s => alive && setSession(s),
      (e: Error) => alive && setSessionErr(e)
    );
    return () => {
      alive = false;
    };
  }, [canWrite]);

  const [inv, setInv] = useState<InvState | null>(null);

  /* 相当于原型的 invFresh()：序列、汇率、会话都就绪后初始化一次。
     会话失败（令牌失效等）不挡住向导 —— 本地照常能算能看，只是保存会失败并给出原因。 */
  const localReady = snapshotList.length === 0 || series.length === snapshotList.length;
  const sessionSettled = !canWrite || session !== null || sessionErr !== null;

  useEffect(() => {
    if (inv || !localReady || !sessionSettled || !rates.data) return;
    const fresh = freshState(series, domAccounts, rates.data.rates, base);
    const draft = session?.draft ?? null;
    if (draft) {
      setInv(mergeDraft(fresh, draft, base));
      toast('已恢复上次未完成的盘点草稿', 'info', 2800);
    } else {
      setInv(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv, localReady, sessionSettled, series, domAccounts, rates.data]);

  /* ---- 草稿自动保存（草稿由服务端持有）---- */
  const versionRef = useRef<number | null>(null);
  const savedSigRef = useRef('');
  const busyRef = useRef(false);
  const latestRef = useRef<{ state: InvState; sig: string } | null>(null);

  /* 只依赖「会落进草稿的那些字段」。整对象比较会让定时器在每次渲染都被重置 */
  const draftSig = useMemo(() => {
    if (!inv) return '';
    const rows = Object.entries(inv.entries).map(([k, e]) => [k, e.amount, e.principal, e.state]);
    /* 汇率也要进签名：Step 2 改完就退出，是用户最可能踩的一次「白改」 */
    const rates = Object.entries(inv.rates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([inv.date, inv.note, rows, rates]);
  }, [inv]);

  useEffect(() => {
    latestRef.current = inv ? { state: inv, sig: draftSig } : null;
  }, [inv, draftSig]);

  const flushDraft = useCallback(async (): Promise<void> => {
    const snap = latestRef.current;
    if (!canWrite || !snap || busyRef.current) return;
    if (snap.sig === savedSigRef.current) return;
    /* 日期被清空时不落草稿：服务端的 date 是必填的 ISO 日期，空串会被 400 拒掉 */
    if (!isIsoDate(snap.state.date)) return;
    busyRef.current = true;
    try {
      versionRef.current = await putDraft(
        versionRef.current,
        snap.state.date,
        snap.state.note,
        snap.state.entries,
        snap.state.rates
      );
      savedSigRef.current = snap.sig;
    } catch (err) {
      const p = problemOf(err);
      if (p?.code === 'CONFLICT') {
        /* 多标签页：把版本对齐到服务端当前值，用户下次改动就能落上，不打断盘点 */
        const v = p.details.current_version;
        if (typeof v === 'number') versionRef.current = v;
        toast('草稿已在另一个标签页被修改；你这次的改动会覆盖它', 'warn', 3600);
      }
      /* 其它错误（离线、令牌失效）不提示：草稿是便利功能，不该打断盘点。
         真到保存那一步失败时会给出明确原因 */
    } finally {
      busyRef.current = false;
    }
  }, [canWrite, toast]);

  useEffect(() => {
    if (!canWrite || !inv || !isIsoDate(inv.date)) return;
    if (draftSig === savedSigRef.current) return;
    const t = window.setTimeout(() => void flushDraft(), 700);
    return () => window.clearTimeout(t);
  }, [draftSig, canWrite, inv, flushDraft]);

  /* 离开向导（含顶栏「退出（保存草稿）」）时补最后一次改动。
     不能 await —— 这是卸载清理，React 不等它；丢了也只是回到上一次自动保存点。 */
  useEffect(() => {
    if (!canWrite) return;
    return () => void flushDraft();
  }, [canWrite, flushDraft]);

  /* ---- 确认页的服务端权威试算（离线源跳过，退回本地计数） ---- */
  const onConfirmStep = step >= 3.5 && step < 4;
  const [preview, setPreview] = useState<InventoryPreviewDTO | null>(null);

  useEffect(() => {
    if (!canWrite || !onConfirmStep || !inv || !isIsoDate(inv.date)) {
      setPreview(null);
      return;
    }
    let alive = true;
    previewSnapshot(inv.date, inv.entries, inv.rates).then(
      r => alive && setPreview(r),
      () => alive && setPreview(null) // 试算失败不挡保存：退回本地计数
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, onConfirmStep, inv?.date, draftSig]);

  const [saving, setSaving] = useState(false);
  /* 「获取实时汇率」的进行中状态。**必须声明在这个早退之前** ——
     下面 `if (!inv) return …` 之后就再也不能加 Hook 了（调用顺序会变）。 */
  const [refreshingRates, setRefreshingRates] = useState(false);

  if (!inv) {
    return (
      <div className="card">
        <EmptyBox text="正在准备盘点数据…" />
      </div>
    );
  }

  /* 早退之后 inv 必非 null；显式取一份 const，闭包里就天然有类型 */
  const cur: InvState = inv;
  const patchInv = (p: Partial<InvState>) => setInv(prev => (prev ? { ...prev, ...p } : prev));

  const platformName = (id: string | null) => (id ? platforms.find(p => p.id === id)?.name ?? id : '未指定平台');
  const categoryName = (id: string) => categories.data?.items.find(c => c.id === id)?.name ?? '';

  const visible = (cur.showArchived ? domAccounts : domAccounts.filter(a => !a.archived)).sort(
    (a, b) => a.sort - b.sort
  );

  /* 汇率查表：本位币恒为 1；缺失币种按 0（保存前会被缺汇率门禁拦下） */
  const rateOf = (code: string) => (code === base ? 1 : cur.rates[code] ?? 0);

  const drafts: Record<string, EntryDraft> = {};
  for (const a of visible) {
    const e = cur.entries[a.id];
    if (!e) continue;
    drafts[a.id] = { accountId: a.id, amount: e.amount, principal: e.principal, state: e.state, touched: e.touched };
  }
  const totals = inventoryTotals(planItems(visible, drafts, rateOf));

  const curStep = Math.min(Math.ceil(step), 4);
  /* 同日重复：确认页优先用服务端的判断（它数的是真正落库的那批日期） */
  const dup = preview?.duplicate_date ?? snapshotList.some(s => s.date === cur.date);
  const archivedCount = domAccounts.filter(a => a.archived).length;
  const usedCurs = usedCurrencies(domAccounts);

  return (
    <>
      <div className="steps">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const cls = curStep === n ? 'on' : curStep > n ? 'done' : '';
          return (
            <div className={'step ' + cls} key={s}>
              <span className="n">{curStep > n ? '✓' : n}</span>
              <span className="lb">{s}</span>
            </div>
          );
        })}
      </div>

      {step === 1 ? (
        <Step1
          date={cur.date}
          note={cur.note}
          dup={dup}
          onDate={v => patchInv({ date: v })}
          onNote={v => patchInv({ note: v })}
          onNext={() => onStepChange(2)}
        />
      ) : step === 2 ? (
        <Step2
          base={base}
          usedCurs={usedCurs}
          currencies={currencies.data?.items ?? []}
          rates={cur.rates}
          onRate={(code, v) => patchInv({ rates: { ...cur.rates, [code]: v } })}
          refreshing={refreshingRates}
          onRefresh={() => void refreshRatesHere()}
          onPrev={() => onStepChange(1)}
          onNext={() => onStepChange(3)}
        />
      ) : step === 3 ? (
        <Step3
          inv={cur}
          base={base}
          totals={totals}
          visible={visible}
          archivedCount={archivedCount}
          series={series}
          platformName={platformName}
          categoryName={categoryName}
          onGroupBy={v => patchInv({ groupBy: v })}
          onToggleArchived={() => patchInv({ showArchived: !cur.showArchived })}
          onAmount={setAmount}
          onPrincipal={setPrincipal}
          onFillAllCarry={fillAllCarry}
          onPrev={() => onStepChange(2)}
          onNext={toConfirm}
        />
      ) : step < 4 ? (
        <StepConfirm
          inv={cur}
          base={base}
          dup={dup}
          totals={totals}
          preview={preview}
          accounts={domAccounts}
          platformName={platformName}
          onBack={() => onStepChange(3)}
          onToggleConfirmed={v => patchInv({ confirmed: v })}
          onSave={saveNow}
        />
      ) : (
        <StepDone
          inv={cur}
          snapshotList={snapshotList}
          onNavigate={onNavigate}
          onOpenSnapshot={onOpenSnapshot}
          onCompare={onCompare}
        />
      )}
    </>
  );

  /* ---------------- 交互（等价于原型的 invSetAmount / invSetPrincipal / …） ---------------- */

  function setAmount(id: string, v: number | null): void {
    const e = cur.entries[id];
    if (!e) return;
    /* #8 之后这里收到的是**已经解析好的数**（输入的文本态归 `DecimalInput` 管），
       所以不再需要「先 parseFloat、再判定是否有限」那一段 —— 非法输入在控件里
       就已经收敛成 null，与领域层 `resolveAmountInput` 同一口径：一律按「空」处理。 */
    const next: Entry =
      v === null
        ? { ...e, amount: null, state: e.prev ? 'carry' : 'unfilled', touched: false }
        : { ...e, amount: v, state: 'filled', touched: true };
    patchInv({ entries: { ...cur.entries, [id]: next } });
  }

  function setPrincipal(id: string, v: number | null): void {
    const e = cur.entries[id];
    if (!e) return;
    patchInv({ entries: { ...cur.entries, [id]: { ...e, principal: v } } });
  }

  function fillAllCarry(): void {
    const entries = { ...cur.entries };
    let hit = 0;
    for (const a of visible) {
      const e = entries[a.id];
      if (e && e.prev && (e.amount === null || e.amount === undefined)) {
        entries[a.id] = { ...e, amount: e.prev.original_amount.toNumber(), state: 'carry' };
        hit++;
      }
    }
    patchInv({ entries });
    if (hit) toast(`已把 ${hit} 个有历史金额的账户设为「沿用上次」`, 'ok');
    else toast('没有可沿用的账户', 'info');
  }

  /**
   * 第 2 步的「获取实时汇率」（#1 / #2）。
   *
   * 这一步的汇率表是**本地编辑中的一份**（`inv.rates`，单位「元」），与服务端的默认
   * 汇率表是两份东西 —— 服务端刷新只改后者，所以这里还必须把返回值合进 `inv.rates`，
   * 否则用户点了按钮、表格却一个数字都没动。合成后照常走草稿自动保存（`draftSig`
   * 把 `rates` 算进去了），退出再进来不会白改一场。
   *
   * **覆盖前先问一句**：本步允许逐条改汇率，而刷新是整表替换。若用户已经改过几项，
   * 直接覆盖就是把他刚填的东西悄悄抹掉 —— 这是那种「点完才发现」的损失，
   * 值得一次确认。判据是「与 `/rates` 给的默认值不同」，不是「这一格被点过」：
   * 改回原值等于没改，那时不该多问。
   */
  async function refreshRatesHere(): Promise<void> {
    if (refreshingRates) return;
    const defaults = rates.data?.rates ?? {};
    const edited = usedCurs.filter(code => {
      const def = defaults[code];
      return def !== undefined && cur.rates[code] !== def / 1e6;
    });
    if (edited.length) {
      const ok = window.confirm(
        `你已在本步改过 ${edited.join('、')} 的汇率。获取实时汇率会用源上的值覆盖整张表，继续吗？`
      );
      if (!ok) return;
    }
    setRefreshingRates(true);
    const res = await refreshRates();
    setRefreshingRates(false);
    if (!res.ok) {
      toast(res.message, res.offline ? 'warn' : 'err', 4600);
      return;
    }
    /* 微元 → 元（与 freshState 同一条换算）；本位币强制为 1 ——
       服务端返回的它本来就是 1，但这类恒等值一律直接赋值，不让浮点参与。 */
    const next: Record<string, number | null> = {};
    for (const [code, micro] of Object.entries(res.dto.rates)) next[code] = micro / 1e6;
    next[base] = 1;
    patchInv({ rates: next });
    const s = refreshSummary(res.dto);
    toast(s.text, s.tone, 4800);
  }

  function toConfirm(): void {
    /* 与原型 invToConfirm 的三条门禁一致：负债填负 / 缺汇率 / 本金为负。
       服务端还会用同一份规则再校验一次（那是权威）；这里只是让用户不必白跑一趟。 */
    for (const id of Object.keys(cur.entries)) {
      const e = cur.entries[id];
      const a = domAccounts.find(x => x.id === id);
      if (!a || e.state === 'unfilled' || e.amount === null) continue;
      if (a.type === 'liability' && e.amount < 0) {
        toast(`「${a.name}」是负债账户，金额必须填正数`, 'err');
        return;
      }
      if (rateOf(a.currency) <= 0) {
        toast(`币种 ${a.currency} 的汇率无效，请回到上一步填写`, 'err');
        return;
      }
      if (a.track_principal && e.principal !== null && e.principal < 0) {
        toast(`「${a.name}」本金必须为非负数`, 'err');
        return;
      }
    }
    /* 回到确认页必须重新勾选（与原型一致）：确认位是对「这一次的清单」的确认 */
    patchInv({ confirmed: false });
    onStepChange(3.5);
  }

  /**
   * 保存快照（`POST /inventory/snapshots`）。
   *
   * 服务端是权威：门禁（负债填负 / 缺汇率 / 本金为负）与「未填写清单」都由它重新算一遍。
   * 因此这里的失败处理不是「猜哪里错了」，而是**把服务端的原话转述给用户**：
   *   · 422 且 `confirm_required` → 有账户本次未填写，需要用户确认；
   *   · 其它 422 → 服务端给的门禁文案（例如某一项汇率无效）；
   *   · 网络 / 401 → 原样透出。
   */
  async function saveNow(): Promise<void> {
    if (!cur.confirmed) {
      toast('请先勾选「我已确认以上内容」', 'warn');
      return;
    }
    if (saving) return;
    if (!isIsoDate(cur.date)) {
      toast('盘点日期无效，请回到第 1 步重新选择', 'err');
      return;
    }
    setSaving(true);
    try {
      const res = await saveSnapshot(cur.date, cur.note, cur.entries, cur.rates, true);
      /* 服务端保存成功后已一并丢弃草稿，本地版本号跟着归零 */
      versionRef.current = null;
      savedSigRef.current = '';
      patchInv({ lastSaved: res.snapshot.id, confirmed: false });
      onStepChange(4);
      toast(`快照已保存 · 净资产 ${money(res.snapshot.net_worth, 0)}`, 'ok', 3600);
    } catch (err) {
      const p = problemOf(err);
      if (p?.code === 'RULE_VIOLATION' && p.details.confirm_required) {
        toast('有账户本次「未填写」，请勾选确认后重新保存', 'warn', 4000);
      } else if (p?.code === 'RULE_VIOLATION') {
        toast(messageOf(err), 'err', 4000);
      } else if (p?.code === 'CONFLICT') {
        toast(`${messageOf(err)}（草稿已在别处被修改，请退出后重新开始）`, 'err', 4000);
      } else {
        toast(`保存失败：${messageOf(err)}`, 'err', 4000);
      }
    } finally {
      setSaving(false);
    }
  }
}

/* ============================================================
   Step 1 选择日期
   ============================================================ */

function Step1({
  date,
  note,
  dup,
  onDate,
  onNote,
  onNext
}: {
  date: string;
  note: string;
  dup: boolean;
  onDate: (v: string) => void;
  onNote: (v: string) => void;
  onNext: () => void;
}) {
  return (
    <div className="card">
      <div className="card-hd">
        <h3>选择盘点日期</h3>
        <span className="sub">默认今天，可补录历史</span>
      </div>
      <div className="grid3">
        <div className="field">
          <label>盘点日期</label>
          <input type="date" className="inp" value={date} onChange={e => onDate(e.target.value)} />
        </div>
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>快照备注（可选）</label>
          <input
            className="inp"
            value={note}
            placeholder="如：9 月末盘点"
            onChange={e => onNote(e.target.value)}
          />
        </div>
      </div>
      {dup ? (
        <Note tone="warn" style={{ marginTop: 14 }}>
          该日期<b>已存在快照</b>。允许同一天多张（补录或重盘），但趋势图与按日期对比只取<b>当日最后一张</b>。
        </Note>
      ) : null}
      <Note tone="info" style={{ marginTop: 14 }}>
        {`今天为 ${todayISO()}。补录历史快照时，请确保使用当时的汇率。`}
      </Note>
      <div className="hr" />
      <div className="btn-row">
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn pri" onClick={onNext}>
          下一步：确认汇率 →
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   Step 2 确认汇率
   ============================================================ */

function Step2({
  base,
  usedCurs,
  currencies,
  rates,
  onRate,
  refreshing,
  onRefresh,
  onPrev,
  onNext
}: {
  base: string;
  usedCurs: readonly string[];
  currencies: readonly CurrencyDTO[];
  rates: Record<string, number | null>;
  onRate: (code: string, v: number | null) => void;
  /** 「获取实时汇率」请求进行中（服务端有 8s 超时，期间禁用按钮防连点） */
  refreshing: boolean;
  onRefresh: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <div className="sticky-sum">
        <div className="it hl">
          <i>步骤</i>
          <b>2 / 4 汇率确认</b>
        </div>
        <div className="it">
          <i>本位币</i>
          <b>{base}</b>
        </div>
        <div className="it">
          <i>使用币种</i>
          <b>{usedCurs.length}</b>
        </div>
      </div>
      <div className="card">
        <div className="card-hd">
          <h3>确认各币种汇率</h3>
          <span className="sub">汇率仅作盘点默认值，保存后冻结在快照里</span>
          <span className="spacer" />
          <button className="btn" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? '获取中…' : '获取实时汇率'}
          </button>
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>币种</th>
                <th className="num">{`1 原币 = X ${base}`}</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {currencies
                .filter(c => usedCurs.indexOf(c.code) >= 0)
                .map(c => {
                  const fixed = c.code === base;
                  return (
                    <tr key={c.code}>
                      <td>
                        <b>{c.code}</b> <span className="muted tiny">{`${c.name} ${c.symbol}`}</span>
                        {fixed ? (
                          <>
                            {' '}
                            <span className="badge ok">本位币</span>
                          </>
                        ) : null}
                      </td>
                      <td className="num">
                        {fixed ? (
                          <span className="mono bold">1.0000</span>
                        ) : (
                          /* #8：这里原先也是「受控 + parseFloat」，于是 JPY 的 0.0486
                             删到「0.」就会被归一成 0，**汇率实际上改不动**。
                             换成持有文本的小数控件后，「0.」「0.04」这类中间态都可以打出来。 */
                          <DecimalInput
                            className="inp num"
                            style={{ width: 120 }}
                            value={rates[c.code] ?? null}
                            onValue={v => onRate(c.code, v)}
                          />
                        )}
                      </td>
                      <td className="mono tiny muted">
                        {fixed ? '固定为 1，不可编辑' : `1 ${c.code} = X ${base}`}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <Note tone="warn" style={{ marginTop: 14 }}>
          汇率为 0 或负数会被拦截；缺少汇率的币种在保存时提示必须填写。
        </Note>
        <div className="hr" />
        <div className="btn-row">
          <button className="btn" onClick={onPrev}>
            ← 上一步
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn pri" onClick={onNext}>
            下一步：录入金额 →
          </button>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Step 3 录入金额
   ============================================================ */

function Step3({
  inv,
  base,
  totals,
  visible,
  archivedCount,
  series,
  platformName,
  categoryName,
  onGroupBy,
  onToggleArchived,
  onAmount,
  onPrincipal,
  onFillAllCarry,
  onPrev,
  onNext
}: {
  inv: InvState;
  base: string;
  totals: ReturnType<typeof inventoryTotals>;
  visible: readonly Account[];
  archivedCount: number;
  series: readonly Snapshot[];
  platformName: (id: string | null) => string;
  categoryName: (id: string) => string;
  onGroupBy: (v: 'platform' | 'currency') => void;
  onToggleArchived: () => void;
  onAmount: (id: string, v: number | null) => void;
  onPrincipal: (id: string, v: number | null) => void;
  onFillAllCarry: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const rateOf = (code: string) => (code === base ? 1 : inv.rates[code] ?? 0);
  const groups: RowGroup[] = groupForRows(visible, inv.groupBy, platformName);

  return (
    <>
      <div className="sticky-sum">
        <div className="it hl">
          <i>净资产</i>
          <b>{money(microOf(totals.netWorth), 0)}</b>
        </div>
        <div className="it">
          <i>总资产</i>
          <b>{money(microOf(totals.totalAssets), 0)}</b>
        </div>
        <div className="it">
          <i>总负债</i>
          <b>{money(microOf(totals.totalLiabilities), 0)}</b>
        </div>
        <div className="it">
          <i>已填写 / 沿用</i>
          <b>{`${totals.filled} / ${totals.carry}`}</b>
        </div>
        <div className="it">
          <i>未填写</i>
          <b style={{ color: totals.unfilled ? '#FFB067' : 'inherit' }}>{totals.unfilled}</b>
        </div>
        <div className="it">
          <i>未填本金</i>
          <b style={{ color: totals.noPrincipal ? '#FFB067' : 'inherit' }}>{totals.noPrincipal}</b>
        </div>
        <span style={{ flex: 1 }} />
        <span className="tiny" style={{ opacity: 0.7 }}>
          {`本位币 ${base}`}
        </span>
      </div>
      <div className="card">
        <div className="card-hd">
          <h3>录入金额</h3>
          <span className="sub">自动带出最近一次快照金额，只改变动项</span>
          <span className="spacer" />
          <div className="seg sm">
            <button className={inv.groupBy === 'platform' ? 'on' : ''} onClick={() => onGroupBy('platform')}>
              按平台
            </button>
            <button className={inv.groupBy === 'currency' ? 'on' : ''} onClick={() => onGroupBy('currency')}>
              按币种
            </button>
          </div>
        </div>
        <Note tone="info">
          口径统一：一律填<b>当前实际价值</b>；负债填<b>正数</b>表示欠款；信用卡填<b>当前应还欠款总额</b>（不是额度）。
        </Note>
        {archivedCount ? (
          <div className="note" style={{ fontSize: 11.5 }}>
            {'有 '}
            <b>{archivedCount}</b>
            {' 个已归档账户默认不显示。'}
            <button className="btn xs" style={{ marginLeft: 8 }} onClick={onToggleArchived}>
              {inv.showArchived ? '收起归档账户' : '展开归档账户'}
            </button>
            {' 展开并填写后同样会写入本次快照。'}
          </div>
        ) : null}

        {!visible.length ? (
          <EmptyBox text="还没有账户。请先到「账户」页建立账户。" />
        ) : (
          groups.map(g => (
            <Collapse
              key={g.key}
              bodyStyle={{ overflowX: 'auto' }}
              header={
                <>
                  <span>{g.name}</span>
                  <span className="badge cur">{g.list.length}</span>
                </>
              }
            >
              <div style={{ minWidth: GRID_MIN_WIDTH }}>
                <div
                  className="arow"
                  style={{
                    gridTemplateColumns: GRID,
                    background: 'var(--paper-3)',
                    fontFamily: 'var(--mono)',
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: 0.5
                  }}
                >
                  <div>账户</div>
                  <div>分类</div>
                  <div>币种</div>
                  <div className="right">上次金额</div>
                  <div className="right">本次金额</div>
                  <div className="right">{`折 ${base}`}</div>
                  <div className="right">本金（累计净投入）</div>
                  <div className="right">收益预览</div>
                  <div className="center">状态</div>
                </div>
                {g.list.map(a => (
                  <InvRow
                    key={a.id}
                    account={a}
                    entry={inv.entries[a.id]}
                    base={base}
                    rate={rateOf(a.currency)}
                    categoryName={categoryName(a.category_id)}
                    prev={prevItemForInventory([...series], a.id, inv.date)}
                    onAmount={v => onAmount(a.id, v)}
                    onPrincipal={v => onPrincipal(a.id, v)}
                  />
                ))}
              </div>
            </Collapse>
          ))
        )}

        <div className="hr" />
        <div className="btn-row">
          <button className="btn" onClick={onPrev}>
            ← 上一步
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn" onClick={onFillAllCarry}>
            全部沿用上次
          </button>
          <button className="btn pri" onClick={onNext}>
            下一步：确认并保存 →
          </button>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Step 3 的行（原型 invRowHTML + invRefreshRow）
   ============================================================ */

function InvRow({
  account: a,
  entry: e,
  base,
  rate,
  categoryName,
  prev,
  onAmount,
  onPrincipal
}: {
  account: Account;
  entry: Entry | undefined;
  base: string;
  rate: number;
  categoryName: string;
  /** 按当次「盘点日期」现算的上期明细（原型的 invRefreshRow 就是这么取的） */
  prev: PrevRef | null;
  onAmount: (v: number | null) => void;
  onPrincipal: (v: number | null) => void;
}) {
  if (!e) return null;
  const isLiab = a.type === 'liability';
  const hasAmt = e.amount !== null && e.amount !== undefined;
  const amount = hasAmt ? (e.amount as number) : null;

  /* 两条校验：负债填负 / 缺汇率。命中时输入框加 .err，折本位币格换成徽章 */
  const liabNeg = amount !== null && isLiab && amount < 0;
  const noRate = amount !== null && !liabNeg && rate <= 0;
  const err = liabNeg || noRate;

  const inBase = amount !== null ? Money.fromNumber(amount).mulByRatio(rate) : null;

  let retNode: ReactNode = <span className="muted tiny">—</span>;
  if (a.track_principal) {
    /* 与原型同构：收益预览的临时明细只有这三个字段会被 returnsOf 读到 */
    const tmp = {
      tracks_principal: true,
      original_amount: Money.fromNumber(amount ?? 0),
      principal: e.principal === null ? null : Money.fromNumber(e.principal)
    } as unknown as SnapshotItem;
    const r = returnsOf(tmp, prev);
    /* 需求 #6：**不再显示「首期」**，直接给出本次金额 − 本金。
       `returnsOf` 的 cum 就是 `original_amount - principal`，而且**不依赖上期**
       （见 domain/returns.ts 第 95 行）——「首期」与「基准缺失」两种状态下 cum 都已经算好了，
       原先只是没拿出来显示。唯一真的算不出数字的是「未填本金」。 */
    if (r.status === 'no-principal') retNode = <span className="badge warn">未填本金</span>;
    else if (r.cum !== null) {
      retNode = (
        <>
          <div className="mono" style={{ fontSize: 12 }}>
            <Delta v={microOf(r.cum)} dec={0} cur={a.currency} />
          </div>
          <div className="tiny muted mono">
            {`累计 ${pctText(r.cumRate)}`}
            {r.per !== null ? ` · 本期 ${r.per.isPos() ? '+' : ''}${money(microOf(r.per), 0, a.currency)}` : ''}
          </div>
        </>
      );
    }
  }

  return (
    <div className="arow" id={'row-' + a.id} style={{ gridTemplateColumns: GRID }}>
      <div>
        <div className="nm">
          <RoleDot type={a.type} />
          {a.name}
          {a.track_principal ? <span className="badge princ">本金</span> : null}
          {!a.include_in_net_worth ? <span className="badge warn">不计净值</span> : null}
          {a.archived ? <span className="badge mute">归档</span> : null}
        </div>
      </div>

      {/* #9：分类与币种各自成列，账户名列只留名字与预警徽章 */}
      <div>
        <span className={'badge ' + (isLiab ? 'liab' : 'asset')}>{categoryName}</span>
      </div>
      <div>
        <CurBadge code={a.currency} />
      </div>

      <div className="right mono tiny muted">
        {e.prev ? (
          <>
            {money(microOf(e.prev.original_amount), 2, a.currency)}
            <br />
            <span style={{ fontSize: 9.5 }}>{e.prevDate}</span>
          </>
        ) : (
          '—'
        )}
      </div>

      <div>
        <DecimalInput
          className={'inp num' + (err ? ' err' : '')}
          placeholder={e.prev ? `沿用 ${e.prev.original_amount.toNumber()}` : '填写金额'}
          value={amount}
          onValue={onAmount}
        />
      </div>

      <div className="right mono bold">
        {liabNeg ? (
          <span className="badge warn" style={{ fontSize: 9.5 }}>
            负债须填正数
          </span>
        ) : noRate ? (
          <span className="badge warn" style={{ fontSize: 9.5 }}>
            缺汇率
          </span>
        ) : inBase === null ? (
          '—'
        ) : (
          /* #8：这一列原先恒为 0 位小数，用户刚在左边敲进去的分位在这里会被舍掉 ——
             「支持 2 位小数」就只剩存储支持。改用 moneyAuto：**整数金额的输出逐字符不变**，
             只有真带分位时才多出两位。合计栏（净资产 / 总资产 / 总负债）仍保持 0 位，
             那是汇总口径，与明细列不是一回事。 */
          moneyAuto(microOf(inBase))
        )}
      </div>

      {a.track_principal ? (
        <div>
          <DecimalInput
            className="inp num"
            placeholder="本金"
            value={e.principal === null || e.principal === undefined ? null : e.principal}
            onValue={onPrincipal}
          />
        </div>
      ) : (
        <div className="right muted tiny">不适用</div>
      )}

      <div className="right">{retNode}</div>

      <div className="center">
        {e.state === 'filled' ? (
          <span className="badge ok">已填写</span>
        ) : e.state === 'carry' ? (
          <span className="badge carry">沿用上次</span>
        ) : (
          <span className="badge mute">未填写</span>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Step 3.5 确认页（原型 invStep3b）
   ============================================================ */

function StepConfirm({
  inv,
  base,
  dup,
  totals,
  preview,
  accounts,
  platformName,
  onBack,
  onToggleConfirmed,
  onSave
}: {
  inv: InvState;
  base: string;
  dup: boolean;
  totals: ReturnType<typeof inventoryTotals>;
  /** 服务端的权威试算；离线源下恒为 null，此时全部退回本地计数 */
  preview: InventoryPreviewDTO | null;
  accounts: readonly Account[];
  platformName: (id: string | null) => string;
  onBack: () => void;
  onToggleConfirmed: (v: boolean) => void;
  onSave: () => void;
}) {
  /* 本地清单：既是离线源下的答案，也是服务端回答之前的首帧 */
  const unfilledLocal: Account[] = [];
  const noPrinLocal: Account[] = [];
  for (const id of Object.keys(inv.entries)) {
    const e = inv.entries[id];
    const a = accounts.find(x => x.id === id);
    if (!a) continue;
    if (e.state === 'unfilled' || e.amount === null || e.amount === undefined) unfilledLocal.push(a);
    else if (a.track_principal && (e.principal === null || e.principal === undefined)) noPrinLocal.push(a);
  }

  /* 服务端权威值。两边调的是同一份 `@app/domain`，正常情况逐位相同；
     以服务端为准是为了让「客户端漏送了某个账户」这类偏差在**保存前**就显形，
     而不是变成一张少了几行的快照。 */
  const c = preview?.counts ?? null;
  const written = c ? c.written : totals.filled + totals.carry;
  const filled = c ? c.filled : totals.filled;
  const carry = c ? c.carry : totals.carry;
  const excluded = c ? c.excluded_from_net_worth : accounts.filter(a => !a.include_in_net_worth).length;
  /* 两条清单都渲染成 `{id, text}`：离线源与在线源给的原料不同（账户对象 / 服务端引用），
     但拼出来的**文案逐字符一致**，外观不会因为换源而漂。 */
  const unfilledChips = preview
    ? preview.unfilled.map(x => ({ id: x.account_id, text: `${x.account_name} · ${x.platform_name}` }))
    : unfilledLocal.map(a => ({ id: a.id, text: `${a.name} · ${platformName(a.platform_id)}` }));
  const noPrinChips = preview
    ? preview.no_principal.map(x => ({ id: x.account_id, text: x.account_name }))
    : noPrinLocal.map(a => ({ id: a.id, text: a.name }));

  return (
    <>
      <div className="sticky-sum">
        <div className="it hl">
          <i>将保存的净资产</i>
          <b>{money(preview ? preview.totals.net_worth : microOf(totals.netWorth), 0)}</b>
        </div>
        <div className="it">
          <i>明细条目</i>
          <b>{written}</b>
        </div>
        <div className="it">
          <i>已填写</i>
          <b>{filled}</b>
        </div>
        <div className="it">
          <i>沿用上次</i>
          <b>{carry}</b>
        </div>
      </div>
      {dup ? (
        <Note tone="warn">
          {`该日期（${inv.date}）已有快照，保存后将新增一张，趋势图取当日最后一张。`}
        </Note>
      ) : null}
      <div className="card">
        <div className="card-hd">
          <h3>确认快照内容</h3>
          <span className="sub">保存后只读，修改需删除重做</span>
        </div>
        <div className="grid3">
          <div className="kv">
            <span className="kk">日期</span>
            <span className="vv">{inv.date}</span>
            <span className="kk">备注</span>
            <span className="vv">{inv.note || '—'}</span>
            <span className="kk">本位币</span>
            <span className="vv">{base}</span>
          </div>
          <div className="kv">
            <span className="kk">总资产</span>
            <span className="vv">
              {money(preview ? preview.totals.total_assets : microOf(totals.totalAssets), 0)}
            </span>
            <span className="kk">总负债</span>
            <span className="vv">
              {money(preview ? preview.totals.total_liabilities : microOf(totals.totalLiabilities), 0)}
            </span>
            <span className="kk">净资产</span>
            <span className="vv">
              {money(preview ? preview.totals.net_worth : microOf(totals.netWorth), 0)}
            </span>
          </div>
          <div className="kv">
            <span className="kk">写入明细</span>
            <span className="vv">{`${written} 条`}</span>
            <span className="kk">沿用上次</span>
            <span className="vv">{`${carry} 条`}</span>
            <span className="kk">不计净值</span>
            <span className="vv">{`${excluded} 个`}</span>
          </div>
        </div>
      </div>

      {unfilledChips.length ? (
        <div className="card" style={{ background: '#FFF4E6' }}>
          <div className="card-hd">
            <h3>{`⚠ ${unfilledChips.length} 个账户本次「未填写」`}</h3>
            <span className="sub">不会写入本次快照</span>
          </div>
          <div className="chips">
            {unfilledChips.map(x => (
              <span className="badge mute" key={x.id}>
                {x.text}
              </span>
            ))}
          </div>
          <div className="note" style={{ margin: '12px 0 0', fontSize: 11.5 }}>
            这些账户在本次快照中没有记录，后续「按账户对比」时会标记为<b>本期缺失</b>；账户列表的「最近快照金额」仍显示它们更早的数值。
          </div>
        </div>
      ) : null}

      {noPrinChips.length ? (
        <div className="card" style={{ background: '#FFF4E6' }}>
          <div className="card-hd">
            <h3>{`⚠ ${noPrinChips.length} 个账户未填本金`}</h3>
            <span className="sub">市值照常计入净资产，该期不计算收益指标</span>
          </div>
          <div className="chips">
            {noPrinChips.map(x => (
              <span className="badge warn" key={x.id}>
                {x.text}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card">
        <label className="chk" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={inv.confirmed} onChange={e => onToggleConfirmed(e.target.checked)} />
          我已确认以上内容，保存快照
        </label>
        <div className="hr" />
        <div className="btn-row">
          <button className="btn" onClick={onBack}>
            ← 返回修改
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn ink" onClick={onSave}>
            保存快照
          </button>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Step 4 完成页（原型 invStep4）
   ============================================================ */

function StepDone({
  inv,
  snapshotList,
  onNavigate,
  onOpenSnapshot,
  onCompare
}: {
  inv: InvState;
  snapshotList: readonly SnapshotSummaryDTO[];
  onNavigate: (view: View) => void;
  onOpenSnapshot: (snapshotId: string) => void;
  onCompare: (snapshotId: string) => void;
}) {
  const snap = snapshotList.find(s => s.id === inv.lastSaved) ?? null;
  const panel = useApi<ReturnsPanelDTO>(inv.lastSaved ? ep.returns(inv.lastSaved) : null);

  if (!snap) {
    return (
      <div className="card">
        <EmptyBox text="快照已保存。" />
      </div>
    );
  }

  /* 上一期基准：原型取「比本期更早的最新一张」 */
  const earlier = [...snapshotList]
    .filter(s => s.date < snap.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const d = earlier ? snap.net_worth - earlier.net_worth : null;
  const rp = panel.data;
  const ds = dailySeries(snapshotList).slice(-8);

  return (
    <>
      <div className="card" style={{ background: 'var(--green)' }}>
        <div className="card-hd">
          <h3 style={{ fontSize: 19 }}>✓ 快照已保存</h3>
          <span className="sub">{`${snap.date} · ${snap.note || '无备注'}`}</span>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 42, fontWeight: 800, letterSpacing: -2, lineHeight: 1.1 }}>
          {money(snap.net_worth)}
        </div>
        <div style={{ marginTop: 6, fontWeight: 700 }}>
          {d !== null ? (
            <>
              {'较上一期 '}
              <Delta v={d} dec={0} />
            </>
          ) : (
            '这是第一期快照'
          )}
        </div>
      </div>
      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="stat blue">
          <span className="k">总资产</span>
          <span className="v" style={{ fontSize: 20 }}>
            {money(snap.total_assets, 0)}
          </span>
        </div>
        <div className="stat pink">
          <span className="k">总负债</span>
          <span className="v" style={{ fontSize: 20 }}>
            {money(snap.total_liabilities, 0)}
          </span>
        </div>
        <div className="stat">
          <span className="k">写入明细</span>
          <span className="v" style={{ fontSize: 20 }}>
            {snap.item_count}
          </span>
          <span className="d tiny muted">{`${snap.carried_over} 条沿用上次`}</span>
        </div>
        <div className="stat purple">
          <span className="k">累计收益</span>
          <span className="v" style={{ fontSize: 20 }}>
            {rp ? money(rp.cum, 0) : '—'}
          </span>
          <span className="d">{rp ? <Pct v={rp.cum_rate} /> : '—'}</span>
        </div>
      </div>
      <div className="card">
        <div className="card-hd">
          <h3>净资产趋势</h3>
        </div>
        <ChartBox className="chartbox" dataChart="inv-done-chart">
          {w =>
            ds.length >= 2 ? (
              <LineChart
                w={w}
                height={200}
                series={[{ data: ds.map(s => ({ x: s.date, y: toYuan(s.net_worth) })), color: '#FFE500', area: true, inner: true }]}
              />
            ) : null
          }
        </ChartBox>
      </div>
      <Note tone="warn">建议每次盘点后导出一次全量备份，避免本地数据丢失。</Note>
      <div className="btn-row">
        <button className="btn pri" onClick={() => onNavigate('home')}>
          返回首页
        </button>
        <button className="btn" onClick={() => onOpenSnapshot(snap.id)}>
          查看快照详情
        </button>
        <button className="btn" onClick={() => onCompare(snap.id)}>
          与上期对比
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn ink" onClick={() => onNavigate('settings')}>
          导出全量备份
        </button>
      </div>
    </>
  );
}

/* ============================================================
   纯函数
   ============================================================ */

function freshState(
  series: readonly Snapshot[],
  accounts: readonly Account[],
  rateMicros: Record<string, number>,
  base: string
): InvState {
  const date = todayISO();
  const entries: Record<string, Entry> = {};
  for (const a of accounts) {
    if (a.archived) continue;
    const prev = prevItemForInventory([...series], a.id, date);
    entries[a.id] = {
      amount: prev ? yuanOf(prev.item.original_amount) : null,
      principal: a.track_principal && prev ? yuanOf(prev.item.principal) : null,
      state: prev ? 'carry' : 'unfilled',
      prev: prev ? prev.item : null,
      prevDate: prev ? prev.snapshot.date : null,
      touched: false
    };
  }
  /* 汇率表整体来自 /rates（本位币为 1）；不在表里的币种按 0 处理，由门禁拦下 */
  const rates: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(rateMicros)) rates[k] = v / 1e6;
  rates[base] = 1;
  return {
    date,
    note: '',
    rates,
    entries,
    groupBy: 'platform',
    showArchived: false,
    confirmed: false,
    lastSaved: null
  };
}

/**
 * 用服务端草稿覆盖 `freshState()` 的初始值 —— 「草稿由服务端持有」的落点。
 *
 * 四个刻意的选择：
 *   · **只覆盖两边都有的账户**。草稿里那些当前向导不认的账户（已被删除，或是在草稿
 *     之后才归档的）直接丢弃：恢复一个已经不在盘点范围内的账户没有意义，
 *     反而会让确认页凭空多出几行。
 *   · **`prev` / `prevDate` 仍从本地快照序列现算**，不从草稿取。
 *     `/inventory/session` 只给 `lastAmounts`（微元），既不给本金、也不说「上一次是哪一期」，
 *     所以「上次金额」列与收益预览的原料只能来自本地 —— 口径与服务端 `normalizeEntries`
 *     一致；万一不一致，保存时以服务端为准（见 app/server/src/modules/inventory.ts）。
 *   · 草稿里的 `date` 优先于「今天」：用户上次盘到一半的日期就是他当时的意图。
 *   · 草稿里的 `rates` 只**覆盖**、不替换整表 —— 表里那些草稿没提到的币种
 *     （例如期间新启用的）保持 `/rates` 的当前值。本位币强制回 1：
 *     让浮点去决定「1 是不是 1」没有意义。
 */
function mergeDraft(fresh: InvState, draft: InventoryDraftDTO, base: string): InvState {
  const restored = fromEntriesDTO(draft.entries);
  const entries: Record<string, Entry> = {};
  for (const [id, e] of Object.entries(fresh.entries)) {
    const r = restored[id];
    if (!r) {
      entries[id] = e;
      continue;
    }
    /* `touched` 不在 API 边界上（DTO 没有这个字段），服务端按 `state === 'filled'` 还原，
       这里必须用同一个规则，否则「已填写」的行会被判成没动过 */
    entries[id] = { ...e, amount: r.amount, principal: r.principal, state: r.state, touched: r.state === 'filled' };
  }

  const rates = { ...fresh.rates };
  for (const [code, micro] of Object.entries(draft.rates ?? {})) {
    const yuan = yuanFromMicro(micro);
    if (yuan !== null) rates[code] = yuan;
  }
  rates[base] = 1;

  return { ...fresh, date: draft.date ?? fresh.date, note: draft.note, entries, rates };
}

/** Step 2 的「使用币种」：仅未归档账户，保持首次出现顺序（原型用 Set 的插入序） */
function usedCurrencies(accounts: readonly Account[]): string[] {
  return Array.from(new Set(accounts.filter(a => !a.archived).map(a => a.currency)));
}
function groupForRows(
  list: readonly Account[],
  groupBy: 'platform' | 'currency',
  platformName: (id: string | null) => string
): RowGroup[] {
  const map = new Map<string, RowGroup>();
  const order: string[] = [];
  for (const a of list) {
    const k = groupBy === 'platform' ? a.platform_id || 'none' : a.currency;
    let g = map.get(k);
    if (!g) {
      g = { key: k, name: groupBy === 'platform' ? platformName(k === 'none' ? null : k) : k, list: [] };
      map.set(k, g);
      order.push(k);
    }
    g.list.push(a);
  }
  return order.map(k => map.get(k) as RowGroup);
}
