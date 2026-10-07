/**
 * TagModal.tsx —— 标签管理弹窗（原型 `openTagModal`）
 *
 * 入口在账户页顶栏的「＋ 标签」。它与设置页的「标签」分页是**两个界面**，
 * 但写的是同一组端点（原型里分别是 openTagModal 与 setTagSettings）：
 * 这里用「输入框 + 改名按钮」逐条确认，设置页那边是失焦即落库。
 * 两处的差异照抄原型，不统一 —— 它们出现在不同的验收截图路径上。
 *
 * 与设置页一致的两点：删除被占用的标签由服务端返回 409（前端不复刻计数逻辑），
 * 以及**新增与删除后关闭弹窗**（原型在这两处都调了 `closeModal()`）。
 */
import { useState } from 'react';
import type { AccountDTO, TagDTO } from '@app/shared';
import { useCatalogWrite } from '../../lib/catalogWrite.ts';
import { Modal } from '../../components/Modal.tsx';
import { useToast } from '../../components/Toast.tsx';

export function TagModal({
  tags,
  accounts,
  onClose
}: {
  tags: readonly TagDTO[];
  accounts: readonly AccountDTO[];
  onClose: () => void;
}) {
  const toast = useToast();
  const { write } = useCatalogWrite();

  /* 每行的输入值。原型是裸 input（点「改名」时才读 DOM），这里受控，
     这样「写失败再把输入框拉回服务端的值」才写得出来。 */
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(tags.map(t => [t.id, t.name]))
  );
  const [newName, setNewName] = useState('');

  const usedOf = (id: string) => accounts.filter(a => a.tags.indexOf(id) >= 0).length;

  async function rename(t: TagDTO): Promise<void> {
    const v = (names[t.id] ?? t.name).trim();
    if (!v) return; // 原型：空值直接忽略，不提示
    if (v === t.name) return;
    const ok = await write('PATCH', `/tags/${t.id}`, { name: v }, '标签已改名');
    if (!ok) setNames(prev => ({ ...prev, [t.id]: t.name }));
  }

  async function remove(t: TagDTO): Promise<void> {
    if (await write('DELETE', `/tags/${t.id}`, undefined, '已删除标签')) onClose();
  }

  async function add(): Promise<void> {
    const n = newName.trim();
    if (!n) {
      toast('请输入标签名', 'err');
      return;
    }
    if (await write('POST', '/tags', { name: n }, `已新增标签：${n}`)) onClose();
  }

  return (
    /* 不传 footer → Modal 渲染默认的「关闭」，与原型 `openModal({title, body})` 一致 */
    <Modal title="标签管理" onClose={onClose}>
      <div>
        {tags.map(t => {
          const used = usedOf(t.id);
          return (
            <div
              key={t.id}
              className="flex between"
              style={{ padding: '7px 0', borderBottom: '2px solid var(--ink)' }}
            >
              <div>
                <b>{t.name}</b>{' '}
                <span className={'badge ' + (used ? 'ok' : 'mute')}>{`${used} 个账户`}</span>
              </div>
              <div className="flex" style={{ gap: 6 }}>
                <input
                  className="inp"
                  style={{ width: 130, padding: '4px 8px' }}
                  value={names[t.id] ?? t.name}
                  onChange={e => setNames(prev => ({ ...prev, [t.id]: e.target.value }))}
                />
                <button className="btn xs" onClick={() => void rename(t)}>
                  改名
                </button>
                <button className="btn xs danger" onClick={() => void remove(t)}>
                  删
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="hr" />

      <div className="flex" style={{ gap: 8 }}>
        <input
          className="inp"
          placeholder="新标签名称"
          value={newName}
          onChange={e => setNewName(e.target.value)}
        />
        <button className="btn pri" onClick={() => void add()}>
          ＋ 新增标签
        </button>
      </div>

      <div className="note info" style={{ marginTop: 12, fontSize: 11.5 }}>
        已被账户使用的标签不可删除，只能停用；历史快照保留标签 ID 与名称快照。
      </div>
    </Modal>
  );
}
