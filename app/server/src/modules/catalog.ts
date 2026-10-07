/**
 * 基础资料与设置模块（技术设计文档 §8.3）
 *
 * 只读端点在 Step 2 落地；**写路径随 Step 4 一并实现**（§8.3 原文如此）。
 * 覆盖：币种 / 平台 / 分类 / 标签四组同构的 CRUD + reorder，
 * 以及汇率批量更新、单项设置更新、变更本位币。
 *
 * 两条贯穿本模块的规则：
 *   1. **被引用就不许删** —— 返回 409 并附带引用计数（PRD 规则 12）。
 *   2. **变更本位币必须整表反算** —— 新汇率 = 旧汇率 × R，且写一条变更历史，
 *      折算链（`@app/domain` 的 `makeFxContext`）靠这条历史工作。
 */
import { Hono } from 'hono';
import {
  baseCurrencyChangeSchema,
  categoryCreateSchema,
  categoryPatchSchema,
  currencyCreateSchema,
  currencyPatchSchema,
  listQuerySchema,
  parseQuery,
  platformCreateSchema,
  platformPatchSchema,
  ratesPutSchema,
  reorderSchema,
  settingsPutSchema,
  tagCreateSchema,
  tagPatchSchema,
  type RatesRefreshRowDTO
} from '@app/shared';
import { Money, ratesFromSource, type FxConversion } from '@app/domain';
import type { AppEnv } from '../middleware.ts';
import type { Db } from '../db/client.ts';
import * as svc from '../services.ts';
import * as w from '../db/writes.ts';
import {
  toBaseHistoryDTO, toCategoryDTO, toCurrencyDTO, toPlatformDTO,
  toSettingsDTO, toTagDTO
} from '../lib/dto.ts';
import { currentVersion } from '../db/migrate.ts';
import { getSettings, listBaseHistoryRows, listCurrencies, listPlatforms, listCategories, listTags } from '../db/repo.ts';
import { fail } from '../lib/errors.ts';
import { fetchSourceRates, type FxFetchOutcome, type FxSource } from '../lib/fx-source.ts';

/** 本位币自身的汇率恒为 1 —— 不参与任何反算，避免浮点误差把它带偏 */
const ONE = 1_000_000;

/** 「删除前的 409」统一出口：把引用计数变成可读信息 */
function guardReferenced(kindLabel: string, name: string, n: number): void {
  if (n > 0) {
    throw fail.conflict(`「${name}」已被 ${n} 个账户引用，无法删除`, {
      kind: kindLabel,
      account_count: n
    });
  }
}

export interface CatalogOptions {
  /**
   * 「获取实时汇率」用的公开源。
   *
   * 缺省 `'off'`（**不是** `'frankfurter'`）：`createApp` 的编程式调用方
   * （`verify:step4:api` 这类脚本）没显式传时，一个「什么都没配」的服务
   * 不应该因为一次点击就去连外网。显式传入才启用 —— 与 `env.ts` 的
   * 「有配置就能用、没配置就明确关掉」相反，因为这里的读者是代码不是用户。
   */
  fxSource?: FxSource;
}

export function createCatalogRoutes(db: Db, opts: CatalogOptions = {}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const fxSource: FxSource = opts.fxSource ?? 'off';

  /* ============================================================
     币种
     ============================================================ */

  r.get('/currencies', c => {
    const q = parseQuery(listQuerySchema, c.req.query());
    return c.json({
      items: svc.currencyService(db, q.includeDisabled).map(toCurrencyDTO)
    });
  });

  r.post('/currencies', async c => {
    const body = currencyCreateSchema.parse(await c.req.json());
    if (w.findCurrency(db, body.code)) {
      throw fail.conflict(`币种 ${body.code} 已存在`, { code: body.code });
    }
    const sort = body.sort ?? w.nextSort(db, 'currency');
    w.tx(db, () => {
      w.insertCurrency(db, {
        code: body.code,
        name: body.name,
        symbol: body.symbol,
        sort,
        enabled: body.enabled
      });
      w.upsertRate(db, body.code, body.rate_to_base ?? ONE);
    });
    const created = listCurrencies(db).find(x => x.code === body.code);
    return c.json(toCurrencyDTO(created!), 201);
  });

  r.patch('/currencies/:code', async c => {
    const code = c.req.param('code');
    const body = currencyPatchSchema.parse(await c.req.json());
    const cur = w.findCurrency(db, code);
    if (!cur) throw fail.notFound(`币种不存在：${code}`);
    /* 本位币不可停用。停用后它就不在「启用中」之列：设置页汇率表会失去基准行，
       汇率非负性与 `rates[base] = 1` 这条不变式也就无从展示。原型 `toggleCurrency`
       同样拒绝（'本位币不可停用'），且它只在前端拦——这里补上服务端那一半。 */
    if (body.enabled === false && svc.queryContext(db).baseCurrency === code) {
      throw fail.rule(`「${cur.name}」是本位币，不能停用；请先变更本位币`);
    }
    w.tx(db, () => {
      const { rate_to_base, ...rest } = body;
      if (Object.keys(rest).length) w.updateCurrency(db, code, rest);
      if (rate_to_base !== undefined) w.upsertRate(db, code, rate_to_base);
    });
    const updated = listCurrencies(db).find(x => x.code === code);
    return c.json(toCurrencyDTO(updated!));
  });

  r.delete('/currencies/:code', c => {
    const code = c.req.param('code');
    const cur = w.findCurrency(db, code);
    if (!cur) throw fail.notFound(`币种不存在：${code}`);
    if (svc.queryContext(db).baseCurrency === code) {
      throw fail.rule(`「${cur.name}」是本位币，不能删除；请先变更本位币`);
    }
    /* 账户与快照明细都要数 —— 只数账户会让「使用中＝是」的币种被删掉（见 utils 注释） */
    const usage = w.currencyRefCount(db, code);
    if (usage.accounts > 0 || usage.snapshot_items > 0) {
      throw fail.conflict(
        `「${cur.name}」已被 ${usage.accounts} 个账户、${usage.snapshot_items} 条快照明细使用，无法删除；只能停用`,
        { kind: 'currency', ...usage }
      );
    }
    w.deleteCurrency(db, code); // exchange_rate 由 ON DELETE CASCADE 一并清理
    return c.json({ deleted: code });
  });

  /* ============================================================
     平台
     ============================================================ */

  r.get('/platforms', c => {
    const q = parseQuery(listQuerySchema, c.req.query());
    return c.json({
      items: svc.platformService(db, q.includeDisabled).map(toPlatformDTO)
    });
  });

  // reorder 必须注册在 :id 之前，否则 "reorder" 会被当成 ID
  r.post('/platforms/reorder', async c => {
    const body = reorderSchema.parse(await c.req.json());
    return c.json({ reordered: w.reorder(db, 'platform', body.ids) });
  });

  r.post('/platforms', async c => {
    const body = platformCreateSchema.parse(await c.req.json());
    const row = {
      id: w.newId('p'),
      name: body.name,
      type: body.type,
      note: body.note,
      sort: body.sort ?? w.nextSort(db, 'platform'),
      enabled: body.enabled
    };
    w.insertPlatform(db, row);
    const created = listPlatforms(db).find(x => x.id === row.id);
    return c.json(toPlatformDTO(created!), 201);
  });

  r.patch('/platforms/:id', async c => {
    const id = c.req.param('id');
    const body = platformPatchSchema.parse(await c.req.json());
    if (!w.findPlatform(db, id)) throw fail.notFound(`平台不存在：${id}`);
    w.updatePlatform(db, id, body);
    const updated = listPlatforms(db).find(x => x.id === id);
    return c.json(toPlatformDTO(updated!));
  });

  r.delete('/platforms/:id', c => {
    const id = c.req.param('id');
    const p = w.findPlatform(db, id);
    if (!p) throw fail.notFound(`平台不存在：${id}`);
    guardReferenced('platform', p.name, w.refCount(db, 'platform', id));
    // account.platform_id 是 ON DELETE SET NULL，但「被引用就不许删」优先
    w.deletePlatform(db, id);
    return c.json({ deleted: id });
  });

  /* ============================================================
     分类
     ============================================================ */

  r.get('/categories', c => {
    const q = parseQuery(listQuerySchema, c.req.query());
    return c.json({
      items: svc.categoryService(db, q.includeDisabled).map(toCategoryDTO)
    });
  });

  r.post('/categories/reorder', async c => {
    const body = reorderSchema.parse(await c.req.json());
    return c.json({ reordered: w.reorder(db, 'category', body.ids) });
  });

  r.post('/categories', async c => {
    const body = categoryCreateSchema.parse(await c.req.json());
    const row = {
      id: w.newId('c'),
      name: body.name,
      type: body.type,
      default_track_principal: body.default_track_principal,
      sort: body.sort ?? w.nextSort(db, 'category'),
      enabled: body.enabled
    };
    w.insertCategory(db, row);
    const created = listCategories(db).find(x => x.id === row.id);
    return c.json(toCategoryDTO(created!), 201);
  });

  r.patch('/categories/:id', async c => {
    const id = c.req.param('id');
    const body = categoryPatchSchema.parse(await c.req.json());
    const cur = w.findCategory(db, id);
    if (!cur) throw fail.notFound(`分类不存在：${id}`);

    // 资产 → 负债会留下「负债账户却在跟踪本金」的非法组合（表上有 CHECK 约束）
    if (body.type === 'liability' && cur.type === 'asset') {
      const n = w.refCount(db, 'category', id);
      if (n > 0) {
        throw fail.rule(
          `「${cur.name}」下已有 ${n} 个账户，不能改成负债类型；请先迁移这些账户`
        );
      }
    }
    w.updateCategory(db, id, body);
    const updated = listCategories(db).find(x => x.id === id);
    return c.json(toCategoryDTO(updated!));
  });

  r.delete('/categories/:id', c => {
    const id = c.req.param('id');
    const cat = w.findCategory(db, id);
    if (!cat) throw fail.notFound(`分类不存在：${id}`);
    guardReferenced('category', cat.name, w.refCount(db, 'category', id));
    w.deleteCategory(db, id);
    return c.json({ deleted: id });
  });

  /* ============================================================
     标签
     ============================================================ */

  r.get('/tags', c => {
    const q = parseQuery(listQuerySchema, c.req.query());
    return c.json({
      items: svc.tagService(db, q.includeDisabled).map(toTagDTO)
    });
  });

  r.post('/tags/reorder', async c => {
    const body = reorderSchema.parse(await c.req.json());
    return c.json({ reordered: w.reorder(db, 'tag', body.ids) });
  });

  r.post('/tags', async c => {
    const body = tagCreateSchema.parse(await c.req.json());
    const row = {
      id: w.newId('t'),
      name: body.name,
      sort: body.sort ?? w.nextSort(db, 'tag'),
      enabled: body.enabled
    };
    w.insertTag(db, row);
    const created = listTags(db).find(x => x.id === row.id);
    return c.json(toTagDTO(created!), 201);
  });

  r.patch('/tags/:id', async c => {
    const id = c.req.param('id');
    const body = tagPatchSchema.parse(await c.req.json());
    if (!w.findTag(db, id)) throw fail.notFound(`标签不存在：${id}`);
    w.updateTag(db, id, body);
    const updated = listTags(db).find(x => x.id === id);
    return c.json(toTagDTO(updated!));
  });

  r.delete('/tags/:id', c => {
    const id = c.req.param('id');
    const tag = w.findTag(db, id);
    if (!tag) throw fail.notFound(`标签不存在：${id}`);
    // 标签被账户引用时 account_tag 有 CASCADE，但按规则 12 同样不许删
    guardReferenced('tag', tag.name, w.refCount(db, 'tag', id));
    w.deleteTag(db, id);
    return c.json({ deleted: id });
  });

  /* ============================================================
     设置
     ============================================================ */

  r.get('/settings', c => {
    const settings = getSettings(db);
    return c.json(toSettingsDTO(settings, currentVersion(db.raw)));
  });

  /** 更新单项设置。`base_currency` 与 `schema_version` 不走这里（见下）。 */
  r.put('/settings', async c => {
    const body = settingsPutSchema.parse(await c.req.json());
    if (body.key === 'base_currency') {
      throw fail.rule('变更本位币必须走 POST /settings/base-currency（需同时提供换算比价并记录变更历史）');
    }
    if (body.key === 'schema_version') {
      throw fail.rule('schema_version 由迁移管理，不允许通过接口修改');
    }
    /* 机制性键必须挡在这里。`PUT /settings` 是任意键写入的入口，而这两个键不是「用户偏好」：
         · data_mode   —— 决定 `POST /go-live`（清空账本）的门禁是否放行。
                          能被接口随意改成 'demo'，门禁就形同虚设。
         · initialized_at —— 判据换代后的初始化标记，被改写会影响「是否种子化」。 */
    if (body.key === 'data_mode') {
      throw fail.rule('data_mode 由种子化 / 重置 / 恢复决定，不允许通过接口修改');
    }
    if (body.key === 'initialized_at') {
      throw fail.rule('initialized_at 是初始化标记，不允许通过接口修改');
    }
    w.upsertSetting(db, body.key, body.value);
    return c.json(toSettingsDTO(getSettings(db), currentVersion(db.raw)));
  });

  /**
   * 变更本位币（单事务）。
   *
   * body: `{ to, conversion_rate, rates? }`，语义是 **1 旧本位币 = conversion_rate 新本位币**。
   *
   * 新汇率表 = 整表反算（`新汇率(X→to) = 旧汇率(X→from) × R`）**再叠加**前端送来的
   * 手工修正；新本位币自身的汇率强制写 1 —— 反算理论上也得到 1，但让浮点去决定
   * 「1 是不是 1」没有意义，这类恒等值一律直接赋值。详见下面两处注释。
   */
  r.post('/settings/base-currency', async c => {
    const body = baseCurrencyChangeSchema.parse(await c.req.json());
    const from = svc.queryContext(db).baseCurrency;
    if (body.to === from) {
      throw fail.rule(`当前本位币已经是 ${from}`);
    }
    if (!w.findCurrency(db, body.to)) throw fail.notFound(`币种不存在：${body.to}`);

    const ratio = body.conversion_rate / 1_000_000;
    const before = listCurrencies(db).filter(x => x.rate_to_base_micro !== null);
    const preview: Record<string, number> = {};

    /* 先整表反算：`新汇率(X→to) = 旧汇率(X→from) × R`。
       推导：X = r_from × from，且 from = R × to，故 X = (r_from × R) × to。 */
    for (const cur of before) {
      const next =
        cur.code === body.to
          ? ONE
          : Number(
              Money.fromMicro(BigInt(cur.rate_to_base_micro!)).mulByRatio(ratio).toMicro()
            );
      preview[cur.code] = next;
    }

    /**
     * 再用前端送来的那一列**覆盖** —— 界面写着「可逐条修正后再保存」（原型 `nbApply`
     * 存的也确实是表里那一列，而不是反算结果），那些修正必须以它为准。
     *
     * 为什么要「先反算再覆盖」而不是「送来什么就是什么」：预览表只列**启用中**的币种，
     * 若整表以它为准则，停用但仍有汇率的币种会带着**旧本位币口径**留在表里，
     * 变成一张两种口径混着的表。覆盖式写入让两者都不会发生。
     */
    if (body.rates) {
      const known = new Set(before.map(x => x.code));
      const unknown = Object.keys(body.rates).filter(code => !known.has(code));
      if (unknown.length) {
        throw fail.validation(`汇率表里出现了不存在的币种：${unknown.join('、')}`, { unknown });
      }
      const bad = Object.entries(body.rates).filter(([, rate]) => rate <= 0);
      if (bad.length) {
        throw fail.validation(`汇率必须为正数：${bad.map(([c]) => c).join('、')}`, {
          invalid: bad.map(([c]) => c)
        });
      }
      for (const [code, rate] of Object.entries(body.rates)) preview[code] = rate;
    }
    /* 新本位币自身的汇率强制写 1 —— 反算理论上也得到 1，但让浮点去决定
       「1 是不是 1」没有意义，这类恒等值一律直接赋值（覆盖之后再压一次，防手改） */
    preview[body.to] = ONE;

    const changedAt = w.nowIso();
    const historyId = w.tx(db, () => {
      for (const [code, rate] of Object.entries(preview)) {
        w.upsertRate(db, code, rate, changedAt);
      }
      w.upsertSetting(db, 'base_currency', body.to);
      return w.insertBaseHistory(db, {
        from_currency: from,
        to_currency: body.to,
        conversion_rate: ratio,
        changed_at: changedAt
      });
    });

    const after = listCurrencies(db);
    return c.json({
      history_id: historyId,
      from,
      to: body.to,
      conversion_rate: body.conversion_rate,
      recalculated: Object.keys(preview).length,
      // preview 与原表同构，便于前端核对「哪些汇率被改成了什么」
      preview: after.map(x => ({ code: x.code, rate_to_base: x.rate_to_base_micro ?? 0 }))
    });
  });

  /* ============================================================
     汇率
     ============================================================ */

  /** 当前默认汇率表（本位币自身为 1） */
  r.get('/rates', c => {
    const items = svc.currencyService(db, true).map(toCurrencyDTO);
    return c.json({
      base_currency: svc.queryContext(db).baseCurrency,
      rates: Object.fromEntries(items.map(i => [i.code, i.rate_to_base]))
    });
  });

  /** 批量更新汇率（微元整数入参，单事务） */
  r.put('/rates', async c => {
    const body = ratesPutSchema.parse(await c.req.json());
    const base = svc.queryContext(db).baseCurrency;
    for (const code of Object.keys(body.rates)) {
      if (!w.findCurrency(db, code)) throw fail.notFound(`币种不存在：${code}`);
      if (code === base && body.rates[code] !== ONE) {
        throw fail.rule(`本位币 ${base} 的汇率必须是 1，不能修改`);
      }
    }
    const n = w.putRates(db, body.rates);
    const items = svc.currencyService(db, true).map(toCurrencyDTO);
    return c.json({
      updated: n,
      base_currency: base,
      rates: Object.fromEntries(items.map(i => [i.code, i.rate_to_base]))
    });
  });

  /** 本位币变更历史 —— 折算链的原料，前端用它标注「参考值」区间 */
  r.get('/base-currency-history', c => {
    return c.json({ items: listBaseHistoryRows(db).map(toBaseHistoryDTO) });
  });

  /**
   * 从**公开源手动**刷新默认汇率表（第三批 #1 / #2，PRD §14 已同步为「支持手动刷新」）。
   *
   * 手动是需求原文，所以这里没有定时器、启动时也不请求：一次点击 = 一次取数 = 一次落库。
   *
   * ── 四条刻意的约束 ──
   *
   * 1. **只写默认汇率表**（`w.putRates` 那一条路径），**绝不回写历史快照**：
   *    快照的冻结汇率不可变（口径约定 3）。这里连快照表都不碰。
   *
   * 2. **失败不写库**。`fetchSourceRates` 只 throw、不产出「部分/空」的结果，这里据此
   *    直接返回错误并**保持原表**。绝不能出现「取到一半、剩下的被清成 0」的表 ——
   *    汇率 0 会让盘点的缺汇率门禁把整张快照拦下来，用户看到的是「盘点做不下去了」，
   *    而真因只是外部 API 抖了一下（`lib/fx-source.ts` 第 3 条硬约束）。
   *    错误码用 500：这不是「用户违规」（422），也不该被当成「请求写错了」（400）——
   *    是**我们**没能完成这次操作，而文案已经说明了「未做任何修改，可重试」。
   *
   * 3. **值没变就不写**。写一个同样的值只会把 `rate_updated_at` 刷新成现在，
   *    让界面把「已是最新」显示成「刚更新过」。因此 `updated` 计的是**真改动数**。
   *
   * 4. **只覆盖库内已有的币种**。源通常多给几十个（泰铢、兰特…），把库外的写进
   *    汇率表等于凭空多出一批「使用中=否」的币种 —— 这层过滤在
   *    `ratesFromSource(table, base, codes)` 的第三个参数上。
   *
   * 值的**方向**不在这里：源给「1 基准币 = R 目标币」，本系统要「1 原币 = X 本位币」，
   * 取倒数在 `@app/domain` 的纯函数里做（那里有独立的断言，含乘法反证）。
   * 本函数只编排「取数 → 换算 → 落库 → 回读」。
   */
  r.post('/rates/refresh', async c => {
    if (fxSource === 'off') {
      throw fail.rule(
        '未启用公开汇率源（FX_SOURCE=off）。如需使用，请在 .env 中把它设为 frankfurter 或 er-api 后重启'
      );
    }
    const base = svc.queryContext(db).baseCurrency;
    const beforeItems = svc.currencyService(db, true).map(toCurrencyDTO);

    let outcome: FxFetchOutcome;
    try {
      outcome = await fetchSourceRates(fxSource, base);
    } catch (err) {
      throw fail.internal(`${(err as Error).message}；汇率表未做任何修改，可稍后重试`, {
        source: fxSource
      });
    }

    let conv: FxConversion;
    try {
      conv = ratesFromSource(outcome.table, base, beforeItems.map(x => x.code));
    } catch (err) {
      throw fail.internal(`${(err as Error).message}；汇率表未做任何修改`);
    }

    const beforeOf = new Map(beforeItems.map(x => [x.code, x.rate_to_base]));
    const nameOf = new Map(beforeItems.map(x => [x.code, x.name]));
    const changed: Record<string, number> = {};
    const rows: RatesRefreshRowDTO[] = [];
    for (const row of conv.rows) {
      // 本位币自身恒为 1，必定「没变」，也不该出现在改动清单里
      if (row.code === base) continue;
      const before = beforeOf.get(row.code) ?? 0;
      if (before === row.micro) continue;
      changed[row.code] = row.micro;
      rows.push({
        code: row.code,
        name: nameOf.get(row.code) ?? '',
        before,
        after: row.micro,
        source_rate: row.sourceRate
      });
    }

    if (rows.length) w.putRates(db, changed);

    const after = svc.currencyService(db, true).map(toCurrencyDTO);
    return c.json({
      base_currency: base,
      source: outcome.source,
      source_label: outcome.label,
      fetched_at: w.nowIso(),
      updated: rows.length,
      skipped: conv.skipped,
      rows,
      rates: Object.fromEntries(after.map(i => [i.code, i.rate_to_base]))
    });
  });

  return r;
}
