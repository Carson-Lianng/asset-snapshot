/**
 * AccountModal.tsx —— 账户新增 / 编辑弹窗（原型 `openAccountModal`）
 *
 * 为什么挂在 Shell（App）而不是账户页：触发它的两个入口不在同一棵子树上 ——
 * 顶栏的「＋ 新增账户」由 App 渲染，行内的「编辑」在账户页里。把状态抬到共同祖先，
 * 弹窗本体只认「当前在编辑哪个账户」（`null` = 新建），与原型那个全局函数同义。
 *
 * 三处必须与原型对齐的规则：
 *   1. **分类决定类型** —— `type` 不给用户选，取所选分类的 `type`（PRD §3.1.2）；
 *      切换分类时若变成负债，「跟踪本金」必须一并关掉。
 *   2. **新建时跟踪本金取分类默认值**（PRD §3.1.5）；编辑时**不覆盖**用户既有选择
 *      —— 原型只在 `isNew` 分支动它，这里是同样的条件。
 *   3. **负债账户的「跟踪本金」置灰不可点**，并给出说明性红条。服务端也会拦（422），
 *      界面先拦是为了不必提交就知道为什么。
 *
 * 表单初值里 `track` 一律为 `false`（新建时），即使所选分类的默认值是 true —— 原型
 * 的默认值只在**分类变更**时生效，首次打开不动。这一条看着像疏忽，但它决定了
 * 「打开弹窗直接点创建」的结果，因此照抄。
 */
import { useState } from 'react';
import type { AccountDTO, CategoryDTO, CurrencyDTO, PlatformDTO, TagDTO } from '@app/shared';
import { mutate, writable } from '../../api/index.ts';
import { messageOf } from '../../api/problem.ts';
import { getBaseCurrency } from '../../lib/money.ts';
import { Modal } from '../../components/Modal.tsx';
import { useToast } from '../../components/Toast.tsx';

/** 表单一律以字符串持有下拉值：`''` 是「未指定平台」这个选项的取值，不是「空」 */
interface Form {
  name: string;
  platform_id: string;
  category_id: string;
  currency: string;
  note: string;
  include: boolean;
  track: boolean;
  tags: string[];
}

/** 新建时的默认分类（原型写死的 `'c-deposit'`，种子里是「存款」） */
const DEFAULT_NEW_CATEGORY = 'c-deposit';

function initialForm(
  account: AccountDTO | null,
  platforms: readonly PlatformDTO[],
  categories: readonly CategoryDTO[]
): Form {
  if (account) {
    return {
      name: account.name,
      platform_id: account.platform_id ?? '',
      category_id: account.category_id,
      currency: account.currency,
      note: account.note,
      include: account.include_in_net_worth,
      track: account.track_principal,
      tags: [...account.tags]
    };
  }
  /* 新建：平台取列表第一个（原型 `DB.platforms[0]`）。
     分类取种子的「存款」，与原型写死的 `'c-deposit'` 一致；**但若该分类不在库里
     就退回第一个** —— 原型在这一点上会把表单停在一个选不出来、提交必然 404 的值上，
     属于既有缺陷，不照抄。 */
  const preferred = categories.find(c => c.id === DEFAULT_NEW_CATEGORY)?.id;
  return {
    name: '',
    platform_id: platforms[0]?.id ?? '',
    category_id: preferred ?? categories[0]?.id ?? '',
    currency: getBaseCurrency(),
    note: '',
    include: true,
    track: false,
    tags: []
  };
}

export function AccountModal({
  accountId,
  accounts,
  platforms,
  categories,
  tags,
  currencies,
  onClose
}: {
  /** `null` = 新建；否则是待编辑账户的 ID */
  accountId: string | null;
  accounts: readonly AccountDTO[];
  platforms: readonly PlatformDTO[];
  categories: readonly CategoryDTO[];
  tags: readonly TagDTO[];
  currencies: readonly CurrencyDTO[];
  onClose: () => void;
}) {
  const toast = useToast();

  /* 找不到就退回「新建」：原型 `const isNew = !a` 就是这个语义。
     正常路径不会走到（入口只出现在已渲染的行上），但不留崩溃点。 */
  const account = accountId ? accounts.find(a => a.id === accountId) ?? null : null;
  const isNew = account === null;

  const [form, setForm] = useState<Form>(() => initialForm(account, platforms, categories));
  const [busy, setBusy] = useState(false);

  const cat = categories.find(c => c.id === form.category_id) ?? null;
  const isLiab = cat?.type === 'liability';

  /* 分类切换：先落值，再按规则决定「跟踪本金」的新值（原型 `$('#acCat')` 的 change 处理） */
  function onCategoryChange(nextId: string): void {
    const next = categories.find(c => c.id === nextId) ?? null;
    setForm(f => {
      let track = f.track;
      if (next?.type === 'liability') track = false;
      else if (isNew) track = !!next?.default_track_principal;
      return { ...f, category_id: nextId, track };
    });
  }

  async function save(): Promise<void> {
    if (busy) return;

    if (!form.name.trim()) {
      toast('请填写账户名称', 'err');
      return;
    }
    if (!cat) {
      toast('请选择分类', 'err');
      return;
    }
    if (cat.type === 'liability' && form.track) {
      toast('负债账户不可开启本金跟踪', 'err');
      return;
    }
    if (!writable()) {
      toast('当前是离线数据源（?data=fixture），保存不可用', 'warn', 4200);
      return;
    }

    const payload = {
      name: form.name.trim(),
      platform_id: form.platform_id || null,
      category_id: form.category_id,
      type: cat.type,
      currency: form.currency,
      tags: [...form.tags],
      note: form.note,
      include_in_net_worth: form.include,
      /* 与原型同一表达式：负债账户即便传了 true 也会被压成 false */
      track_principal: form.track && cat.type === 'asset'
    };

    setBusy(true);
    try {
      if (account) {
        await mutate(ds => ds.send<AccountDTO>('PATCH', `/accounts/${account.id}`, payload));
        toast(`已保存：${form.name}`, 'ok');
      } else {
        await mutate(ds => ds.send<AccountDTO>('POST', '/accounts', payload));
        toast(`已创建账户：${form.name}`, 'ok');
      }
      onClose();
    } catch (err) {
      toast(`保存失败：${messageOf(err)}`, 'err', 4200);
    } finally {
      setBusy(false);
    }
  }

  /* 币种下拉：启用中的全部 + 当前值本身（原型 `c.enabled || c.code === sel.currency`）。
     后者是为了「账户在用但该币种已被停用」时不把当前值从下拉里抹掉。 */
  const currencyOptions = currencies.filter(c => c.enabled || c.code === form.currency);
  const tagOptions = tags.filter(t => t.enabled);

  return (
    <Modal
      title={isNew ? '新增账户' : `编辑账户 · ${account.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn ink" onClick={() => void save()}>
            {isNew ? '创建账户' : '保存'}
          </button>
        </>
      }
    >
      <div className="grid2">
        <div className="field">
          <label>账户名称 *</label>
          <input
            className="inp"
            value={form.name}
            placeholder="如：美元储蓄"
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>所属平台</label>
          <select
            className="inp"
            value={form.platform_id}
            onChange={e => setForm(f => ({ ...f, platform_id: e.target.value }))}
          >
            <option value="">未指定平台</option>
            {platforms.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="field">
          <label>分类 *（决定资产/负债类型）</label>
          <select className="inp" value={form.category_id} onChange={e => onCategoryChange(e.target.value)}>
            {categories.map(c => (
              <option key={c.id} value={c.id}>
                {`${c.type === 'asset' ? '资产' : '负债'} · ${c.name}`}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>币种 *</label>
          <select
            className="inp"
            value={form.currency}
            onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
          >
            {currencyOptions.map(c => (
              <option key={c.code} value={c.code}>
                {`${c.code} · ${c.name}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>标签（可多选）</label>
        <div className="chips">
          {tagOptions.map(t => (
            <button
              type="button"
              key={t.id}
              className={'chip ' + (form.tags.includes(t.id) ? 'on' : '')}
              onClick={() =>
                setForm(f => ({
                  ...f,
                  tags: f.tags.includes(t.id) ? f.tags.filter(x => x !== t.id) : [...f.tags, t.id]
                }))
              }
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>备注</label>
        <textarea
          className="inp"
          value={form.note}
          placeholder="可选"
          onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
        />
      </div>

      <div className="hr" />

      <div className="flex wrap" style={{ gap: 18 }}>
        <label className="chk">
          <input
            type="checkbox"
            checked={form.include}
            onChange={e => setForm(f => ({ ...f, include: e.target.checked }))}
          />
          计入净值<span className="muted tiny">（代持/委托资金可关闭）</span>
        </label>
        <label className="chk" style={isLiab ? { opacity: 0.4 } : undefined}>
          <input
            type="checkbox"
            checked={form.track && !isLiab}
            disabled={isLiab}
            onChange={e => setForm(f => ({ ...f, track: e.target.checked }))}
          />
          跟踪本金<span className="muted tiny">（仅资产账户，用于收益统计）</span>
        </label>
      </div>

      {isLiab ? (
        <div className="note err" style={{ marginTop: 12, fontSize: 11.5 }}>
          负债账户不可开启本金跟踪（PRD 规则：仅资产账户开放）。
        </div>
      ) : null}

      {isNew ? (
        <div className="note info" style={{ marginTop: 12, fontSize: 11.5 }}>
          新建账户后需在盘点页首次填写金额；在此之前账户列表显示「未盘点」。
        </div>
      ) : null}
    </Modal>
  );
}
