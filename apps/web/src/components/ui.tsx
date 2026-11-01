import { formatMoney, formatSigned, debtStatusLabel, type DebtStatus } from '@pokercontrol/core';
import * as Dialog from '@radix-ui/react-dialog';
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode,
} from 'react';
import { NetworkError, setSlowHandler } from '../api';

// ─── Dinero y estado ─────────────────────────────────────────────────────────
export function Money({ amount, signed, tone, className = '' }: { amount: number; signed?: boolean; tone?: boolean; className?: string }) {
  const color = tone ? (amount > 0 ? 'pos' : amount < 0 ? 'neg' : 'muted') : '';
  return <span className={`money ${color} ${className}`}>{signed ? formatSigned(amount) : formatMoney(amount)}</span>;
}

export function StatusBadge({ status }: { status: DebtStatus }) {
  const cls = status === 'paid' ? 'badge-green' : status === 'partial' ? 'badge-amber' : 'badge-red';
  return <span className={`badge ${cls}`}>{debtStatusLabel(status)}</span>;
}

const AVATAR_COLORS = ['#1D4ED8', '#047857', '#B91C1C', '#7C3AED', '#B45309', '#0E7490', '#BE185D', '#4D7C0F'];

export function Avatar({ name, large, style }: { name: string; large?: boolean; style?: React.CSSProperties }) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return (
    <span aria-hidden="true" className={`avatar ${large ? 'avatar-lg' : ''}`}
      style={{ background: AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length], ...style }}>
      {(name[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function Emoji({ children }: { children: string }) {
  return <span aria-hidden="true">{children}</span>;
}

// ─── Botones ─────────────────────────────────────────────────────────────────
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'text';
  busy?: boolean;
  block?: boolean;
};

export function Btn({ variant = 'primary', busy, block, children, disabled, className = '', ...rest }: BtnProps) {
  return (
    <button type="button" {...rest} disabled={disabled || busy} aria-busy={busy || undefined}
      className={`btn btn-${variant} ${block ? 'btn-block' : ''} ${className}`}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, description, children }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal" {...(description ? {} : { 'aria-describedby': undefined })}>
          <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
          {description && <Dialog.Description className="modal-desc">{description}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Feedback global ─────────────────────────────────────────────────────────
interface ConfirmOptions { title: string; message: string; confirmLabel?: string; danger?: boolean }
interface Feedback {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  notify: (message: string, retry?: () => void) => void;
}
const FeedbackCtx = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [toast, setToast] = useState<{ message: string; retry?: () => void } | null>(null);
  const [slow, setSlow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setSlowHandler(setSlow), []);

  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>(resolve => setDialog({ ...o, resolve })), []);
  const notify = useCallback((message: string, retry?: () => void) => {
    clearTimeout(timer.current);
    setToast({ message, retry });
    if (!retry) timer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  const finish = (value: boolean) => {
    dialog?.resolve(value);
    setDialog(null);
  };

  return (
    <FeedbackCtx.Provider value={{ confirm, notify }}>
      {slow && <div className="wake-banner" role="status">Despertando el servidor, puede tardar unos segundos…</div>}
      {children}
      <Modal open={!!dialog} onClose={() => finish(false)} title={dialog?.title ?? ''} description={dialog?.message}>
        <div className="modal-actions">
          <Btn variant="ghost" onClick={() => finish(false)}>Cancelar</Btn>
          <Btn variant={dialog?.danger ? 'danger' : 'primary'} onClick={() => finish(true)}>
            {dialog?.confirmLabel ?? 'Confirmar'}
          </Btn>
        </div>
      </Modal>
      {toast && (
        <div className="toast" role="alert">
          <span className="grow">{toast.message}</span>
          {toast.retry && (
            <button type="button" onClick={() => { const r = toast.retry; setToast(null); r?.(); }}>Reintentar</button>
          )}
          <button type="button" aria-label="Cerrar aviso" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </FeedbackCtx.Provider>
  );
}

export function useFeedback(): Feedback {
  const value = useContext(FeedbackCtx);
  if (!value) throw new Error('Falta FeedbackProvider');
  return value;
}

/**
 * Ejecuta una acción con spinner y errores visibles. Nunca reintenta sola: ante
 * un fallo de red ofrece "Reintentar", que reusa la Idempotency-Key.
 */
export function useAction() {
  const { notify } = useFeedback();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NetworkError) {
        notify(e.message, () => { void run(fn); });
      } else {
        notify(e instanceof Error ? e.message : 'Ocurrió un error.');
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [notify]);
  return { busy, run };
}

// ─── Estados de carga ────────────────────────────────────────────────────────
export function Loading() {
  return <p className="empty" role="status">Cargando…</p>;
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="empty" role="alert">
      <span className="icon"><Emoji>⚠️</Emoji></span>
      <strong>No se pudo cargar</strong>
      <p>{error instanceof Error ? error.message : 'Ocurrió un error.'}</p>
      <p style={{ marginTop: 12 }}><Btn variant="ghost" onClick={onRetry}>Reintentar</Btn></p>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="icon"><Emoji>{icon}</Emoji></span>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

// ─── Campos ──────────────────────────────────────────────────────────────────
export function TextField({ label, value, onChange, placeholder, autoFocus, decimal, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  autoFocus?: boolean; decimal?: boolean; maxLength?: number;
}) {
  return (
    <label className="field">
      {label}
      <input type="text" value={value} placeholder={placeholder} autoFocus={autoFocus} maxLength={maxLength}
        inputMode={decimal ? 'decimal' : undefined} autoComplete="off"
        onChange={e => onChange(e.target.value)} />
    </label>
  );
}
