/**
 * Toast.tsx —— 轻提示
 *
 * DOM 结构与动画与原型一致：`.toasts > .toast.<type>`，图标为 mono 加粗字符，
 * 到点后先淡出位移再移除。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastType = 'ok' | 'warn' | 'err' | 'info' | '';

interface ToastItem {
  id: number;
  msg: ReactNode;
  type: ToastType;
  leaving: boolean;
}

const ICONS: Record<string, string> = { ok: '✓', warn: '!', err: '×', info: 'i' };

type Push = (msg: ReactNode, type?: ToastType, ms?: number) => void;

const ToastContext = createContext<Push>(() => {});

export function useToast(): Push {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback<Push>((msg, type = 'info', ms = 2600) => {
    const id = ++seq.current;
    setItems(list => [...list, { id, msg, type, leaving: false }]);
    window.setTimeout(() => {
      setItems(list => list.map(t => (t.id === id ? { ...t, leaving: true } : t)));
      window.setTimeout(() => setItems(list => list.filter(t => t.id !== id)), 220);
    }, ms);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" id="toasts">
        {items.map(t => (
          <div
            key={t.id}
            className={'toast ' + t.type}
            style={
              t.leaving
                ? { transition: 'opacity .2s,transform .2s', opacity: 0, transform: 'translateX(20px)' }
                : undefined
            }
          >
            <b className="mono" style={{ fontSize: 13 }}>
              {ICONS[t.type] ?? 'i'}
            </b>
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
