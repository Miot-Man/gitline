import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

export type MenuItem =
  | { label: string; onClick?: () => void; danger?: boolean; disabled?: boolean; hint?: string; icon?: ReactNode }
  | 'sep';

interface PromptOpts {
  title: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  multiline?: boolean;
}

interface ConfirmOpts {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
}

type ToastKind = 'error' | 'info' | 'success';

// Where a menu opens. A dropdown passes the button it hangs from as `anchor` (a click event's
// currentTarget counts too): the menu opens under it, and clicking that button again closes it.
interface MenuEvent {
  clientX: number;
  clientY: number;
  preventDefault?: () => void;
  type?: string;
  currentTarget?: EventTarget | null;
  anchor?: Element | null;
}

interface UI {
  toast(msg: string, kind?: ToastKind): void;
  prompt(o: PromptOpts): Promise<string | null>;
  confirm(o: ConfirmOpts): Promise<boolean>;
  menu(e: MenuEvent, items: MenuItem[]): void;
}

const Ctx = createContext<UI>(null as unknown as UI);
export const useUI = () => useContext(Ctx);

type Modal =
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOpts)
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & ConfirmOpts);

interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<Modal | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; anchor: Element | null } | null>(null);
  const nextId = useRef(1);
  // The dropdown button whose menu was just closed by pressing on it, so the click that follows doesn't reopen it.
  const closedBy = useRef<{ anchor: Element; at: number } | null>(null);

  const toast = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 3500);
  }, []);

  const prompt = useCallback(
    (o: PromptOpts) => new Promise<string | null>((resolve) => setModal({ kind: 'prompt', resolve, ...o })),
    []
  );
  const confirm = useCallback(
    (o: ConfirmOpts) => new Promise<boolean>((resolve) => setModal({ kind: 'confirm', resolve, ...o })),
    []
  );
  const openMenu = useCallback<UI['menu']>((e, items) => {
    e.preventDefault?.();
    const anchor = e.anchor ?? (e.type === 'click' && e.currentTarget instanceof Element ? e.currentTarget : null);
    const recent = closedBy.current;
    closedBy.current = null;
    if (anchor && recent && recent.anchor === anchor && Date.now() - recent.at < 1000) return;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      setMenu({ x: r.left, y: r.bottom + 2, items, anchor });
    } else setMenu({ x: e.clientX, y: e.clientY, items, anchor: null });
  }, []);

  const closeMenu = useCallback((target?: EventTarget | null) => {
    setMenu((m) => {
      if (m?.anchor && target instanceof Node && m.anchor.contains(target)) closedBy.current = { anchor: m.anchor, at: Date.now() };
      return null;
    });
  }, []);

  const [ui] = useState<UI>(() => ({ toast, prompt, confirm, menu: openMenu }));

  return (
    <Ctx.Provider value={ui}>
      {children}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {modal && <ModalView modal={modal} onClose={() => setModal(null)} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === 'error' ? <AlertTriangle size={16} /> : t.kind === 'success' ? <CheckCircle2 size={16} /> : <Info size={16} />}
            <pre>{t.msg}</pre>
            <button className="icon-btn" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: (target?: EventTarget | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 6)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (e?: Event) => closeRef.current(e?.target);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key);
    };
  }, []);

  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`menu-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            <span className="menu-label">
              {it.icon && <span className="menu-icon">{it.icon}</span>}
              {it.label}
            </span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        )
      )}
    </div>
  );
}

function ModalView({ modal, onClose }: { modal: Modal; onClose: () => void }) {
  const [value, setValue] = useState(modal.kind === 'prompt' ? modal.initial ?? '' : '');
  const done = (ok: boolean) => {
    if (modal.kind === 'prompt') modal.resolve(ok && value.trim() ? value.trim() : null);
    else modal.resolve(ok);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') done(false);
    if (e.key === 'Enter' && (!(modal.kind === 'prompt' && modal.multiline) || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      done(true);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => done(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="modal-title">{modal.title}</div>
        {modal.kind === 'prompt' ? (
          <label className="field">
            {modal.label && <span>{modal.label}</span>}
            {modal.multiline ? (
              <textarea autoFocus rows={4} value={value} placeholder={modal.placeholder} onChange={(e) => setValue(e.target.value)} />
            ) : (
              <input autoFocus value={value} placeholder={modal.placeholder} onChange={(e) => setValue(e.target.value)} />
            )}
          </label>
        ) : (
          <div className="modal-body">{modal.message}</div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={() => done(false)}>
            Cancel
          </button>
          <button
            autoFocus={modal.kind === 'confirm'}
            className={`btn ${modal.kind === 'confirm' && modal.danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={modal.kind === 'prompt' && !value.trim()}
            onClick={() => done(true)}
          >
            {modal.confirmText ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Splitter({ onDrag }: { onDrag: (dx: number) => void }) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    let last = e.clientX;
    const move = (ev: MouseEvent) => {
      onDrag(ev.clientX - last);
      last = ev.clientX;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className="splitter" onMouseDown={onMouseDown} />;
}

export function Avatar({ name, color, size = 22 }: { name: string; color: string; size?: number }) {
  const parts = name.trim().split(/\s+/);
  const text = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}>
      {text.toUpperCase()}
    </span>
  );
}
