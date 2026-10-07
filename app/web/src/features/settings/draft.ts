/**
 * draft.ts —— 基础资料表的「草稿」引擎（设置页四组共用：币种 / 平台 / 分类 / 标签）
 *
 * 需求（2026-10-04 第三批 #5）：设置里的元数据原先**边改边写**（blur 即 PATCH、
 * 勾选即 PATCH、删除即 DELETE），用户没有任何「反悔」的机会。改成：
 * 所有变更先进本地草稿，点「保存」才真正写库。
 *
 * ── 一条贯穿全文的设计选择：**脏不靠标记，靠比较** ──
 * 直觉写法是「改一次就记一个 dirty 标记」，但那样会有一个必然后果：保存成功后
 * 服务端的数据变了、而标记还在，界面会短暫出现「已经存好了却还显示未保存」。
 * 这里改成**把草稿值和当前基线行逐字段比较**得出脏计数 —— 保存成功 → 缓存失效
 * → 重新取回新值 → 比较自然相等 → 计数归零。不需要任何「保存后手工清理」的时序。
 *
 * 由此带来一条使用约束：`set()` 必须拿到**当前渲染的这一份基线行**（它会被用来
 * 判断「改回去没有」）。调用方直接把自己渲染用的那个对象传进来即可。
 *
 * ── 三类待提交项 ──
 *   edits   已存在行的字段改动（PATCH）
 *   deletes 待删除的已存在行（DELETE）
 *   adds    待新增的行（POST）—— 它的字段**整行**交给调用方挑（`toCreate`），
 *           因为「新建一个币种」要的字段和「改一个币种」不是同一组。
 *
 * 新增行的 key 是引擎自己发的临时 id（`new-1` 这种），**不是**业务主键：
 * 币种的新增行在用户把代码敲成 `JPY` 之前根本没有 `code`，拿它当 React key
 * 会出现「边打字边换 key」——每敲一个字母整行重挂，输入框立刻失焦。
 */
import { useCallback, useMemo, useState } from 'react';

export type FieldMap = Record<string, unknown>;

export interface PendingAdd<T> {
  /** 引擎发的临时 id；也是 React key */
  key: string;
  /** 该行的初始值（新增表单填的那几个字段） */
  row: T;
}

export interface DraftPlan {
  edits: Array<{ key: string; fields: FieldMap }>;
  deletes: string[];
  /** `fields` 是整行（含初始值 + 用户后续改动），由调用方挑选要提交的字段 */
  adds: Array<{ key: string; fields: FieldMap }>;
}

export interface Draft<T> {
  /** 取草稿后的整行；无改动时原样返回（保证引用稳定） */
  view(row: T): T;
  isDirty(row: T, field?: string): boolean;
  isDeleted(row: T): boolean;
  set(row: T, field: string, value: unknown): void;
  toggleDelete(row: T): void;

  adds: ReadonlyArray<PendingAdd<T>>;
  viewAdd(key: string): T;
  isAddDirty(key: string, field?: string): boolean;
  setAdd(key: string, field: string, value: unknown): void;
  add(row: T): string;
  removeAdd(key: string): void;

  /** 未保存的改动条数（按字段计数；删除与新增各计 1） */
  count(rows: readonly T[]): number;
  /** 待提交清单（只含确实有改动的部分） */
  plan(rows: readonly T[]): DraftPlan;
  reset(): void;
}

/** 字段值只可能是 string / number / boolean / null，用全等即可 */
function same(a: unknown, b: unknown): boolean {
  return a === b;
}

export function useDraft<T extends object>(keyOf: (row: T) => string): Draft<T> {
  const [edits, setEdits] = useState<Record<string, FieldMap>>({});
  const [addEdits, setAddEdits] = useState<Record<string, FieldMap>>({});
  const [deleted, setDeleted] = useState<Record<string, true>>({});
  const [adds, setAdds] = useState<Array<PendingAdd<T>>>([]);
  const [seq, setSeq] = useState(1);

  /**
   * 泛型行 → 字段表。`T extends object` 的裸断言在 TS 下会被判「可能是个笔误」，
   * 故经 `unknown` 转一次 —— 这是本文件唯一的类型妥协，理由是**读字段名是运行期行为**
   * （`diffOf` 要按调用方给的字段名去比对），静态类型在这里帮不上忙。
   */
  const fieldsOf = (row: T): FieldMap => row as unknown as FieldMap;

  /** 逐字段合并草稿；无改动时**返回原对象**（避免下游 memo 依赖被无谓打破） */
  const merge = useCallback((row: T, patch: FieldMap | undefined): T => {
    if (!patch) return row;
    return { ...row, ...patch };
  }, []);

  const view = useCallback((row: T): T => merge(row, edits[keyOf(row)]), [edits, keyOf, merge]);

  const diffOf = useCallback(
    (row: T, patch: FieldMap | undefined): FieldMap => {
      const out: FieldMap = {};
      const src = fieldsOf(row);
      for (const [f, v] of Object.entries(patch ?? {})) {
        if (!same(src[f], v)) out[f] = v;
      }
      return out;
    },
    []
  );

  const isDirty = useCallback(
    (row: T, field?: string): boolean => {
      const d = diffOf(row, edits[keyOf(row)]);
      return field === undefined ? Object.keys(d).length > 0 : Object.prototype.hasOwnProperty.call(d, field);
    },
    [edits, keyOf, diffOf]
  );

  const isDeleted = useCallback((row: T): boolean => deleted[keyOf(row)] === true, [deleted, keyOf]);

  const set = useCallback(
    (row: T, field: string, value: unknown) => {
      const k = keyOf(row);
      setEdits(prev => {
        /* 改回原值 → 撤掉这个字段；一个字段不剩 → 撤掉整行，别留一条空记录 */
        if (same(fieldsOf(row)[field], value)) {
          const cur = prev[k];
          if (!cur) return prev;
          const next = { ...cur };
          delete next[field];
          if (!Object.keys(next).length) {
            const p2 = { ...prev };
            delete p2[k];
            return p2;
          }
          return { ...prev, [k]: next };
        }
        return { ...prev, [k]: { ...(prev[k] ?? {}), [field]: value } };
      });
    },
    [keyOf]
  );

  const toggleDelete = useCallback(
    (row: T) => {
      const k = keyOf(row);
      setDeleted(prev => {
        if (prev[k]) {
          const next = { ...prev };
          delete next[k];
          return next;
        }
        return { ...prev, [k]: true };
      });
    },
    [keyOf]
  );

  const viewAdd = useCallback(
    (key: string): T => {
      const found = adds.find(a => a.key === key);
      return found ? merge(found.row, addEdits[key]) : ({} as T);
    },
    [adds, addEdits, merge]
  );

  const isAddDirty = useCallback(
    (key: string, field?: string): boolean => {
      const found = adds.find(a => a.key === key);
      if (!found) return false;
      const d = diffOf(found.row, addEdits[key]);
      return field === undefined ? Object.keys(d).length > 0 : Object.prototype.hasOwnProperty.call(d, field);
    },
    [adds, addEdits, diffOf]
  );

  const setAdd = useCallback((key: string, field: string, value: unknown) => {
    setAddEdits(prev => ({ ...prev, [key]: { ...(prev[key] ?? {}), [field]: value } }));
  }, []);

  const add = useCallback(
    (row: T): string => {
      const key = `new-${seq}`;
      setSeq(n => n + 1);
      setAdds(prev => [...prev, { key, row }]);
      return key;
    },
    [seq]
  );

  const removeAdd = useCallback((key: string) => {
    setAdds(prev => prev.filter(a => a.key !== key));
    setAddEdits(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const plan = useCallback(
    (rows: readonly T[]): DraftPlan => {
      const pendingEdits: DraftPlan['edits'] = [];
      const pendingDeletes: string[] = [];
      for (const row of rows) {
        const k = keyOf(row);
        /* 已标记删除的行**只报删除**：它马上就不存在了，再补一条 PATCH 会 404，
           也会让「未保存 N 项」把同一行数两遍。 */
        if (deleted[k]) {
          pendingDeletes.push(k);
          continue;
        }
        const d = diffOf(row, edits[k]);
        if (Object.keys(d).length) pendingEdits.push({ key: k, fields: d });
      }
      return {
        edits: pendingEdits,
        deletes: pendingDeletes,
        adds: adds.map(a => ({ key: a.key, fields: viewAdd(a.key) as FieldMap }))
      };
    },
    [adds, deleted, edits, keyOf, diffOf, viewAdd]
  );

  const count = useCallback(
    (rows: readonly T[]): number => {
      const p = plan(rows);
      return (
        p.edits.reduce((s, e) => s + Object.keys(e.fields).length, 0) + p.deletes.length + p.adds.length
      );
    },
    [plan]
  );

  const reset = useCallback(() => {
    setEdits({});
    setAddEdits({});
    setDeleted({});
    setAdds([]);
  }, []);

  return useMemo(
    () => ({
      view,
      isDirty,
      isDeleted,
      set,
      toggleDelete,
      adds,
      viewAdd,
      isAddDirty,
      setAdd,
      add,
      removeAdd,
      count,
      plan,
      reset
    }),
    [
      view, isDirty, isDeleted, set, toggleDelete,
      adds, viewAdd, isAddDirty, setAdd, add, removeAdd,
      count, plan, reset
    ]
  );
}
