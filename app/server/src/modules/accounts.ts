/**
 * 账户模块（技术设计文档 §8.3）
 *
 * 只读端点在 Step 2 落地；**写路径随 Step 4 落地**。
 *
 * 两个必须在此处收口的业务规则：
 *   · `track_principal` 缺省时取所属分类的 `default_track_principal`（PRD §3.1.5）；
 *   · **只有资产账户能跟踪本金** —— 负债 + 跟踪本金是非法组合，表上也有 CHECK 约束，
 *     但在这一层先拦下来，错误信息才可读。
 *
 * 删除账户**不影响历史快照**：`snapshot_item.account_id` 刻意没有外键（PRD 规则 6），
 * 明细靠冗余字段自洽，所以这里可以直接删。
 */
import { Hono } from 'hono';
import {
  accountCreateSchema,
  accountListQuerySchema,
  accountPatchSchema,
  parseQuery,
  reorderSchema
} from '@app/shared';
import type { AppEnv } from '../middleware.ts';
import type { Db } from '../db/client.ts';
import * as w from '../db/writes.ts';
import { toAccountDTO } from '../lib/dto.ts';
import { listAccounts } from '../db/repo.ts';
import { fail } from '../lib/errors.ts';

/**
 * 引用的基础资料必须存在 —— 让错误信息指向具体字段，而不是一句 SQL 外键报错。
 *
 * 这里有**四种**引用：平台 / 分类 / 币种 / 标签。前三种一开始就查了，
 * 标签漏了整整一个 Step（见 I-41）—— 后果不是「少一条校验」，而是把
 * 「传错的标签 id」直接放进 `account_tag`，冒成 500「服务内部错误」：
 * 调用方拿不到「哪个标签不存在」，服务端也多了一条只有 ID 的 unhandled_error。
 * 而且 `accountPatchSchema.tags` 只是一个字符串数组，schema 层拦不住「存不存在」。
 */
function assertRefs(
  db: Db,
  refs: {
    platform_id?: string | null;
    category_id?: string;
    currency?: string;
    tags?: readonly string[];
  }
): void {
  if (refs.platform_id && !w.findPlatform(db, refs.platform_id)) {
    throw fail.notFound(`平台不存在：${refs.platform_id}`);
  }
  if (refs.category_id && !w.findCategory(db, refs.category_id)) {
    throw fail.notFound(`分类不存在：${refs.category_id}`);
  }
  if (refs.currency && !w.findCurrency(db, refs.currency)) {
    throw fail.notFound(`币种不存在：${refs.currency}`);
  }
  for (const tagId of refs.tags ?? []) {
    if (!w.findTag(db, tagId)) throw fail.notFound(`标签不存在：${tagId}`);
  }
}

export function createAccountRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/accounts', c => {
    const q = parseQuery(accountListQuerySchema, c.req.query());
    const rows = listAccounts(db, {
      platform_id: q.platform_id,
      category_id: q.category_id,
      tag_id: q.tag_id,
      archived: q.archived,
      q: q.q
    });
    const items = rows.map(toAccountDTO);
    return c.json({ items, total: items.length });
  });

  // reorder 注册在 :id 之前，避免 "reorder" 被当成账户 ID
  r.post('/accounts/reorder', async c => {
    const body = reorderSchema.parse(await c.req.json());
    return c.json({ reordered: w.reorder(db, 'account', body.ids) });
  });

  r.post('/accounts', async c => {
    const body = accountCreateSchema.parse(await c.req.json());
    assertRefs(db, body);

    const category = w.findCategory(db, body.category_id)!;
    // 缺省：按所属分类的默认值（PRD §3.1.5）
    const track = body.track_principal ?? category.default_track_principal;
    if (track && body.type === 'liability') {
      throw fail.rule('只有资产账户可以跟踪本金', { field: 'track_principal' });
    }

    const now = w.nowIso();
    const id = w.newId('acc');
    w.insertAccount(
      db,
      {
        id,
        name: body.name,
        platform_id: body.platform_id,
        category_id: body.category_id,
        type: body.type,
        currency: body.currency,
        note: body.note,
        include_in_net_worth: body.include_in_net_worth,
        track_principal: track,
        sort: body.sort ?? w.nextSort(db, 'account'),
        archived: body.archived,
        created_at: now,
        updated_at: now
      },
      body.tags
    );

    const created = listAccounts(db).find(a => a.id === id);
    return c.json(toAccountDTO(created!), 201);
  });

  r.patch('/accounts/:id', async c => {
    const id = c.req.param('id');
    const body = accountPatchSchema.parse(await c.req.json());
    const cur = listAccounts(db).find(a => a.id === id);
    if (!cur) throw fail.notFound(`账户不存在：${id}`);
    assertRefs(db, body);

    /* 变更后的组合必须合法：把「本次改动」与「当前值」合并后再判一次 */
    const nextType = body.type ?? cur.type;
    const nextTrack = body.track_principal ?? cur.track_principal;
    if (nextTrack && nextType === 'liability') {
      throw fail.rule('只有资产账户可以跟踪本金；请先关闭「跟踪本金」再改为负债账户', {
        field: 'track_principal'
      });
    }

    w.tx(db, () => {
      const { tags, ...patch } = body;
      if (Object.keys(patch).length) w.updateAccount(db, id, { ...patch, updated_at: w.nowIso() });
      if (tags) w.replaceAccountTags(db, id, tags);
    });

    const updated = listAccounts(db).find(a => a.id === id);
    return c.json(toAccountDTO(updated!));
  });

  r.delete('/accounts/:id', c => {
    const id = c.req.param('id');
    const cur = listAccounts(db).find(a => a.id === id);
    if (!cur) throw fail.notFound(`账户不存在：${id}`);
    // 历史明细不会被删除，这里只是把「有多少历史」如实告诉调用方
    const items = w.accountItemCount(db, id);
    w.deleteAccount(db, id);
    return c.json({ deleted: id, snapshot_items_kept: items });
  });

  return r;
}
