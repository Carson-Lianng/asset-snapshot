/**
 * API 契约 —— 响应与请求的 DTO 定义
 *
 * ── 金额的传输形态（重要，全系统统一）──
 * 所有金额字段都是 **微元整数（×10^6）**，类型别名 `Micro`。
 * 理由：
 *   1. 无损。微元整数 ≤ 9.007e15 仍在 IEEE 754 安全整数域内，JSON 往返零误差；
 *      而「元」浮点在 6 位小数上会在网络边界引入二次舍入。
 *   2. 与 `Money.toJSON()` / `Money.fromMicro()` 精确对应，两侧各只有一处转换。
 *   3. 汇率字段沿用同一标度（7.28 → 7280000），全库只有一种金额形态。
 * 前端在 `app/web/src/api/client.ts` 的边界处统一 `Money.fromMicro()` 还原。
 *
 * 契约与 zod schema 同源：请求侧校验在 `schemas.ts`，响应侧类型在这里。
 */

/** 微元整数（×10^6）。1 元 = 1_000_000 */
export type Micro = number;

export type AccountType = 'asset' | 'liability';
export type Dim = 'account' | 'platform' | 'category' | 'currency' | 'tag';
export type ViewMode = 'origin' | 'current';

export type ReturnStatus =
  | 'ok'
  | 'not-tracked'
  | 'no-principal'
  | 'first'
  | 'base-missing';

/* ============================================================
   错误
   ============================================================ */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'RULE_VIOLATION'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    request_id: string;
  };
}

/* ============================================================
   系统
   ============================================================ */

export interface HealthDTO {
  status: 'ok';
  version: string;
  uptime_s: number;
}

export interface ReadyDTO {
  status: 'ready';
  schema_version: number;
  data_dir: string;
  counts: {
    currencies: number;
    platforms: number;
    categories: number;
    tags: number;
    accounts: number;
    snapshots: number;
  };
}

/* ============================================================
   基础资料
   ============================================================ */

export interface CurrencyDTO {
  code: string;
  name: string;
  symbol: string;
  sort: number;
  enabled: boolean;
  /** 当前默认汇率表（1 单位该币种 = rate_to_base 本位币）；本位币自身为 1 */
  rate_to_base: Micro;
  rate_updated_at: string | null;
}

export interface PlatformDTO {
  id: string;
  name: string;
  type: string;
  note: string;
  sort: number;
  enabled: boolean;
  /** 引用该平台的账户数（未归档 + 已归档） */
  account_count: number;
}

export interface CategoryDTO {
  id: string;
  name: string;
  type: AccountType;
  default_track_principal: boolean;
  sort: number;
  enabled: boolean;
  account_count: number;
}

export interface TagDTO {
  id: string;
  name: string;
  sort: number;
  enabled: boolean;
  account_count: number;
}

/* ============================================================
   设置
   ============================================================ */

/**
 * 数据模式：库里放的是**演示数据**还是**用户自己的账本**。
 *
 * 界面的分野：`demo` 时显示提示条并给出「开始正式记账」入口；`live` 时什么都不显示。
 * 缺这个值时按 `'live'` 处理 —— 详由见服务端 `db/seed.ts` 的 `getDataMode`
 * （误标为 `demo` 会给真实账本配一把误触的钥匙，漏报只是少一条提示）。
 */
export type DataMode = 'demo' | 'live';

export interface SettingsDTO {
  base_currency: string;
  schema_version: number;
  app_version: string;
  data_mode: DataMode;
}

export interface BaseCurrencyChangeDTO {
  id: string;
  from_currency: string;
  to_currency: string;
  conversion_rate: number;
  changed_at: string;
}

/* ============================================================
   汇率刷新（第三批 #1 / #2）
   ============================================================ */

/**
 * 可用的公开汇率源 —— **白名单，且只有这三个取值**。
 *
 * `off` 不会出现在成功的响应里（它表示「没启用」，请求会先被 422 挡下），
 * 所以成功响应里的 `source` 只会是前两个。
 *
 * 之所以把取值收敛成联合类型而不是 `string`：服务端的 `ENDPOINTS` 表按它取源，
 * 界面也按它显示源名。任何「由请求参数决定去哪个地址取数」的通道都是 SSRF 入口，
 * 这条类型边界就是那个决定在契约层的形状。
 */
export type FxSourceName = 'frankfurter' | 'er-api';

/** 一次刷新里**确实被改动**的一个币种 */
export interface RatesRefreshRowDTO {
  code: string;
  name: string;
  /** 刷新前的默认汇率（微元） */
  before: Micro;
  /** 刷新后的默认汇率（微元） */
  after: Micro;
  /**
   * 源给的原始比值（`1 本位币 = source_rate 该币种`）。
   *
   * 与 `after` 方向相反、且是浮点，**不能拿来算钱**；它的唯一用途是让界面能
   * 展示「这个数是 1/7.2780 得来的」，用户据此判断要不要手动修正。
   */
  source_rate: number;
}

/**
 * `POST /rates/refresh` 的返回 —— 从公开源**手动**刷新默认汇率表。
 *
 * 只写默认汇率表（`PUT /rates` 那条路径），**绝不回写任何历史快照**：
 * 快照的冻结汇率是不可变的（口径约定 3）。
 */
export interface RatesRefreshDTO {
  base_currency: string;
  source: FxSourceName;
  /** 界面上要显示的源名（含出处），例如「Frankfurter（欧洲央行参考汇率）」 */
  source_label: string;
  fetched_at: string;
  /** 真正被改动的币种数 —— 值没变的不计（不会为了「刷新」白改一遍时间戳） */
  updated: number;
  /** 源里没有、或值不是有限正数的币种：**保留原汇率**，绝不清零 */
  skipped: string[];
  rows: RatesRefreshRowDTO[];
  /** 刷新后的完整默认汇率表（微元），与 `PUT /rates` 的返回同构 */
  rates: Record<string, Micro>;
}

/* ============================================================
   账户
   ============================================================ */

export interface AccountDTO {
  id: string;
  name: string;
  platform_id: string | null;
  category_id: string;
  type: AccountType;
  currency: string;
  tags: string[];
  note: string;
  include_in_net_worth: boolean;
  track_principal: boolean;
  sort: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

/* ============================================================
   快照
   ============================================================ */

export interface SnapshotSummaryDTO {
  id: string;
  date: string;
  note: string;
  base_currency: string;
  total_assets: Micro;
  total_liabilities: Micro;
  net_worth: Micro;
  created_at: string;
  item_count: number;
  carried_over: number;
  /** 本期写入且已开启本金跟踪的明细数 */
  tracked: number;
  /** 已开启跟踪但未填本金的明细数 */
  no_principal: number;
}

export interface SnapshotItemDTO {
  id: string;
  snapshot_id: string;
  account_id: string;
  account_name_snapshot: string;
  platform_id_snapshot: string | null;
  platform_name_snapshot: string;
  category_id_snapshot: string;
  category_name_snapshot: string;
  type: AccountType;
  currency: string;
  original_amount: Micro;
  exchange_rate: Micro;
  amount_in_base: Micro;
  include_in_net_worth: boolean;
  tracks_principal: boolean;
  principal: Micro | null;
  principal_in_base: Micro | null;
  is_carried_over: boolean;
  tags_snapshot: Array<{ id: string; name: string }>;
  sort: number;
}

export interface SnapshotDTO extends SnapshotSummaryDTO {
  rates: Record<string, Micro>;
  items: SnapshotItemDTO[];
}

/* ============================================================
   报表
   ============================================================ */

export interface TrendPointDTO {
  snapshot_id: string;
  date: string;
  created_at: string;
  base_currency: string;
  total_assets: Micro | null;
  total_liabilities: Micro | null;
  net_worth: Micro | null;
  /** true 表示经折算，界面须标注「参考值」 */
  ref: boolean;
}

export interface TrendDTO {
  metric: 'net_worth' | 'total_assets' | 'total_liabilities';
  mode: ViewMode;
  base_currency: string;
  points: TrendPointDTO[];
  /** 本位币变更分隔点：该索引之前的点属于旧本位币时代（折算链已生效） */
  base_changes: BaseCurrencyChangeDTO[];
}

export interface BreakdownRowDTO {
  key: string;
  name: string;
  asset: Micro;
  liability: Micro;
  net: Micro;
  count: number;
}

export interface BreakdownDTO {
  snapshot_id: string;
  dim: Dim;
  mode: ViewMode;
  base_currency: string;
  ref: boolean;
  rows: BreakdownRowDTO[];
}

export interface PlatformCurrencyRowDTO {
  key: string;
  name: string;
  asset: Micro;
  liability: Micro;
  total: Micro;
  accounts: number;
  currencies: number;
  by_currency: Array<{
    code: string;
    name: string;
    symbol: string;
    orig: Micro;
    base: Micro;
    asset: Micro;
    liability: Micro;
    n: number;
  }>;
}

export interface CurrencyRowDTO {
  code: string;
  name: string;
  symbol: string;
  orig: Micro;
  base: Micro;
  n: number;
}

export interface ReturnsPanelDTO {
  snapshot_id: string;
  count: number;
  principal: Micro;
  market: Micro;
  cum: Micro;
  cum_rate: number | null;
  per: Micro;
  per_rate: number | null;
  no_principal: number;
  first: number;
  missing_base: number;
  has_per: boolean;
}

export interface ReturnsBreakdownRowDTO {
  key: string;
  name: string;
  n: number;
  principal: Micro;
  market: Micro;
  cum: Micro;
  cum_rate: number | null;
  per: Micro | null;
  /** `per === null` 时区分「首期」与「基准缺失」——两者本期收益都不可用，但标记不同（PRD §10） */
  per_status: 'ok' | 'first' | 'base-missing';
}

export interface ReturnsBreakdownDTO {
  snapshot_id: string;
  dim: Exclude<Dim, 'tag'>;
  rows: ReturnsBreakdownRowDTO[];
}

export interface ReturnsTrendPointDTO {
  snapshot_id: string;
  date: string;
  /** 纳入**累计**口径的账户数（含「首期」「基准缺失」的账户）；为 0 时界面显示「—」而不是 ¥0 */
  count: number;
  principal: Micro;
  market: Micro;
  cum: Micro;
  per: Micro;
  per_available: boolean;
}

export interface ReturnsTrendDTO {
  points: ReturnsTrendPointDTO[];
}

export interface ItemReturnDTO {
  item_id: string;
  account_id: string;
  account_name_snapshot: string;
  /** 该账户是否开启了本金跟踪（未开启时不展示任何收益信息） */
  tracks_principal: boolean;
  /** 本期市值（原币） */
  original_amount: Micro;
  /** 本期本金（原币），null 表示未填 */
  principal: Micro | null;
  status: ReturnStatus;
  cum: Micro | null;
  cum_rate: number | null;
  per: Micro | null;
  per_rate: number | null;
  net_invest: Micro | null;
  prev_amount: Micro | null;
  prev_principal: Micro | null;
}

export interface CompareRowDTO {
  key: string;
  name: string;
  a: Micro | null;
  b: Micro | null;
  a_asset: Micro | null;
  a_liability: Micro | null;
  b_asset: Micro | null;
  b_liability: Micro | null;
  diff: Micro;
  rate: number | null;
  is_new: boolean;
  is_gone: boolean;
}

export interface CompareDTO {
  dim: Dim;
  mode: ViewMode;
  cross_currency: boolean;
  early: SnapshotSummaryDTO;
  late: SnapshotSummaryDTO;
  totals_early: { total_assets: Micro | null; total_liabilities: Micro | null; net_worth: Micro | null; ref: boolean };
  totals_late: { total_assets: Micro | null; total_liabilities: Micro | null; net_worth: Micro | null; ref: boolean };
  delta_total_assets: Micro | null;
  delta_total_liabilities: Micro | null;
  delta_net_worth: Micro | null;
  rate_net_worth: number | null;
  rows: CompareRowDTO[];
  returns: {
    a_principal: Micro;
    b_principal: Micro;
    a_cum: Micro;
    b_cum: Micro;
    a_rate: number | null;
    b_rate: number | null;
  };
}

/* ============================================================
   盘点（Step 4 写路径）
   ============================================================ */

/** 三态：本次填写 / 沿用上次 / 未填写（PRD §3.3.1、规则 15） */
export type EntryState = 'filled' | 'carry' | 'unfilled';

export interface InventoryEntryDTO {
  amount: Micro | null;
  principal: Micro | null;
  state: EntryState;
}

/**
 * 盘点草稿 —— 由**服务端持有**（Step 4 起取代原型的 localStorage）。
 * `version` 做乐观锁，防多标签页互相覆盖（ADR-10）。
 */
export interface InventoryDraftDTO {
  version: number;
  date: string | null;
  note: string;
  /** 键为账户 ID */
  entries: Record<string, InventoryEntryDTO>;
  /**
   * Step 2 里**用户改过**的汇率表（微元）。
   *
   * 原型 `invRestore` 会把草稿里的汇率合回向导（`Object.assign({}, inv.rates, draft.rates)`）——
   * 不带这一项就会出现「第 2 步白改一场」：退出再进来，改过的汇率被全局汇率表覆盖回去。
   * 缺省表示「没改过」或「旧草稿」，此时用 `/rates` 的当前值。
   */
  rates?: Record<string, Micro>;
}

/** GET /inventory/draft */
export interface InventoryDraftResponseDTO {
  /** 从未盘过时为 null */
  draft: InventoryDraftDTO | null;
  base_currency: string;
  /** 当前默认汇率表，微元 */
  rates: Record<string, Micro>;
}

/** POST /inventory/session —— 一次性返回，减少往返（§8.3） */
export interface InventorySessionDTO {
  draft: InventoryDraftDTO | null;
  accounts: AccountDTO[];
  /** 每个账户上一次录入的金额（原币，微元），「沿用上次」的原料 */
  lastAmounts: Record<string, Micro>;
  rates: Record<string, Micro>;
  base_currency: string;
  /** 服务端认为的「今天」，避免前后端时区不一致 */
  today: string;
}

/** POST /inventory/preview —— 服务端权威试算 */
export interface InventoryPreviewDTO {
  date: string;
  base_currency: string;
  totals: { total_assets: Micro; total_liabilities: Micro; net_worth: Micro };
  counts: {
    /** 本次会写入快照的明细数（已填写 + 沿用上次） */
    written: number;
    filled: number;
    carry: number;
    unfilled: number;
    no_principal: number;
    /** 不参与净资产计算的账户数（确认页会单独列出） */
    excluded_from_net_worth: number;
  };
  /** 未填写 → 不写入本次快照，保存前须确认 */
  unfilled: InventoryAccountRef[];
  /** 已开启跟踪但本期未填本金 → 仍写入，只是该期不产出收益指标 */
  no_principal: InventoryAccountRef[];
  /** 保存前的门禁问题；非空则不允许保存（422） */
  issues: Array<{ account_id: string; account_name: string; code: string; message: string }>;
  /** 该日期已有快照：保存后趋势图取当日最后一张（PRD 规则 16） */
  duplicate_date: boolean;
}

export interface InventoryAccountRef {
  account_id: string;
  account_name: string;
  platform_name: string;
}

/** POST /inventory/snapshots 的返回 */
export interface InventorySaveDTO {
  snapshot: SnapshotSummaryDTO;
  written: number;
  carried_over: number;
  unfilled: number;
  no_principal: number;
}

/* ============================================================
   数据管理：导出 / 导入 / 备份 / 恢复（Step 5）
   ============================================================ */

/**
 * 备份文件（`$DATA_DIR/backups/backup-YYYY-MM-DD.sqlite`，§6.6）。
 * 路径不下发给前端 —— 界面只需要展示与触发，不需要知道磁盘布局。
 */
export interface BackupEntryDTO {
  name: string;
  size: number;
  created_at: string;
  /** 是否今天生成的（界面据此显示「今日已备份」） */
  is_today: boolean;
}

export interface BackupListDTO {
  items: BackupEntryDTO[];
  /** 保留份数（§6.6，默认 30）；界面用它解释「旧的会自动清理」 */
  keep: number;
}

/** POST /backup 的返回 */
export interface BackupResultDTO extends BackupEntryDTO {
  /** 清理掉的旧备份数 */
  pruned: number;
}

/**
 * CSV 导入的单行判定。
 *
 * 四态，**「错误」与「跳过」必须分开**：
 *   - `insert` / `update` —— 会落库（PRD §3.1.7 的「新增 N 条 / 更新 M 条」）
 *   - `conflict`        —— 用户必须修正的问题（平台/分类/币种不存在、类型无效、
 *                          必填为空）。存在 conflict 时 apply 整体拒绝。
 *   - `skip`            —— 按规则**不该导入**但不阻碍其余行：整行空（Excel 尾随空行），
 *                          或同一份 CSV 内的重复行（PRD：按「账户名 + 平台」匹配，
 *                          后者覆盖前者）。把它算成 conflict 会让一次正常的导入
 *                          因为「文件里有两行同名」而被拒。
 */
export interface ImportRowDTO {
  /** CSV 中的行号（含表头，便于用户定位） */
  line: number;
  account_name: string;
  platform_name: string;
  currency: string;
  action: 'insert' | 'update' | 'conflict' | 'skip';
  /** 原币金额（元）。**只用于展示**：导入不写快照，余额请走盘点向导 */
  amount: number | null;
  reason?: string;
  /** 命中的既有账户（update 时给出） */
  matched_account_id?: string;
}

/** POST /import/preview —— 只算不写（PRD §3.1.7） */
export interface ImportPreviewDTO {
  inserted: number;
  updated: number;
  conflicts: number;
  /** 按规则跳过的行数（空行 + 被后者覆盖的重复行） */
  skipped: number;
  rows: ImportRowDTO[];
  /** `rows` 是否被截断（超出上限时只回传前 N 行，计数仍为全量） */
  truncated: boolean;
}

/** POST /import/apply —— 整体事务，任一行失败全部回滚 */
export interface ImportApplyDTO {
  inserted: number;
  updated: number;
  skipped: number;
}

/** POST /restore 的返回 */
export interface RestoreResultDTO {
  schema_version: number;
  app_version: string;
  restored: {
    currencies: number;
    rates: number;
    base_history: number;
    platforms: number;
    categories: number;
    tags: number;
    accounts: number;
    snapshots: number;
    snapshot_items: number;
  };
  /**
   * 恢复**之前**自动留下的备份文件名（null 表示备份失败，恢复仍已执行）。
   *
   * 恢复是唯一的破坏性操作：一旦点错，用户的原数据就被覆盖了。
   * 恢复前先自动备份一份，是把「不可逆」变成「可退回」 —— 界面必须把这个文件名显示出来。
   */
  pre_restore_backup: string | null;
}

/**
 * `POST /go-live` 的返回：从演示数据切到自己的账本。
 *
 * 语义是「清掉演示的账户与快照，保留字典（币种 / 汇率 / 平台 / 分类 / 标签）」，
 * 与命令行的 `npm run reset` 是同一件事，只是入口在界面上。
 */
export interface GoLiveResultDTO {
  data_mode: DataMode;
  /** 刚刚清掉的东西 —— 让界面能如实说明「清掉了什么」，而不是只说「已完成」 */
  cleared: {
    accounts: number;
    snapshots: number;
    snapshot_items: number;
  };
}
