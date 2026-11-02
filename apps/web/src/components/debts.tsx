import type { ApiBalancePayment, ApiPlayerBalance } from '@pokercontrol/contracts';
import { formatMoney, parseAmount, round2 } from '@pokercontrol/core';
import { useState } from 'react';
import { api } from '../api';
import { useGroup } from '../context';
import { Avatar, Btn, Modal, Money, TextField, useAction, useFeedback } from './ui';

/** Texto editable de un saldo: con coma decimal como en el resto de la app. */
export const balanceText = (n: number) => String(round2(n)).replace('.', ',');

/** Un saldo por jugador, con una pista y un campo para corregirlo. */
export function BalanceInputs({ rows, values, onChange }: {
  rows: { playerId: string; name: string; hint?: string }[];
  values: Record<string, string>;
  onChange: (playerId: string, value: string) => void;
}) {
  return (
    <>
      {rows.map(r => (
        <div className="row" key={r.playerId} style={{ marginBottom: 6 }}>
          <Avatar name={r.name} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis strong small">{r.name}</div>
            {r.hint && <div className="xs muted">{r.hint}</div>}
          </div>
          <input type="text" inputMode="decimal" autoComplete="off" aria-label={`Saldo de ${r.name}`}
            style={{ width: 110 }} value={values[r.playerId] ?? ''} onChange={e => onChange(r.playerId, e.target.value)} />
        </div>
      ))}
    </>
  );
}

/** El deudor paga a un acreedor: el monto se descuenta de ambos saldos. */
export function PayModal({ debtor, balances, onClose }: {
  debtor: ApiPlayerBalance | null; balances: ApiPlayerBalance[]; onClose: () => void;
}) {
  const { path, invalidate } = useGroup();
  const { notify } = useFeedback();
  const { busy, run } = useAction();
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const creditors = balances.filter(b => b.balance > 0);
  const target = creditors.find(c => c.playerId === toId) ?? creditors[0];
  const max = debtor && target ? Math.min(-debtor.balance, target.balance) : 0;

  const close = () => { setToId(''); setAmount(''); setNote(''); onClose(); };

  const save = () => {
    if (!debtor || !target) return;
    const value = amount.trim() === '' ? max : parseAmount(amount);
    if (value === null || value <= 0) return notify('Ingresá un monto mayor a cero.');
    if (value > max) return notify(`El máximo es ${formatMoney(max)}.`);
    void run(async () => {
      await api(path('/payments'), {
        method: 'POST', idempotent: true,
        body: { fromPlayerId: debtor.playerId, toPlayerId: target.playerId, amount: value, note },
      });
      await invalidate();
      close();
    });
  };

  return (
    <Modal open={!!debtor} onClose={close} title="Registrar pago"
      description={debtor ? `${debtor.name} debe ${formatMoney(-debtor.balance)}` : undefined}>
      {debtor && creditors.length === 0 && <p className="muted">No hay nadie con saldo a cobrar.</p>}
      {debtor && creditors.length > 0 && (
        <form onSubmit={e => { e.preventDefault(); save(); }}>
          <label className="field">
            Le paga a
            <select value={target?.playerId ?? ''} onChange={e => { setToId(e.target.value); setAmount(''); }}>
              {creditors.map(c => <option key={c.playerId} value={c.playerId}>{c.name} (cobra {formatMoney(c.balance)})</option>)}
            </select>
          </label>
          <TextField label="Monto" value={amount} onChange={setAmount} decimal autoFocus placeholder={`Máx: ${formatMoney(max)}`} />
          <TextField label="Nota (opcional)" value={note} onChange={setNote} placeholder="Ej: transferencia" maxLength={200} />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={close}>Cancelar</Btn>
            <Btn type="submit" busy={busy}>{amount.trim() === '' ? `Pagar ${formatMoney(max)}` : 'Registrar pago'}</Btn>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function PaymentHistory({ payments, canEdit, ownPlayerId, onDelete }: {
  payments: ApiBalancePayment[]; canEdit: boolean; ownPlayerId?: string | null; onDelete: (p: ApiBalancePayment) => void;
}) {
  return (
    <>
      {payments.map(p => (
        <div className="list-row" key={p.id} data-testid="payment-item">
          <span className="grow ellipsis">
            {p.fromPlayer.name} → {p.toPlayer.name}
            {p.note && <span className="muted small"> · {p.note}</span>}
          </span>
          <span className="xs muted">{new Date(p.createdAt).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })}</span>
          <Money amount={p.amount} className="strong" />
          {(canEdit || p.fromPlayer.id === ownPlayerId) && <button type="button" className="icon-btn" aria-label={`Eliminar pago de ${p.fromPlayer.name}`} onClick={() => onDelete(p)}>✕</button>}
        </div>
      ))}
    </>
  );
}
