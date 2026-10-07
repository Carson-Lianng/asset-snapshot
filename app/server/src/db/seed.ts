/**
 * 种子导入 —— 把 Step 0 冻结的演示数据（`app/fixtures/demo-seed.json`）落库
 *
 * 关键约束（技术设计文档 §5.5 / §6.2）：
 *   - 金额 / 汇率一律经 `Money` 转成微元整数后写入 INTEGER 列，
 *     这是唯一允许触碰定点整数的地方；
 *   - 快照的三个汇总列直接采用种子里的「冻结口径」，**不重算** ——
 *     重算会随汇率表变化而漂移，违反 PRD 规则 3 / 4；
 *   - 整批导入包在单个事务里，任一步失败整体回滚。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { Money } from '@app/domain';
import { fail } from '../lib/errors.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** app/server/src/db → 仓库根 */
export const REPO_ROOT = resolve(HERE, '../../../..');
export const DEFAULT_FIXTURE = resolve(REPO_ROOT, 'app/fixtures/demo-seed.json');

const micro = (v: number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(Money.fromNumber(v).toMicro());

export interface SeedStats {
  source: string;
  schema_version: number;
  app_version: string;
  currencies: number;
  rates: number;
  base_history: number;
  platforms: number;
  categories: number;
  tags: number;
  accounts: number;
  account_tags: number;
  snapshots: number;
  snapshot_items: number;
  snapshot_rates: number;
}

/**
 * 数据模式：当前库里放的是**演示数据**还是**用户自己的账本**。
 *
 * 存在的理由：「保留演示数据供首次体验」与「别让演示数据混进真实账本」这两件事，
 * 单靠一个清空命令是分不开的 —— 界面必须能分辨「现在这 22 个账户是示例，还是你的」，
 * 才能决定要不要提示、以及要不要提供「开始正式记账」这个入口。
 *
 * 落点是 `setting` 表的 `data_mode` 键（见 `getDataMode`），是一个**显式记录的事实**，
 * 不是从业务数据反推的猜测 —— 与 `initialized_at` 同一条原则（见 `isSeeded` 的说明）。
 */
export type DataMode = 'demo' | 'live';

/**
 * 种子 / 备份文档的结构 —— 两者**同构**。
 *
 * 刻意不做两份结构：`app/fixtures/demo-seed.json` 是种子文档，而「导出全量备份」
 * 产出的是同一形状的文档。于是「种子化」与「从备份恢复」走的是同一段灌入代码
 * （见 `loadDocument`），不存在「恢复多支持一个字段」这类漂移。
 * `exported_at` 是备份专有字段（种子文件不需要），灌入时被忽略。
 */
export interface SeedFixture {
  schema_version: number;
  app_version: string;
  /** 备份专有：导出时刻。种子文件没有这个键。 */
  exported_at?: string;
  /** 备份专有：导出那一刻的数据模式。种子文件没有这个键（种子化一律记为 `demo`）。 */
  data_mode?: DataMode;
  settings: { base_currency: string };
  currencies: Array<{ code: string; name: string; symbol: string; sort: number; enabled: boolean }>;
  rates: Record<string, number>;
  baseHistory: Array<{
    id?: string;
    from_currency: string;
    to_currency: string;
    conversion_rate: number;
    changed_at: string;
  }>;
  platforms: Array<{ id: string; name: string; type: string; note: string; sort: number; enabled: boolean }>;
  categories: Array<{
    id: string; name: string; type: 'asset' | 'liability';
    track_principal?: boolean; default_track_principal?: boolean;
    sort: number; enabled: boolean;
  }>;
  tags: Array<{ id: string; name: string; sort: number; enabled: boolean }>;
  accounts: Array<{
    id: string; name: string; platform_id: string | null; category_id: string;
    type: 'asset' | 'liability'; currency: string; tags: string[]; note: string;
    include_in_net_worth: boolean; track_principal: boolean;
    sort: number; archived: boolean; created_at: string; updated_at?: string;
  }>;
  snapshots: Array<{
    id: string; date: string; note: string; base_currency: string;
    rates: Record<string, number>;
    total_assets: number; total_liabilities: number; net_worth: number;
    created_at: string;
    items: Array<{
      id: string; snapshot_id?: string; account_id: string;
      account_name_snapshot: string;
      platform_id_snapshot: string | null; platform_name_snapshot?: string | null;
      category_id_snapshot: string; category_name_snapshot: string;
      type: 'asset' | 'liability'; currency: string;
      original_amount: number; exchange_rate: number; amount_in_base: number;
      include_in_net_worth: boolean;
      tracks_principal?: boolean;
      principal?: number | null; principal_in_base?: number | null;
      is_carried_over?: boolean;
      tags_snapshot?: Array<{ id: string; name: string }>;
      sort?: number;
    }>;
  }>;
  draft: unknown | null;
}

export function readFixture(file: string = DEFAULT_FIXTURE): SeedFixture {
  return JSON.parse(readFileSync(file, 'utf8')) as SeedFixture;
}

/** 「是否已初始化过」的显式标记键（存在 `setting` 表） */
const INIT_KEY = 'initialized_at';

function nowIso(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function emptyStats(source: string, fx: SeedFixture): SeedStats {
  return {
    source,
    schema_version: fx.schema_version,
    app_version: fx.app_version,
    currencies: 0, rates: 0, base_history: 0,
    platforms: 0, categories: 0, tags: 0, accounts: 0, account_tags: 0,
    snapshots: 0, snapshot_items: 0, snapshot_rates: 0
  };
}

/**
 * 库是否**曾经初始化过**。
 *
 * 原判据是「`snapshot` 表非空」，但那条判据会随业务数据变化：用户把快照删空
 * （想重新开始）后重启，就会被当成全新库，而种子化的第一步是**清空全部业务表** ——
 * 于是自己建的账户 / 平台 / 分类 / 标签 / 币种设置全被演示数据覆盖。
 * 这是一条真实的数据丢失路径，2026-10-04 实测复现（清空 `snapshot` 后重启，
 * 日志再次出现 `seeded_from_fixture`）。
 *
 * 改为显式标记后，「是否初始化过」只被**初始化**与**重置**两个动作改变，
 * 不再随业务数据起落 —— 这也才对得上技术设计文档 §8.4 第 3 步的原意
 * （校验基础数据完整性，**缺失则**种子化）。
 */
export function isSeeded(raw: Database.Database): boolean {
  return hasInitMarker(raw);
}

function hasInitMarker(raw: Database.Database): boolean {
  return raw.prepare('SELECT 1 FROM setting WHERE key = ?').get(INIT_KEY) !== undefined;
}

function markInitialized(raw: Database.Database): void {
  raw.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)').run(INIT_KEY, nowIso());
}

/**
 * 老库兼容：判据换代前写入的库没有这个标记，但显然已经初始化过。
 * 判据用「有 `base_currency` 设置行」而不是「有快照」—— 一个已经建好账户、
 * 只是还没存过任何快照的库同样是已初始化的。补上标记，避免它被整表重置。
 *
 * @returns 是否补写了标记
 */
export function ensureInitMarker(raw: Database.Database): boolean {
  if (hasInitMarker(raw)) return false;
  const legacy = raw.prepare("SELECT 1 FROM setting WHERE key = 'base_currency'").get();
  if (legacy === undefined) return false;
  markInitialized(raw);
  return true;
}

/** `data_mode` 在 `setting` 表里的键名 */
const MODE_KEY = 'data_mode';

function hasModeKey(raw: Database.Database): boolean {
  return raw.prepare('SELECT 1 FROM setting WHERE key = ?').get(MODE_KEY) !== undefined;
}

/**
 * 读数据模式。
 *
 * **缺键时返回 `'live'`，这个方向是刻意选的。** `demo` 会解锁「清空账本、开始正式记账」
 * 这个破坏性动作（见 `modules/data.ts` 的 `POST /go-live` 及其 409 门禁）；
 * 把一个真实账本误标成 `demo`，等于给它配了一把误触的钥匙；而漏报的代价只是少一条提示。
 * 两害相权，取漏报。
 *
 * `setting` 键可能在写入前被读到（比如老库补记之前），所以不抛异常、只回落。
 */
export function getDataMode(raw: Database.Database): DataMode {
  const row = raw.prepare('SELECT value FROM setting WHERE key = ?').get(MODE_KEY) as
    | { value?: string }
    | undefined;
  return row?.value === 'demo' ? 'demo' : 'live';
}

function setDataMode(raw: Database.Database, mode: DataMode): void {
  raw.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)').run(MODE_KEY, mode);
}

/**
 * 老库兼容：`data_mode` 是后加的键，此前种子化出来的库没有它。
 *
 * 补记条件必须**可证**，不能靠猜：只有当库里的账户 id 集合与演示夹具的
 * **完全一致**（且夹具非空）时才写成 `'demo'`；其余一律**什么都不写** ——
 * 缺键时 `getDataMode` 返回 `'live'`，宁可漏报也不能误报（理由见其说明）。
 *
 * 为什么不能简单点（比如「有账户就说明用过」）：真实账本同样会有账户，
 * 而一次误标就会在界面上长出一个「清空演示数据」的入口 —— 指向的却不是演示数据。
 *
 * @returns 是否补写了标记
 */
export function ensureDataMode(
  raw: Database.Database,
  fixturePath: string = DEFAULT_FIXTURE
): boolean {
  if (hasModeKey(raw)) return false;
  // 全新库不必管：接下来的 `seedFromFixture` 会写。
  if (!hasInitMarker(raw)) return false;

  let ids: Set<string>;
  try {
    ids = new Set(readFixture(fixturePath).accounts.map(a => a.id));
  } catch {
    return false; // 夹具缺失或损坏时不做任何假设
  }
  if (ids.size === 0) return false;

  const rows = raw.prepare('SELECT id FROM account').all() as Array<{ id: string }>;
  if (rows.length !== ids.size || !rows.every(r => ids.has(r.id))) return false;

  setDataMode(raw, 'demo');
  return true;
}

/**
 * 清空全部业务表（顺序满足外键依赖）。
 * 种子化与「重置为空白账本」共用同一份清单 —— 漏掉一张表的后果是静默的。
 */
function clearAllTables(raw: Database.Database): void {
  raw.exec(`
    DELETE FROM inventory_draft;
    DELETE FROM snapshot_item;
    DELETE FROM snapshot_rate;
    DELETE FROM snapshot;
    DELETE FROM account_tag;
    DELETE FROM account;
    DELETE FROM tag;
    DELETE FROM category;
    DELETE FROM platform;
    DELETE FROM exchange_rate;
    DELETE FROM currency;
    DELETE FROM base_currency_history;
    DELETE FROM setting;
  `);
}

/**
 * 灌入字典与设置：设置 / 币种 / 汇率 / 本位币变更史 / 平台 / 分类 / 标签。
 * **不含账户与快照** —— 这正是「空白账本」与「演示数据」的差别所在。
 */
function loadDictionary(raw: Database.Database, fx: SeedFixture, stats: SeedStats): void {
  const now = nowIso();

  const settingUpsert = raw.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)');
  settingUpsert.run('base_currency', fx.settings.base_currency);
  settingUpsert.run('schema_version', String(fx.schema_version));
  settingUpsert.run('app_version', fx.app_version);

  /* ---------- 币种与汇率 ---------- */
  const insCur = raw.prepare(
    'INSERT INTO currency (code, name, symbol, sort, enabled) VALUES (?, ?, ?, ?, ?)'
  );
  for (const c of fx.currencies) {
    insCur.run(c.code, c.name, c.symbol, c.sort, c.enabled ? 1 : 0);
    stats.currencies++;
  }

  const insRate = raw.prepare(
    'INSERT INTO exchange_rate (currency_code, rate_to_base, updated_at) VALUES (?, ?, ?)'
  );
  for (const [code, rate] of Object.entries(fx.rates)) {
    insRate.run(code, micro(rate), now);
    stats.rates++;
  }

  const insHist = raw.prepare(
    'INSERT INTO base_currency_history (id, from_currency, to_currency, conversion_rate, changed_at) VALUES (?, ?, ?, ?, ?)'
  );
  (fx.baseHistory ?? []).forEach((h, i) => {
    insHist.run(
      h.id ?? `bch-${i + 1}`,
      h.from_currency, h.to_currency,
      micro(h.conversion_rate), h.changed_at
    );
    stats.base_history++;
  });

  /* ---------- 平台 / 分类 / 标签 ---------- */
  const insPlat = raw.prepare(
    'INSERT INTO platform (id, name, type, note, sort, enabled) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const p of fx.platforms) {
    insPlat.run(p.id, p.name, p.type, p.note, p.sort, p.enabled ? 1 : 0);
    stats.platforms++;
  }

  const insCat = raw.prepare(
    'INSERT INTO category (id, name, type, default_track_principal, sort, enabled) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const c of fx.categories) {
    const dtp = c.default_track_principal ?? c.track_principal ?? false;
    insCat.run(c.id, c.name, c.type, dtp ? 1 : 0, c.sort, c.enabled ? 1 : 0);
    stats.categories++;
  }

  const insTag = raw.prepare('INSERT INTO tag (id, name, sort, enabled) VALUES (?, ?, ?, ?)');
  for (const t of fx.tags) {
    insTag.run(t.id, t.name, t.sort, t.enabled ? 1 : 0);
    stats.tags++;
  }
}

/**
 * 把一份**文档**灌入库中。
 *
 * 不含事务、不含 `initialized_at` 标记 —— 这两件事由调用方决定，
 * 因为「首次种子化」「重置为空白账本」「从备份恢复」对它们的态度不同：
 *   - 种子化 / 恢复：要写标记（库已被初始化）
 *   - 三者的清表动作都在同一事务里（恢复失败必须整体回滚）
 *
 * 灌入前库必须是空的（调用方先 `clearAllTables`），否则主键会冲突。
 */
function loadDocument(raw: Database.Database, fx: SeedFixture, stats: SeedStats): void {
  const now = nowIso();

  loadDictionary(raw, fx, stats);

  /* ---------- 账户 ---------- */
  const insAcc = raw.prepare(`
    INSERT INTO account (
      id, name, platform_id, category_id, type, currency, note,
      include_in_net_worth, track_principal, sort, archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insAccTag = raw.prepare('INSERT INTO account_tag (account_id, tag_id) VALUES (?, ?)');
  for (const a of fx.accounts) {
    insAcc.run(
      a.id, a.name, a.platform_id, a.category_id, a.type, a.currency, a.note,
      a.include_in_net_worth ? 1 : 0, a.track_principal ? 1 : 0,
      a.sort, a.archived ? 1 : 0, a.created_at, a.updated_at ?? a.created_at
    );
    stats.accounts++;
    for (const t of a.tags ?? []) {
      insAccTag.run(a.id, t);
      stats.account_tags++;
    }
  }

  /* ---------- 快照 ---------- */
  const insSnap = raw.prepare(`
    INSERT INTO snapshot (
      id, date, note, base_currency, total_assets, total_liabilities, net_worth, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insItem = raw.prepare(`
    INSERT INTO snapshot_item (
      id, snapshot_id, account_id, account_name_snapshot,
      platform_id_snapshot, platform_name_snapshot,
      category_id_snapshot, category_name_snapshot,
      type, currency, original_amount, exchange_rate, amount_in_base,
      include_in_net_worth, tracks_principal, principal, principal_in_base,
      is_carried_over, tags_snapshot, sort
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insSnapRate = raw.prepare(
    'INSERT INTO snapshot_rate (snapshot_id, currency, rate_to_base) VALUES (?, ?, ?)'
  );

  for (const s of fx.snapshots) {
    // 汇总列取冻结口径，绝不重算
    insSnap.run(
      s.id, s.date, s.note, s.base_currency,
      micro(s.total_assets), micro(s.total_liabilities), micro(s.net_worth),
      s.created_at
    );
    stats.snapshots++;

    for (const [code, rate] of Object.entries(s.rates ?? {})) {
      insSnapRate.run(s.id, code, micro(rate));
      stats.snapshot_rates++;
    }

    s.items.forEach((it, idx) => {
      insItem.run(
        it.id,
        it.snapshot_id ?? s.id,
        it.account_id,
        it.account_name_snapshot,
        it.platform_id_snapshot ?? null,
        it.platform_name_snapshot ?? null,
        it.category_id_snapshot,
        it.category_name_snapshot,
        it.type,
        it.currency,
        micro(it.original_amount),
        micro(it.exchange_rate),
        micro(it.amount_in_base),
        it.include_in_net_worth ? 1 : 0,
        it.tracks_principal ? 1 : 0,
        micro(it.principal ?? null),
        micro(it.principal_in_base ?? null),
        it.is_carried_over ? 1 : 0,
        JSON.stringify(it.tags_snapshot ?? []),
        it.sort ?? idx + 1
      );
      stats.snapshot_items++;
    });
  }

  /* ---------- 盘点草稿 ---------- */
  if (fx.draft) {
    raw.prepare(
      'INSERT INTO inventory_draft (id, version, data, updated_at) VALUES (?, ?, ?, ?)'
    ).run('current', 1, JSON.stringify(fx.draft), now);
  }
}

/** 首次种子化：空库 → 演示数据。库已初始化过时**不应**调用（见 `isSeeded`）。 */
export function seedFromFixture(
  raw: Database.Database,
  fixturePath: string = DEFAULT_FIXTURE
): SeedStats {
  const fx = readFixture(fixturePath);
  const stats = emptyStats(fixturePath, fx);

  raw.exec('BEGIN');
  try {
    clearAllTables(raw);
    loadDocument(raw, fx, stats);
    markInitialized(raw);
    // 演示数据：库里放的是夹具那几行，界面上应显示提示并提供「开始正式记账」
    setDataMode(raw, 'demo');
    raw.exec('COMMIT');
  } catch (err) {
    raw.exec('ROLLBACK');
    throw new Error(`种子导入失败，已回滚：${(err as Error).message}`);
  }

  return stats;
}

/**
 * 从备份**文档**恢复（PRD §3.1.7 / US-05，技术设计文档 §8.3 的 `POST /restore`）。
 *
 * 三条口径，缺一条都会静默丢数据：
 *
 *   1. **版本校验先于任何写入**。备份版本高于当前 → 终止（那是更新版本写的备份，
 *      本版本不认识其中的字段，写进去就是丢字段）；低于当前 → 走迁移表，
 *      迁移表里没有对应条目就终止。绝不「尽力而为地导入一部分」。
 *   2. **整体覆盖包在单个事务里**。清表 + 灌入是一体的：中途失败必须回滚到
 *      恢复前的状态 —— 校验通过但灌入到一半失败时，用户的原数据不能没了。
 *   3. **重写 `initialized_at`**。备份文档里的标记是备份那一刻的，恢复后必须
 *      按当前时间重写；否则下次启动会被当成「从未初始化」，把演示数据灌进来
 *      盖掉刚恢复的内容（这正是 I-24 修掉的那条路径）。
 *
 * @throws AppError 版本不兼容时（RULE_VIOLATION 422）
 */
export function restoreFromDocument(raw: Database.Database, doc: SeedFixture): SeedStats {
  const current = currentSchemaVersion(raw);
  const incoming = Number(doc?.schema_version);

  if (!Number.isInteger(incoming) || incoming <= 0) {
    throw fail.validation('备份文件缺少有效的 schema_version');
  }
  if (incoming > current) {
    throw fail.rule(
      `备份文件的版本（schema_version=${incoming}）高于当前程序支持的版本（${current}）。` +
        '请升级程序后再恢复，本次不写入任何数据。',
      { backup_schema_version: incoming, current_schema_version: current }
    );
  }

  let normalized = doc;
  if (incoming < current) {
    normalized = migrateDocument(doc, incoming, current);
  }

  const stats = emptyStats('restore', normalized);

  raw.exec('BEGIN');
  try {
    clearAllTables(raw);
    loadDocument(raw, normalized, stats);
    // 关键：用**当前时刻**重写标记，而不是沿用文档里的
    markInitialized(raw);
    /* 数据模式随备份文档走（恢复一份演示备份，恢复后仍是演示数据，
       界面上该提示的照旧提示）；老备份没有这个字段，回落 `'live'` ——
       与 `getDataMode` 同一个取舍方向：宁可漏报，不可误报。 */
    setDataMode(raw, normalized.data_mode === 'demo' ? 'demo' : 'live');
    raw.exec('COMMIT');
  } catch (err) {
    raw.exec('ROLLBACK');
    throw fail.rule(`恢复失败，原数据未被修改：${(err as Error).message}`);
  }

  return stats;
}

/**
 * 当前库的 schema_version。
 *
 * 取 `PRAGMA user_version` —— 它是迁移机制的唯一权威（技术设计文档 §6.3），
 * 备份文档顶层的 `schema_version` 与它同值。
 */
export function currentSchemaVersion(raw: Database.Database): number {
  const v = raw.pragma('user_version', { simple: true });
  return typeof v === 'number' ? v : Number(v ?? 0);
}

/**
 * 低版本备份的字段迁移。
 *
 * 当前只有 v1，迁移表为空 —— 所以任何低于当前版本的备份都会在此明确报错，
 * 而不是被「当成当前版本硬灌」。这与 PRD 的「无法迁移时明确报错并终止，
 * 不静默丢数据」一致：**空表不是遗漏，是此刻的正确答案**。
 * 将来新增 v2 时，在这里加 `2: doc => ...` 即可，恢复路径一行不用改。
 */
type DocumentMigration = (doc: SeedFixture) => SeedFixture;

const DOCUMENT_MIGRATIONS: Record<number, DocumentMigration> = {};

function migrateDocument(doc: SeedFixture, from: number, to: number): SeedFixture {
  let cur = doc;
  for (let v = from; v < to; v++) {
    const step = DOCUMENT_MIGRATIONS[v];
    if (!step) {
      throw fail.rule(
        `备份文件的版本为 ${from}，当前为 ${to}，但没有可用的字段迁移路径。` +
          '请用写入该备份的程序版本导出为兼容格式后再恢复，本次不写入任何数据。',
        { backup_schema_version: from, current_schema_version: to }
      );
    }
    cur = step(cur);
  }
  return cur;
}

/**
 * 重置为**空白账本**：清掉账户与快照（含盘点草稿与本位币变更史），
 * 但保留现成的字典（币种 / 汇率 / 平台 / 分类 / 标签 / 设置）。
 *
 * 这是「开始录自己的真实资产」的入口。没有它，用户只能手动删库 ——
 * 而手动删库后重启，在旧判据下会把演示数据原样灌回来（见 `isSeeded` 的说明）。
 *
 * 注意 `clearAllTables` 会连 `setting` 一起清掉，因此本位币会回到 fixture 的默认值；
 * 这符合「重新开始」的语义，已在 CLI 输出里写明。
 */
export function resetToDictionary(
  raw: Database.Database,
  fixturePath: string = DEFAULT_FIXTURE
): SeedStats {
  const fx = readFixture(fixturePath);
  const stats = emptyStats(fixturePath, fx);

  raw.exec('BEGIN');
  try {
    clearAllTables(raw);
    loadDictionary(raw, fx, stats);
    markInitialized(raw);
    // 用户主动从空白开始 → 这是自己的账本，不再显示演示提示
    setDataMode(raw, 'live');
    raw.exec('COMMIT');
  } catch (err) {
    raw.exec('ROLLBACK');
    throw new Error(`重置为空白账本失败，已回滚：${(err as Error).message}`);
  }

  return stats;
}
