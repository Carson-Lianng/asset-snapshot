/**
 * Modal.tsx —— 弹窗（原型 openModal / confirmModal）
 *
 * DOM 与原型逐层一致：`#modalRoot > .mask > .modal > (.modal-hd + .modal-bd + .modal-ft)`。
 * 用 portal 挂到 `#modalRoot`（App.tsx 里那个占位 div）而不是留在组件树内，
 * 与原型 `$('#modalRoot').appendChild(wrap)` 同义 —— 遮罩要盖住整个视口，
 * 而不是被 `overflow` 裁在某个卡片里。
 *
 * 关闭路径有三条，与原型一致：点遮罩、点 `×`、按 Esc。第三条是原型没有的，
 * 但键盘用户没有别的出口，补上不算偏差。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Modal({
  title,
  children,
  footer,
  wide = false,
  onClose
}: {
  title: ReactNode;
  children: ReactNode;
  /** `undefined` → 渲染默认的「关闭」；`null` → 不渲染页脚（原型 `footer: null`） */
  footer?: ReactNode;
  wide?: boolean;
  onClose: () => void;
}) {
  /* 挂载点只查一次：`#modalRoot` 由 App 在首次渲染时就在 DOM 里了 */
  const [host] = useState(() => document.getElementById('modalRoot'));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!host) return null;

  return createPortal(
    <div
      className="mask"
      onClick={e => {
        /* 只有点在遮罩本身上才关；点在弹窗内部冒泡上来的不算 */
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true">
        <div className="modal-hd">
          <h3>{title}</h3>
          <button className="x-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-bd">{children}</div>
        {footer === null ? null : (
          <div className="modal-ft">
            {footer ?? (
              <button className="btn" onClick={onClose}>
                关闭
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    host
  );
}

/**
 * 二次确认弹窗（原型 `confirmModal(title, msg, onOk, okText)`）。
 *
 * 破坏性操作的唯一出口：`onOk` 在弹窗关闭**之后**才调用，
 * 避免「回调里又去 setState 关弹窗」这种顺序问题。
 */
export function ConfirmModal({
  title,
  body,
  okText = '确定',
  onOk,
  onClose
}: {
  title: ReactNode;
  body: ReactNode;
  okText?: string;
  onOk: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn ink"
            onClick={() => {
              onClose();
              onOk();
            }}
          >
            {okText}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.75 }}>{body}</div>
    </Modal>
  );
}
