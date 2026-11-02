import type { ApiDebt } from '@pokercontrol/contracts';
import { formatMoney, parseAmount } from '@pokercontrol/core';
import { useState } from 'react';
import { api } from '../api';
import { useGroup, useSession } from '../context';
import { Btn, Emoji, Modal, Money, StatusBadge, TextField, useAction, useFeedback } from './ui';

export function PaymentModal({ debt, onClose }: { debt: ApiDebt | null; onClose: () => void }) {
  const { path, invalidate } = useGroup();
  const { notify, confirm } = useFeedback();
  const { busy, run } = useAction();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const close = () => { setAmount(''); setNote(''); onClose(); };

  const partial = () => {
    if (!debt) return;
    const value = parseAmount(amount);
    if (value === null || value <= 0) return notify('Ingresá un monto mayor a cero.');
    if (value > debt.pendingAmount) return notify(`El máximo pendiente es ${formatMoney(debt.pendingAmount)}.`);
    void run(async () => {
      await api(path(`/debts/${debt.id}/payments`), { method: 'POST', body: { amount: value, note }, idempotent: true });
      await invalidate();
      close();
    });
  };

  const full = async () => {
    if (!debt) return;
    const ok = await confirm({
      title: 'Marcar como saldada',
      message: `¿Confirmar que ${debt.fromPlayer.name} pagó todo (${formatMoney(debt.pendingAmount)})?`,
    });
    if (!ok) return;
    void run(async () => {
      await api(path(`/debts/${debt.id}/mark-paid`), { method: 'POST', idempotent: true });
      await invalidate();
      close();
    });
  };

  return (
    <Modal open={!!debt} onClose={close} title="Registrar pago"
      description={debt ? `${debt.fromPlayer.name} → ${debt.toPlayer.name} · ${debt.label}` : undefined}>
      {debt && (
        <>
          <div className="stats-row" style={{ marginBottom: 16 }}>
            <div className="stat"><b><Money amount={debt.originalAmount} /></b><span>Original</span></div>
            <div className="stat"><b><Money amount={debt.pendingAmount} className="neg" /></b><span>Pendiente</span></div>
            {debt.payments.length > 0 && (
              <div className="stat"><b><Money amount={debt.originalAmount - debt.pendingAmount} className="pos" /></b><span>Ya pagó</span></div>
            )}
          </div>
          <TextField label="Monto que paga ahora" value={amount} onChange={setAmount} decimal autoFocus
            placeholder={`Máx: ${formatMoney(debt.pendingAmount)}`} />
          <TextField label="Nota (opcional)" value={note} onChange={setNote} placeholder="Ej: pagó en efectivo" maxLength={200} />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={close}>Cancelar</Btn>
            <Btn variant="ghost" onClick={partial} busy={busy}>Pago parcial</Btn>
            <Btn onClick={() => { void full(); }} busy={busy}>Saldó todo</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

export function DebtDetail({ debt, onPay, showPlayers }: { debt: ApiDebt; onPay: (d: ApiDebt) => void; showPlayers?: boolean }) {
  const paidPct = Math.round(((debt.originalAmount - debt.pendingAmount) / debt.originalAmount) * 100);
  const paid = debt.status === 'paid';
  const { canEdit } = useSession();
  return (
    <div className="card">
      <div className="row-between">
        <div className="grow">
          <div className="strong">
            {showPlayers ? `${debt.fromPlayer.name} → ${debt.toPlayer.name}` : debt.label}
          </div>
          <div className="xs muted">
            {showPlayers ? `${debt.label} · ` : ''}
            {new Date(debt.createdAt).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <StatusBadge status={debt.status} />
          {!paid && <div className="strong" style={{ marginTop: 4 }}><Money amount={debt.pendingAmount} className="neg" /></div>}
        </div>
      </div>
      <div className={`progress ${paid ? 'done' : ''}`} role="progressbar" aria-valuenow={paidPct} aria-valuemin={0} aria-valuemax={100} aria-label="Pagado">
        <div style={{ width: `${paidPct}%` }} />
      </div>
      {debt.payments.map((p, i) => (
        <div key={i} className="row small" style={{ padding: '2px 0' }}>
          <Emoji>✓</Emoji>
          <Money amount={p.amount} className="strong" />
          <span className="grow muted ellipsis">{p.note}</span>
          <span className="xs muted">{new Date(p.date).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })}</span>
        </div>
      ))}
      {!paid && canEdit && <Btn variant="ghost" block style={{ marginTop: 10 }} onClick={() => onPay(debt)}>+ Registrar pago</Btn>}
    </div>
  );
}
