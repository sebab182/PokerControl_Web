import type { ApiDebt, ApiDebtorGroup, ApiReorganizeStatus } from '@pokercontrol/contracts';
import { buildPendingDebtsText, type DebtorGroup } from '@pokercontrol/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { DebtDetail, PaymentModal } from '../components/debts';
import { Avatar, Btn, Emoji, Empty, Loading, Money, QueryError, useAction, useFeedback } from '../components/ui';
import { useGroup } from '../context';
import { shareText } from '../share';

export function PendingDebtsPage() {
  const { path, key, invalidate, canEdit } = useGroup();
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const groups = useQuery({
    queryKey: key('pending-debts'),
    queryFn: () => api<ApiDebtorGroup[]>(path('/debts/pending-by-debtor')),
  });
  const status = useQuery({
    queryKey: key('reorganize-status'),
    queryFn: () => api<ApiReorganizeStatus>(path('/debts/reorganize-status')),
  });
  const [paying, setPaying] = useState<ApiDebt | null>(null);

  const reorganize = async () => {
    const ok = await confirm({
      title: 'Reorganizar deudas', confirmLabel: 'Reorganizar',
      message: 'Esto va a netear y consolidar todas las deudas pendientes entre los mismos jugadores. Podrás deshacer si no hay pagos registrados.',
    });
    if (!ok) return;
    void run(async () => {
      await api(path('/debts/renet'), { method: 'POST' });
      await invalidate();
    });
  };

  const undo = async () => {
    const ok = await confirm({
      title: 'Deshacer reorganización', danger: true, confirmLabel: 'Deshacer',
      message: '¿Restaurar las deudas al estado anterior a la última reorganización?',
    });
    if (!ok) return;
    void run(async () => {
      await api(path('/debts/renet/undo'), { method: 'POST' });
      await invalidate();
    });
  };

  const reorganizeControl = () => {
    const s = status.data;
    if (!s || !canEdit) return null;
    if (s.canUndo) return <Btn variant="ghost" block busy={busy} onClick={() => { void undo(); }}>↩ Deshacer reorganización</Btn>;
    if (s.reason === 'has_payments') return <Btn variant="ghost" block disabled><Emoji>🔒</Emoji> Reorganizar (bloqueado por pagos)</Btn>;
    if (!s.canReorganize) return <Btn variant="ghost" block disabled>✓ No hay deudas para reorganizar</Btn>;
    return <Btn variant="ghost" block busy={busy} onClick={() => { void reorganize(); }}><Emoji>⚡</Emoji> Reorganizar deudas</Btn>;
  };

  if (groups.isLoading) return <Loading />;
  if (groups.error) return <QueryError error={groups.error} onRetry={() => { void groups.refetch(); }} />;
  const list = groups.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 12 }}>Deudas pendientes</h1>
      {list.length === 0 && (
        <>
          <Empty icon="🤝" title="Sin deudas pendientes"><p>Todos los balances están saldados.</p></Empty>
          {status.data?.canUndo && reorganizeControl()}
        </>
      )}
      {list.length > 0 && (
        <div className="stack" style={{ marginBottom: 16 }}>
          <Btn block onClick={() => { void shareText(buildPendingDebtsText(list as unknown as DebtorGroup[]), notify); }}>
            <Emoji>📤</Emoji> Compartir por WhatsApp
          </Btn>
          {reorganizeControl()}
        </div>
      )}

      {list.map(g => (
        <section key={g.player.id} style={{ marginBottom: 20 }} data-testid={`debtor-${g.player.name}`}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Avatar name={g.player.name} />
            <h2 className="grow ellipsis">{g.player.name}</h2>
            <Money amount={g.totalPending} className="neg strong" />
          </div>
          {g.debts.map(d => <DebtDetail key={d.id} debt={d} onPay={setPaying} showPlayers />)}
        </section>
      ))}
      <PaymentModal debt={paying} onClose={() => setPaying(null)} />
    </>
  );
}
