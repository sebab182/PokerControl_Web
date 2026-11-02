import type { ApiBalancePayment, ApiPlayerBalance } from '@pokercontrol/contracts';
import { buildBalancesText, formatMoney, parseAmount, round2 } from '@pokercontrol/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { BalanceInputs, PayModal, PaymentHistory, balanceText } from '../components/debts';
import { Avatar, Btn, Emoji, Empty, Loading, Modal, Money, QueryError, TextField, useAction, useFeedback } from '../components/ui';
import { useGroup } from '../context';
import { shareText } from '../share';

export function PendingDebtsPage() {
  const { path, key, invalidate, canEdit, group } = useGroup();
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const balances = useQuery({
    queryKey: key('balances'),
    queryFn: () => api<ApiPlayerBalance[]>(path('/balances')),
  });
  const payments = useQuery({
    queryKey: key('payments'),
    queryFn: () => api<ApiBalancePayment[]>(path('/payments')),
  });
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [paying, setPaying] = useState<ApiPlayerBalance | null>(null);

  const removePayment = async (p: ApiBalancePayment) => {
    const ok = await confirm({
      title: 'Eliminar pago', danger: true, confirmLabel: 'Eliminar',
      message: `¿Eliminar el pago de ${formatMoney(p.amount)} de ${p.fromPlayer.name} a ${p.toPlayer.name}? Los saldos vuelven a como estaban.`,
    });
    if (!ok) return;
    void run(async () => {
      await api(path(`/payments/${p.id}`), { method: 'DELETE' });
      await invalidate();
    });
  };

  const active = (balances.data ?? []).filter(b => !b.archived);

  const saveBalances = () => {
    const changes: { playerId: string; amount: number }[] = [];
    for (const b of active) {
      const typed = values[b.playerId];
      if (typed === undefined || typed.trim() === '') continue;
      const amount = parseAmount(typed);
      if (amount === null) return notify(`Saldo inválido para ${b.name}.`);
      if (round2(amount) !== b.balance) changes.push({ playerId: b.playerId, amount: round2(amount) });
    }
    if (changes.length === 0) return notify('No cambiaste ningún saldo.');
    void run(async () => {
      await api(path('/balances'), { method: 'PUT', body: { balances: changes, note } });
      await invalidate();
      setEditing(false);
    });
  };

  if (balances.isLoading || payments.isLoading) return <Loading />;
  if (balances.error) return <QueryError error={balances.error} onRetry={() => { void balances.refetch(); }} />;
  const list = (balances.data ?? []).filter(b => b.balance !== 0);

  return (
    <>
      <h1 style={{ marginBottom: 12 }}>Saldos</h1>
      <p className="small muted" style={{ marginBottom: 12 }}>
        Saldo consolidado de cada jugador, del que más tiene para cobrar al que más debe.
      </p>
      {canEdit && (
        <Btn variant="ghost" block style={{ marginBottom: 12 }} onClick={() => { setValues({}); setNote(''); setEditing(true); }}>
          <Emoji>✏️</Emoji> Actualizar saldos
        </Btn>
      )}
      {list.length === 0 && <Empty icon="🤝" title="Todos en cero"><p>No hay saldos pendientes.</p></Empty>}
      {list.length > 0 && (
        <div className="stack" style={{ marginBottom: 16 }}>
          <Btn block onClick={() => { void shareText(buildBalancesText(balances.data ?? [], formatMoney), notify); }}>
            <Emoji>📤</Emoji> Compartir por WhatsApp
          </Btn>
        </div>
      )}

      {list.map(b => (
        <div className="card" key={b.playerId} data-testid={`balance-${b.name}`}>
          <div className="row">
            <Avatar name={b.name} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="strong ellipsis">{b.name}</div>
              <div className="xs muted">{b.balance > 0 ? 'Tiene para cobrar' : 'Debe'}</div>
            </div>
            <Money amount={b.balance} signed tone className="strong" />
          </div>
          {(canEdit || b.playerId === group.playerId) && b.balance < 0 && (
            <Btn variant="ghost" block style={{ marginTop: 10 }} onClick={() => setPaying(b)}>+ Registrar pago</Btn>
          )}
        </div>
      ))}

      {(payments.data?.length ?? 0) > 0 && (
        <>
          <h2 className="section-title">Pagos registrados</h2>
          <div className="card">
            <PaymentHistory payments={payments.data ?? []} canEdit={canEdit} ownPlayerId={group.playerId} onDelete={p => { void removePayment(p); }} />
          </div>
        </>
      )}
      <Modal open={editing} onClose={() => setEditing(false)} title="Actualizar saldos">
        <p className="small muted" style={{ marginBottom: 8 }}>
          Poné el saldo real de cada jugador (+ cobra, − debe). Solo se guardan los que cambies.
        </p>
        <form onSubmit={e => { e.preventDefault(); saveBalances(); }}>
          <BalanceInputs
            rows={active.map(b => ({ playerId: b.playerId, name: b.name }))}
            values={Object.fromEntries(active.map(b => [b.playerId, values[b.playerId] ?? balanceText(b.balance)]))}
            onChange={(id, v) => setValues(prev => ({ ...prev, [id]: v }))}
          />
          <TextField label="Motivo (opcional)" value={note} onChange={setNote} placeholder="Ej: pagos por fuera" maxLength={200} />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setEditing(false)}>Cancelar</Btn>
            <Btn type="submit" busy={busy}>Guardar</Btn>
          </div>
        </form>
      </Modal>
      <PayModal debtor={paying} balances={balances.data ?? []} onClose={() => setPaying(null)} />
    </>
  );
}
