/**
 * 数据管理模块（Step 5）：导出 / 导入 / 备份 / 恢复（技术设计文档 §8.3、§6.6）
 *
 * ## 三个刻意的设计取舍
 *
 * 1. **导入走 JSON 传文本，不走 multipart**。`contentTypeGuard`（I-23）要求
 *    「带请求体的写操作必须是 `application/json`」，那是 CSRF 防护链的一环
 *    （强制触发 CORS 预检）。为一个导入端点放宽它，等于在防护链上开一个
 *    只此一次的例外 —— 而例外会繁殖。前端读文件文本后以 JSON 提交，
 *    解析仍由服务端做。
 *
 * 2. **导入只动账户档案（§8.4 的事务边界表原文：「导入 = 全部 account 变更 +
 *    关联标签」）**。CSV 里的「余额」列会被读出并显示在差异预览里，但**不落库** ——
 *    余额必须经过盘点向导录入（三态 / 冻结汇率 / 门禁）。从 CSV 直接灌余额会绕过
 *    这三道，产出一张来路不明的快照。界面上把这条边界写清楚，不让用户误以为
 *    导入完就盘完了。
 *
 * 3. **恢复前先自动备份**。恢复是本系统唯一的破坏性操作，点错一次原数据就没了。
 *    恢复前用它自己的备份机制留一份 `pre-restore-*.sqlite`，把「不可逆」变成
 *    「可退回」。备份失败不回滚恢复（用户可能正是因为磁盘问题才需要恢复），
 *    但会把 `pre_restore_backup: null` 如实返回，界面必须显示。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Hono } from 'hono';
import {
  exportCsvQuerySchema,
  importBodySchema,
  parseQuery,
  restoreBodySchema,
  type BackupEntryDTO,
  type ImportPreviewDTO,
  type ImportRowDTO
} from '@app/shared';
import type { Account, AccountType } from '@app/domain';
import type { AppEnv } from '../middleware.ts';
import type { Db } from '../db/client.ts';
import { openReadonly } from '../db/client.ts';
import * as repo from '../db/repo.ts';
import * as w from '../db/writes.ts';
import { buildBackupDocument } from '../db/export.ts';
import {
  backupNameFor,
  backupsDir,
  dateStamp,
  listBackups,
  pruneBackups,
  runBackup,
  type BackupEntry
} from '../db/backup.ts';
import {
  getDataMode,
  resetToDictionary,
  restoreFromDocument,
  type SeedFixture
} from '../db/seed.ts';
import { decodeCsvWithHeader, encodeCsv, type CsvValue } from '../lib/csv.ts';
import { fail } from '../lib/errors.ts';

export interface DataRoutesOptions {
  dataDir: string;
  /** 保留份数（§6.6，默认 30） */
  backupKeep: number;
  /** 结构性日志出口 */
  log: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
}

/** 恢复前兜底备份的专用前缀：不进常规列表，也不参与常规保留清理 */
const PRE_RESTORE_PREFIX = 'pre-restore-';
/** 最多留几份 pre-restore（再多没意义，用户只需要退回最近一次） */
const PRE_RESTORE_KEEP = 3;
/** 差异预览最多回传的行数（超出只计数，避免响应体过大） */
const PREVIEW_ROW_CAP = 500;

export function createDataRoutes(db: Db, opts: DataRoutesOptions): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /* ============================================================
     导出
     ============================================================ */

  r.get('/export/full', c => {
    const doc = buildBackupDocument(db);
    return c.body(JSON.stringify(doc, null, 2), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="asset-snapshot-${dateStamp()}.json"`
    });
  });

  r.get('/export/csv', c => {
    const q = parseQuery(exportCsvQuerySchema, c.req.query());
    const snapshots = repo.loadSeries(db).snapshots; // 时间升序
    if (snapshots.length === 0) throw fail.notFound('还没有任何快照，没有可导出的内容');

    const currencyMeta = repo.currencyMetaLookup(db);

    if (q.type === 'summary') {
      const rows: CsvValue[][] = [
        ['日期', '备注', '本位币', '总资产', '总负债', '净资产', '明细数', '创建时间']
      ];
      for (const s of snapshots) {
        rows.push([
          s.date,
          s.note,
          s.base_currency,
          s.total_assets.toPlain(2),
          s.total_liabilities.toPlain(2),
          s.net_worth.toPlain(2),
          s.items.length,
          s.created_at
        ]);
      }
      return csvFile(c, rows, `asset-summary-${dateStamp()}.csv`);
    }

    const snap = q.snapshot_id
      ? snapshots.find(s => s.id === q.snapshot_id)
      : snapshots[snapshots.length - 1];
    if (!snap) throw fail.notFound(`快照不存在：${q.snapshot_id}`);

    const rows: CsvValue[][] = [
      [
        '账户名', '平台', '分类', '类型', '币种',
        '原币金额', '汇率', '折本位币金额',
        '计入净资产', '沿用上次', '本金（原币）', '本金折本位币',
        '标签', '备注'
      ]
    ];
    for (const it of snap.items) {
      rows.push([
        it.account_name_snapshot,
        it.platform_name_snapshot,
        it.category_name_snapshot,
        it.type === 'asset' ? '资产' : '负债',
        // 带符号的币种标签（HK$ / € / S$），方便直接读表
        `${it.currency}${currencyMeta(it.currency).symbol}`,
        it.original_amount.toPlain(2),
        trimZeros(it.exchange_rate.toPlain(6)),
        it.amount_in_base.toPlain(2),
        it.include_in_net_worth ? '是' : '否',
        it.is_carried_over ? '是' : '否',
        it.principal ? it.principal.toPlain(2) : '',
        it.principal_in_base ? it.principal_in_base.toPlain(2) : '',
        it.tags_snapshot.map(t => t.name).join(' / '),
        ''
      ]);
    }
    return csvFile(c, rows, `asset-items-${snap.date}.csv`);
  });

  /* ============================================================
     备份
     ============================================================ */

  r.get('/backup', c => {
    const items = listBackups(opts.dataDir).map(toBackupEntryDTO);
    return c.json({ items, keep: opts.backupKeep });
  });

  r.post('/backup', async c => {
    let entry: BackupEntry;
    try {
      entry = await runBackup(db, opts.dataDir);
    } catch (err) {
      // 给可读原因：备份写的是磁盘，失败原因对用户有意义（权限 / 空间）
      throw fail.internal(`备份失败：${(err as Error).message}`);
    }
    const pruned = pruneBackups(opts.dataDir, opts.backupKeep).length;
    opts.log('info', 'backup_done', { file: entry.name, size: entry.size, pruned });
    return c.json({ ...toBackupEntryDTO(entry), pruned });
  });

  /* ============================================================
     恢复
     ============================================================ */

  r.post('/restore', async c => {
    const body = restoreBodySchema.parse(await c.req.json());

    const doc: SeedFixture =
      body.document !== undefined
        ? (body.document as SeedFixture)
        : readBackupDocument(join(backupsDir(opts.dataDir), body.backup_name!));

    if (doc === null || typeof doc !== 'object') {
      throw fail.validation('备份文档必须是 JSON 对象');
    }

    /* 恢复前兜底备份。失败不阻断 —— 用户可能正是因为当前库有问题才要恢复；
       但结果要如实回传，界面必须显示出来。 */
    const preBackup = await runPreRestoreBackup(db, opts.dataDir, opts.log);

    const stats = restoreFromDocument(db.raw, doc);

    opts.log('info', 'restored', {
      from_schema_version: doc.schema_version,
      accounts: stats.accounts,
      snapshots: stats.snapshots,
      pre_restore_backup: preBackup
    });

    return c.json({
      schema_version: stats.schema_version,
      app_version: stats.app_version,
      restored: {
        currencies: stats.currencies,
        rates: stats.rates,
        base_history: stats.base_history,
        platforms: stats.platforms,
        categories: stats.categories,
        tags: stats.tags,
        accounts: stats.accounts,
        snapshots: stats.snapshots,
        snapshot_items: stats.snapshot_items
      },
      pre_restore_backup: preBackup
    });
  });

  /* ============================================================
     开始正式记账（演示数据 → 自己的账本）
     ============================================================ */

  /**
   * 清掉演示的账户与快照，保留字典，并把数据模式记为 `live`。
   *
   * 与命令行的 `npm run reset` 是同一件事（同一个 `resetToDictionary`），
   * 只是入口放在界面上 —— 这样「首次打开看到演示数据」与「开始记自己的账」
   * 之间不需要用户离开浏览器去敲命令。
   *
   * ## 为什么服务端要自己把门关上
   *
   * 界面只在 `data_mode === 'demo'` 时渲染这个按钮，但**界面不是门禁**：
   * 任何能发请求的东西都能直接打这个端点。所以这里**独立地再判一次**，
   * 不是演示数据就 409 拒绝。两道门各自成立，不依赖对方。
   *
   * 拒绝时给出可执行的出路：命令行的 `npm run reset -- --yes` —— 那道门槛
   * 要求手输 `--yes`，正是「随手可点」与「真的想清空」之间该有的距离。
   */
  r.post('/go-live', c => {
    if (getDataMode(db.raw) !== 'demo') {
      throw fail.conflict(
        '当前账本不是演示数据，已拒绝清空。' +
          '想从空白账本重新开始，请在命令行执行：npm run reset -- --yes'
      );
    }

    // 先数一遍要清掉什么：清完之后就没法如实说明了
    const cleared = {
      accounts: countRows(db, 'account'),
      snapshots: countRows(db, 'snapshot'),
      snapshot_items: countRows(db, 'snapshot_item')
    };

    resetToDictionary(db.raw);
    opts.log('info', 'went_live', cleared);

    return c.json({ data_mode: getDataMode(db.raw), cleared });
  });

  /* ============================================================
     导入（账户档案）
     ============================================================ */

  r.post('/import/preview', async c => {
    const body = importBodySchema.parse(await c.req.json());
    return c.json(toPreviewDTO(planImport(db, body.content)));
  });

  r.post('/import/apply', async c => {
    const body = importBodySchema.parse(await c.req.json());
    const plan = planImport(db, body.content);

    if (plan.conflicts > 0) {
      /* 有冲突就整体拒绝，而不是「跳过冲突行、导入其余」。
         后者会留下一份「导入了一半」的账户表，而用户以为都成功了。 */
      throw fail.rule(
        `有 ${plan.conflicts} 行无法导入，本次未写入任何数据。请修正后再试。`,
        { conflicts: plan.conflicts, rows: plan.rows.filter(x => x.action === 'conflict').slice(0, 20) }
      );
    }

    w.tx(db, () => {
      for (const op of plan.ops) {
        if (op.kind === 'insert') {
          w.insertAccount(db, op.account, []);
        } else {
          w.updateAccount(db, op.id, op.patch);
        }
      }
    });

    return c.json({ inserted: plan.inserted, updated: plan.updated, skipped: plan.skipped });
  });

  return r;
}

/* ============================================================
   内部工具
   ============================================================ */

function csvFile(
  c: { body: (data: string, status: 200, headers: Record<string, string>) => Response },
  rows: CsvValue[][],
  filename: string
): Response {
  return c.body(encodeCsv(rows), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
}

/** `1000.000000` → `1000`；`1.075300` → `1.0753`（汇率列去尾零，读表更清爽） */
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * 数一遍某张表的行数（`/go-live` 用它如实回传「刚才清掉了什么」）。
 *
 * 表名只接受这三个字面量、**不来自请求** —— 所以这里的模板串拼接没有注入面。
 */
function countRows(db: Db, table: 'account' | 'snapshot' | 'snapshot_item'): number {
  const row = db.raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

function toBackupEntryDTO(e: BackupEntry): BackupEntryDTO {
  return { ...e, is_today: e.name === backupNameFor() };
}

/**
 * 从 `backups/` 里的 sqlite 文件读出备份文档。
 *
 * 走「读出表内容 → 转成文档 → 交给同一条恢复路径」，而不是「直接复制文件覆盖
 * 当前库」：后者绕开了版本校验与单事务覆盖，且要求先关连接再换文件。
 * 同一份恢复实现只有一处，校验就不可能被漏掉。
 *
 * 文件不存在时给 404 而不是让它冒成 500：名字过了白名单正则不代表文件还在
 * （用户可能在别处删过，或换过机器）。「这份备份不在了」是用户能处理的，
 * 「服务器内部错误」不是。消息里只带文件名，不带完整路径。
 */
function readBackupDocument(file: string): SeedFixture {
  if (!existsSync(file)) {
    throw fail.notFound(`备份文件不存在：${basename(file)}`);
  }
  const src = openReadonly(file);
  try {
    return buildBackupDocument(src);
  } finally {
    src.raw.close();
  }
}

/**
 * 恢复前的兜底备份。
 *
 * 用 `pre-restore-` 前缀而不是复用 `backup-YYYY-MM-DD.sqlite`：
 * 后者会被恢复当天的常规备份覆盖掉，那份「恢复前的状态」可能正是用户要退回的地方。
 *
 * @returns 备份文件名；失败返回 null（**不抛**，恢复继续进行）
 */
async function runPreRestoreBackup(
  db: Db,
  dataDir: string,
  log: DataRoutesOptions['log']
): Promise<string | null> {
  const dir = backupsDir(dataDir);
  const name = `${PRE_RESTORE_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
  try {
    mkdirSync(dir, { recursive: true });
    await db.raw.backup(join(dir, name));
    prunePreRestore(dir);
    log('info', 'pre_restore_backup', { file: name });
    return name;
  } catch (err) {
    log('warn', 'pre_restore_backup_failed', { error_message: (err as Error).message });
    return null;
  }
}

function prunePreRestore(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const mine = names.filter(n => n.startsWith(PRE_RESTORE_PREFIX)).sort().reverse();
  for (const n of mine.slice(PRE_RESTORE_KEEP)) {
    try {
      rmSync(join(dir, n));
    } catch {
      /* 删不掉不致命 */
    }
  }
}

/* ============================================================
   导入计划
   ============================================================ */

type ImportOp =
  | {
      kind: 'insert';
      line: number;
      account: Parameters<typeof w.insertAccount>[1];
    }
  | {
      kind: 'update';
      line: number;
      id: string;
      patch: Parameters<typeof w.updateAccount>[2];
    };

interface ImportPlan {
  rows: ImportRowDTO[];
  ops: ImportOp[];
  inserted: number;
  updated: number;
  conflicts: number;
  skipped: number;
  truncated: boolean;
}

/** 校验通过的一行，尚未决定 insert / update */
interface ParsedRow {
  line: number;
  name: string;
  platformName: string;
  platformId: string | null;
  categoryId: string;
  categoryType: AccountType;
  trackDefault: boolean;
  currency: string;
  type: AccountType;
  note: string;
  amount: number | null;
  /** 匹配键：账户名 + 平台 id */
  key: string;
}

const TYPE_ALIASES: Record<string, AccountType> = {
  asset: 'asset',
  liability: 'liability',
  资产: 'asset',
  负债: 'liability'
};

/** 表头名（顺序随意，按名取列） */
const H = {
  name: '账户名',
  platform: '平台',
  category: '分类',
  currency: '币种',
  type: '类型',
  note: '备注',
  amount: '金额'
} as const;

/**
 * 生成导入计划：**只计算，不写入**（preview 与 apply 共用同一份判定）。
 *
 * 判定分两遍，因为「重复行后者覆盖前者」（PRD §3.1.7）只有在看完整份文件后
 * 才知道哪一行被覆盖了。边解析边落库就会把被覆盖的那行也写进去。
 *
 * 校验一律「先全查字典再判定」，不在循环里查库：平台 / 分类 / 币种各读一次，
 * 几万行的 CSV 也只查三次。
 */
function planImport(db: Db, content: string): ImportPlan {
  const records = decodeCsvWithHeader(content);

  if (records.length === 0) throw fail.validation('CSV 没有数据行');
  if (!(H.name in records[0])) {
    throw fail.validation(`CSV 缺少必需的表头列「${H.name}」`, { got: Object.keys(records[0]) });
  }

  const platformByName = new Map(repo.listPlatforms(db).map(p => [p.name.trim(), p]));
  const categoryByName = new Map(repo.listCategories(db).map(c => [c.name.trim(), c]));
  const currencyCodes = new Set(repo.listCurrencies(db).map(c => c.code.toUpperCase()));
  const existing = new Map<string, Account>();
  for (const a of repo.listAccounts(db)) existing.set(keyOf(a.name, a.platform_id), a);

  const rows: ImportRowDTO[] = [];
  const parsed: ParsedRow[] = [];
  let conflicts = 0;
  let skipped = 0;

  records.forEach((rec, idx) => {
    const line = idx + 2; // 表头占第 1 行
    const name = (rec[H.name] ?? '').trim();
    const platformName = (rec[H.platform] ?? '').trim();
    const categoryName = (rec[H.category] ?? '').trim();
    const currency = (rec[H.currency] ?? '').trim().toUpperCase();
    const typeRaw = (rec[H.type] ?? '').trim();
    const note = (rec[H.note] ?? '').trim();
    const amount = parseAmount(rec[H.amount]);

    const base = { line, account_name: name, platform_name: platformName, currency, amount };

    // 整行空 → 跳过（Excel 导出常带尾随空行）
    if (!name && !platformName && !categoryName && !currency) {
      skipped++;
      rows.push({ ...base, action: 'skip', reason: '空行' });
      return;
    }

    const reject = (reason: string): void => {
      conflicts++;
      rows.push({ ...base, action: 'conflict', reason });
    };

    if (!name) return reject('账户名为空');

    const platform = platformName ? platformByName.get(platformName) : null;
    if (platformName && !platform) return reject(`平台「${platformName}」不存在，请先在设置页建好`);

    if (!categoryName) return reject('分类为空');
    const category = categoryByName.get(categoryName);
    if (!category) return reject(`分类「${categoryName}」不存在，请先在设置页建好`);

    if (!currency) return reject('币种为空');
    if (!currencyCodes.has(currency)) return reject(`币种「${currency}」未启用或不存在`);

    let type: AccountType;
    if (typeRaw) {
      const t = TYPE_ALIASES[typeRaw] ?? TYPE_ALIASES[typeRaw.toLowerCase()];
      if (!t) return reject(`类型「${typeRaw}」无效（只接受 资产 / 负债 / asset / liability）`);
      type = t;
    } else {
      // 缺省取分类自带的类型 —— 分类本来就带类型，没必要让用户再写一遍
      type = category.type;
    }
    if (category.type !== type) {
      return reject(
        `分类「${categoryName}」属于${category.type === 'asset' ? '资产' : '负债'}，与类型「${typeRaw}」不一致`
      );
    }

    const platformId = platform?.id ?? null;
    parsed.push({
      line,
      name,
      platformName,
      platformId,
      categoryId: category.id,
      categoryType: category.type,
      trackDefault: category.default_track_principal,
      currency,
      type,
      note,
      amount,
      key: keyOf(name, platformId)
    });
  });

  /* 第二遍：同一份文件里「账户名 + 平台」重复时，后者覆盖前者。
     被覆盖的那行**不导入**，但也**不算冲突** —— 这是 PRD 定义好的行为，
     不该让一次正常的导入因为文件里有两行同名而被整体拒绝。 */
  const effective = new Map<string, ParsedRow>();
  const superseded = new Set<number>();
  for (const p of parsed) {
    const prev = effective.get(p.key);
    if (prev) superseded.add(prev.line);
    effective.set(p.key, p);
  }

  const ops: ImportOp[] = [];
  let inserted = 0;
  let updated = 0;
  const baseSort = w.nextSort(db, 'account');

  for (const p of parsed) {
    const base = {
      line: p.line,
      account_name: p.name,
      platform_name: p.platformName,
      currency: p.currency,
      amount: p.amount
    };

    if (superseded.has(p.line)) {
      skipped++;
      rows.push({ ...base, action: 'skip', reason: '与文件后面的同名同平台行重复（后者覆盖前者）' });
      continue;
    }

    const hit = existing.get(p.key);
    if (hit) {
      updated++;
      rows.push({ ...base, action: 'update', matched_account_id: hit.id });
      ops.push({
        kind: 'update',
        line: p.line,
        id: hit.id,
        patch: {
          category_id: p.categoryId,
          type: p.type,
          currency: p.currency,
          note: p.note,
          updated_at: w.nowIso()
        }
      });
      continue;
    }

    const now = w.nowIso();
    const sort = baseSort + inserted;
    inserted++;
    rows.push({ ...base, action: 'insert' });
    ops.push({
      kind: 'insert',
      line: p.line,
      account: {
        id: w.newId('acc'),
        name: p.name,
        platform_id: p.platformId,
        category_id: p.categoryId,
        type: p.type,
        currency: p.currency,
        note: p.note,
        include_in_net_worth: true,
        // 与服务端建账户的规则同源：缺省取分类默认值，且负债不可跟踪本金
        track_principal: p.type === 'asset' && p.trackDefault,
        sort,
        archived: false,
        created_at: now,
        updated_at: now
      }
    });
  }

  // 预览按 CSV 行号排序，用户在表里看到的顺序与文件一致
  rows.sort((a, b) => a.line - b.line);

  return {
    rows: rows.slice(0, PREVIEW_ROW_CAP),
    ops,
    inserted,
    updated,
    conflicts,
    skipped,
    truncated: rows.length > PREVIEW_ROW_CAP
  };
}

function toPreviewDTO(plan: ImportPlan): ImportPreviewDTO {
  return {
    inserted: plan.inserted,
    updated: plan.updated,
    conflicts: plan.conflicts,
    skipped: plan.skipped,
    rows: plan.rows,
    truncated: plan.truncated
  };
}

function keyOf(name: string, platformId: string | null): string {
  return `${name.trim()}\u0000${platformId ?? ''}`;
}

/** `"1,234.56"` / `"¥1,234.56"` → 1234.56；空或不可解析 → null */
function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s¥$€£]/g, '').replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
