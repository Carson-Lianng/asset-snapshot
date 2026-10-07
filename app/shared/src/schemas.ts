/**
 * zod 边界校验 —— 请求侧的运行时校验（技术设计文档 ADR-07）
 *
 * 只校验「进入系统的输入」。响应侧靠 `contracts.ts` 的类型约束 + 编译期检查，
 * 不做运行时双写，避免两处定义漂移。
 */
import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform(v => (typeof v === 'boolean' ? v : v === 'true' || v === '1'));

export const dimSchema = z.enum(['account', 'platform', 'category', 'currency', 'tag']);
export const viewModeSchema = z.enum(['origin', 'current']);
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期须为 YYYY-MM-DD');

export const listQuerySchema = z.object({
  includeDisabled: boolish.optional().default(false)
});

export const accountListQuerySchema = z.object({
  platform_id: z.string().min(1).optional(),
  category_id: z.string().min(1).optional(),
  tag_id: z.string().min(1).optional(),
  archived: boolish.optional(),
  q: z.string().max(100).optional()
});

export const snapshotListQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional()
});

export const snapshotDetailQuerySchema = z.object({
  view: viewModeSchema.optional().default('origin')
});

export const snapshotCompareQuerySchema = z.object({
  a: z.string().min(1, '缺少参数 a'),
  b: z.string().min(1, '缺少参数 b'),
  dim: dimSchema.optional().default('platform'),
  mode: viewModeSchema.optional().default('origin')
});

export const trendQuerySchema = z.object({
  metric: z.enum(['net_worth', 'total_assets', 'total_liabilities']).optional().default('net_worth'),
  mode: viewModeSchema.optional().default('origin')
});

export const breakdownQuerySchema = z.object({
  snapshot_id: z.string().min(1, '缺少参数 snapshot_id'),
  dim: dimSchema.optional().default('platform'),
  mode: viewModeSchema.optional().default('origin')
});

export const returnsQuerySchema = z.object({
  snapshot_id: z.string().min(1, '缺少参数 snapshot_id')
});

/** snapshot_id 可缺省：缺省时服务端取「最新一张」 */
export const snapshotScopedSchema = z.object({
  snapshot_id: z.string().min(1).optional(),
  mode: viewModeSchema.optional().default('origin')
});

export const returnsBreakdownQuerySchema = z.object({
  snapshot_id: z.string().min(1, '缺少参数 snapshot_id'),
  dim: z.enum(['account', 'platform', 'category', 'currency']).optional().default('platform')
});

export const itemReturnsQuerySchema = z.object({
  snapshot_id: z.string().min(1, '缺少参数 snapshot_id')
});

/** 解析查询串为普通对象（Hono 的 c.req.query() 已是对象，这里统一做一次清洗） */
export function parseQuery<S extends z.ZodTypeAny>(
  schema: S,
  raw: Record<string, string | undefined>
): z.infer<S> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== '') cleaned[k] = v;
  }
  return schema.parse(cleaned);
}

/* ============================================================
   请求体（写路径，技术设计文档 §8.3）
   ── 金额与汇率沿用与响应完全相同的编码：**微元整数（×10^6）**。
      `.int()` 是刻意的：它能挡住「前端忘了换算就直接把元传上来」这类错误 ——
      一旦传小数，就是 400 而不是悄悄写进库里一个差 10^6 倍的数。
   ============================================================ */

const microSchema = z.number().int('金额必须以微元整数（×10^6）传输');
const microNullable = microSchema.nullable();
const nameSchema = z.string().trim().min(1, '名称不能为空').max(50, '名称最长 50 字');
const noteSchema = z.string().max(200, '备注最长 200 字');

export const idBodySchema = z.object({ id: z.string().min(1).max(64) });
export const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'ids 不能为空')
});

/* ---------- 币种 ---------- */
export const currencyCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z]{2,8}$/, '币种代码须为 2~8 位大写字母'),
  name: nameSchema,
  symbol: z.string().trim().min(1, '符号不能为空').max(8),
  enabled: z.boolean().optional().default(true),
  /** 相对本位币的汇率（微元）；缺省 1 */
  rate_to_base: microSchema.optional(),
  sort: z.number().int().optional()
});
export const currencyPatchSchema = z
  .object({
    name: nameSchema.optional(),
    symbol: z.string().trim().min(1).max(8).optional(),
    enabled: z.boolean().optional(),
    sort: z.number().int().optional(),
    rate_to_base: microSchema.optional()
  })
  .refine(v => Object.keys(v).length > 0, '至少提供一个要修改的字段');

/* ---------- 汇率与设置 ---------- */
export const ratesPutSchema = z.object({
  /** 键为币种代码；值为「1 单位该币种 = 多少本位币」，微元 */
  rates: z.record(z.string().min(1), microSchema)
});

export const settingsPutSchema = z.object({
  key: z.string().trim().min(1).max(64),
  value: z.string().max(200)
});

export const baseCurrencyChangeSchema = z.object({
  to: z.string().trim().regex(/^[A-Z]{2,8}$/, '本位币须为币种代码'),
  /** 1 旧本位币 = conversion_rate 新本位币（微元） */
  conversion_rate: microSchema.refine(v => v > 0, '换算比价必须大于 0'),
  /**
   * 前端预览表里**逐条修正过**的汇率（微元），可选。
   *
   * 原型 `nbApply` 存的是表里那一列（`rates[r.code] = parseFloat(r.nv)`），不是反算结果 ——
   * 界面上写着「可逐条修正后再保存」，那些修正必须以它为准。
   * 不传时服务端才走整表反算（`新汇率 = 旧汇率 × R`）。
   */
  rates: z.record(z.string().min(1), microSchema).optional()
});

/* ---------- 平台 ---------- */
export const platformCreateSchema = z.object({
  name: nameSchema,
  type: z.string().trim().max(20).optional().default('other'),
  note: noteSchema.optional().default(''),
  enabled: z.boolean().optional().default(true),
  sort: z.number().int().optional()
});
export const platformPatchSchema = z
  .object({
    name: nameSchema.optional(),
    type: z.string().trim().max(20).optional(),
    note: noteSchema.optional(),
    enabled: z.boolean().optional(),
    sort: z.number().int().optional()
  })
  .refine(v => Object.keys(v).length > 0, '至少提供一个要修改的字段');

/* ---------- 分类 ---------- */
export const categoryCreateSchema = z.object({
  name: nameSchema,
  type: z.enum(['asset', 'liability']),
  default_track_principal: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true),
  sort: z.number().int().optional()
});
export const categoryPatchSchema = z
  .object({
    name: nameSchema.optional(),
    type: z.enum(['asset', 'liability']).optional(),
    default_track_principal: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sort: z.number().int().optional()
  })
  .refine(v => Object.keys(v).length > 0, '至少提供一个要修改的字段');

/* ---------- 标签 ---------- */
export const tagCreateSchema = z.object({
  name: nameSchema,
  enabled: z.boolean().optional().default(true),
  sort: z.number().int().optional()
});
export const tagPatchSchema = z
  .object({
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    sort: z.number().int().optional()
  })
  .refine(v => Object.keys(v).length > 0, '至少提供一个要修改的字段');

/* ---------- 账户 ---------- */
export const accountCreateSchema = z.object({
  name: nameSchema,
  platform_id: z.string().min(1).nullable().optional().default(null),
  category_id: z.string().min(1, '必须选择分类'),
  type: z.enum(['asset', 'liability']),
  currency: z.string().min(1, '必须选择币种'),
  tags: z.array(z.string().min(1)).max(20).optional().default([]),
  note: noteSchema.optional().default(''),
  include_in_net_worth: z.boolean().optional().default(true),
  /**
   * 缺省时按所属分类的 `default_track_principal` 取（PRD §3.1.5）。
   * 只有资产账户允许跟踪本金 —— 负债账户传 true 会被下面 refine 拦下。
   */
  track_principal: z.boolean().optional(),
  archived: z.boolean().optional().default(false),
  sort: z.number().int().optional()
});

export const accountPatchSchema = z
  .object({
    name: nameSchema.optional(),
    platform_id: z.string().min(1).nullable().optional(),
    category_id: z.string().min(1).optional(),
    type: z.enum(['asset', 'liability']).optional(),
    currency: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).max(20).optional(),
    note: noteSchema.optional(),
    include_in_net_worth: z.boolean().optional(),
    track_principal: z.boolean().optional(),
    archived: z.boolean().optional(),
    sort: z.number().int().optional()
  })
  .refine(v => Object.keys(v).length > 0, '至少提供一个要修改的字段');

/* ---------- 盘点 ---------- */
export const entryStateSchema = z.enum(['filled', 'carry', 'unfilled']);

export const entrySchema = z.object({
  amount: microNullable,
  principal: microNullable,
  state: entryStateSchema
});

export const entriesSchema = z.record(z.string().min(1), entrySchema);

/** GET /inventory/draft 与 POST /inventory/session 的返回里，草稿是这个形态 */
export const draftPayloadSchema = z.object({
  version: z.number().int().min(0),
  date: isoDateSchema.nullable(),
  note: z.string().max(200),
  entries: entriesSchema,
  /** Step 2 改过的汇率（微元）。缺省即「没改过」，由 /rates 兜底 */
  rates: z.record(z.string().min(1), microSchema).optional()
});

export const draftPutSchema = z.object({
  /** 乐观锁：null 表示「不校验版本」（草稿不存在时的首次写入） */
  version: z.number().int().min(0).nullable(),
  date: isoDateSchema.nullable(),
  note: z.string().max(200).optional().default(''),
  entries: entriesSchema,
  rates: z.record(z.string().min(1), microSchema).optional()
});

/**
 * 向导第 2 步用户**确认或改过**的汇率（微元）。
 *
 * 为什么 preview / save 也必须有这一项（原设计漏了，见 I-22）：
 * 原型 `invSave()` 里是 `const rate = a.currency === baseCur() ? 1 : (inv.rates[a.currency] || 0)`
 * —— 落库用的是**界面上那张表**，并把 `inv.rates` 一并冻结进 `snapshot_rate`。
 * 服务端如果只认 DB 里的 `/rates`，用户在第 2 步改的汇率就只影响第 3 步的实时汇总：
 * 确认页会退回旧汇率（`preview`），快照冻结的也是旧汇率（`save`）——
 * 正是设计文档反复声明「在结构上不可能发生」的那种「确认页显示 A、保存后是 B」。
 * 实测 HKD 0.93 → 0.94 一改，净资产就差了 ¥2,540。
 *
 * 缺省（老客户端 / 不关心汇率）时由 `/rates` 兜底，行为与修复前一致。
 */
const inventoryRatesSchema = z.record(z.string().min(1), microSchema).optional();

export const inventoryPreviewSchema = z.object({
  date: isoDateSchema,
  entries: entriesSchema,
  rates: inventoryRatesSchema
});

export const inventorySaveSchema = z.object({
  date: isoDateSchema,
  note: z.string().max(200).optional().default(''),
  entries: entriesSchema,
  rates: inventoryRatesSchema,
  /**
   * 「未填写清单」的确认位。存在未填写账户而此位为 false 时，
   * 服务端返回 422 并附上清单，由前端二次确认（PRD 规则 15）。
   */
  confirm_unfilled: z.boolean().optional().default(false)
});

/* ============================================================
   数据管理：导出 / 导入 / 备份 / 恢复（Step 5）
   ============================================================ */

/** GET /export/csv —— 明细或汇总（§8.3） */
export const exportCsvQuerySchema = z.object({
  type: z.enum(['items', 'summary']).optional().default('items'),
  /** type=items 时可缺省：缺省取最新一张快照 */
  snapshot_id: z.string().min(1).optional()
});

/**
 * CSV 导入的请求体。
 *
 * **文本而不是 multipart**：把文件内容装进 JSON 传，是为了不破坏
 * `contentTypeGuard`（I-23）—— 那条守卫要求**带请求体的写操作**必须是
 * `application/json`，它是 CSRF 防护链的一环（强制触发 CORS 预检）。
 * 为一个导入端点放宽守卫，等于在防护链上开一个只此一次的例外。
 * 解析仍在服务端做，前端只负责读文件文本。
 *
 * 上限 2MB 文本：足够十万行级的 CSV，同时挡住误选一个大文件把内存打满。
 */
export const importBodySchema = z.object({
  filename: z.string().max(200).optional(),
  content: z.string().min(1, '文件内容为空').max(2 * 1024 * 1024, '文件过大（上限 2MB 文本）')
});

/**
 * POST /restore —— 两种来源二选一（§8.3）：
 *   - `document`：直接给 JSON 备份文档（用户从「从备份文件恢复」上传的内容）
 *   - `backup_name`：服务端 `backups/` 目录里的文件名（只在列表里出现过的名字）
 *
 * 只允许 `backup-YYYY-MM-DD.sqlite` 这一种名字（见 `.regex`）——
 * 否则 `backup_name` 就成了一个任意文件读取入口。
 */
export const restoreBodySchema = z
  .object({
    document: z.unknown().optional(),
    backup_name: z
      .string()
      .regex(/^backup-\d{4}-\d{2}-\d{2}\.sqlite$/, '备份文件名不合法')
      .optional()
  })
  .refine(v => v.document !== undefined || v.backup_name !== undefined, {
    message: '必须提供 document 或 backup_name 之一'
  });
