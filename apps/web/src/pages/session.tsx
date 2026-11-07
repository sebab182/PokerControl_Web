import type {
  ApiCloseSessionResponse, ApiGroup, ApiParticipant, ApiPlayer, ApiPlayerBalance, ApiSession, ApiSessionDebtsView,
} from '@pokercontrol/contracts';
import { POT_TOLERANCE, buildWhatsAppSummary, calcParticipant, formatMoney, parseAmount, round2 } from '@pokercontrol/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiRequestError, api } from '../api';
import { BalanceInputs, balanceText } from '../components/debts';
import {
  Avatar, Btn, Emoji, Empty, Loading, Modal, Money, QueryError, TextField, useAction, useFeedback,
} from '../components/ui';
import { useGroup } from '../context';
import { shareText } from '../share';

const POLL_MS = 15000;

export function SessionPage() {
  const { sessionId = '' } = useParams();
  const { path, key, invalidate, group, canEdit } = useGroup();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const queryKey = key('session', sessionId);
  const query = useQuery({
    queryKey,
    queryFn: () => api<ApiSession>(path(`/sessions/${sessionId}`)),
    // Varios miembros pueden cargar la misma mesa a la vez.
    refetchInterval: q => (q.state.data?.status === 'active' ? POLL_MS : false),
    refetchOnWindowFocus: true,
  });
  const details = useQuery({
    queryKey: key('group-details'),
    queryFn: () => api<ApiGroup>(path('')),
  });
  const [addOpen, setAddOpen] = useState(false);
  const available = useQuery({
    queryKey: key('players'),
    queryFn: () => api<ApiPlayer[]>(path('/players')),
    enabled: addOpen,
  });
  const [buyFor, setBuyFor] = useState<ApiParticipant | null>(null);
  const [buyAmount, setBuyAmount] = useState('');
  const [finalFor, setFinalFor] = useState<ApiParticipant | null>(null);
  const [finalAmount, setFinalAmount] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeValues, setCloseValues] = useState<Record<string, string>>({});
  const currentBalances = useQuery({
    queryKey: key('balances'),
    queryFn: () => api<ApiPlayerBalance[]>(path('/balances')),
    enabled: closeOpen,
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (query.isLoading) return <Loading />;
  if (query.error instanceof ApiRequestError && query.error.status === 404) {
    return <Empty icon="🔍" title="Partida no encontrada"><p><Link to="/seasons">Volver a temporadas</Link></p></Empty>;
  }
  if (query.error || !query.data) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;

  const session = query.data;
  const isClosed = session.status === 'closed';
  const editable = !isClosed && canEdit;
  const { totalPot, diff, status } = session.calc;
  const inSession = new Set(session.participants.map(p => p.playerId));
  const addable = (available.data ?? []).filter(p => !inSession.has(p.id));

  /** Las mutaciones devuelven la partida: se muestra lo que el servidor confirmó. */
  const mutate = (fn: () => Promise<ApiSession>, after?: () => void) => run(async () => {
    const updated = await fn();
    qc.setQueryData(queryKey, updated);
    await invalidate();
    after?.();
  });

  const saveBuy = () => {
    if (!buyFor) return;
    const amount = parseAmount(buyAmount);
    if (amount === null || amount <= 0) return notify('Monto inválido.');
    void mutate(() => api<ApiSession>(path(`/sessions/${sessionId}/buys`), {
      method: 'POST', idempotent: true, body: { playerId: buyFor.playerId, amount },
    }), () => setBuyFor(null));
  };

  const saveFinal = () => {
    if (!finalFor) return;
    const amount = parseAmount(finalAmount);
    if (amount === null || amount < 0) return notify('Monto inválido.');
    void mutate(() => api<ApiSession>(path(`/sessions/${sessionId}/participants/${finalFor.playerId}`), {
      method: 'PATCH', body: { finalAmount: amount },
    }), () => setFinalFor(null));
  };

  const removeBuy = async (buyId: string, amount: number) => {
    const ok = await confirm({ title: 'Eliminar compra', message: `¿Eliminar compra de ${formatMoney(amount)}?`, danger: true, confirmLabel: 'Eliminar' });
    if (ok) void mutate(() => api<ApiSession>(path(`/sessions/${sessionId}/buys/${buyId}`), { method: 'DELETE' }));
  };

  const removeParticipant = async (p: ApiParticipant) => {
    const ok = await confirm({ title: 'Quitar jugador', message: `¿Quitar a ${p.name} de esta partida?`, danger: true, confirmLabel: 'Quitar' });
    if (ok) void mutate(() => api<ApiSession>(path(`/sessions/${sessionId}/participants/${p.playerId}`), { method: 'DELETE' }));
  };

  /** Saldo final por defecto: el último saldo conocido más el resultado de esta partida. */
  const defaultClosing = (p: ApiParticipant, current: Map<string, number>) =>
    round2((current.get(p.playerId) ?? 0) + (p.finalAmount === null ? 0 : calcParticipant(p).balance));

  const openClose = () => {
    setCloseValues({});
    setCloseOpen(true);
  };

  const closeSession = () => {
    const current = new Map((currentBalances.data ?? []).map(b => [b.playerId, b.balance]));
    const balances: { playerId: string; amount: number }[] = [];
    for (const p of session.participants) {
      const typed = closeValues[p.playerId];
      if (typed === undefined || typed.trim() === '') continue;
      const amount = parseAmount(typed);
      if (amount === null) return notify(`Saldo inválido para ${p.name}.`);
      if (round2(amount) !== defaultClosing(p, current)) balances.push({ playerId: p.playerId, amount: round2(amount) });
    }
    void run(async () => {
      try {
        await api<ApiCloseSessionResponse>(path(`/sessions/${sessionId}/close`), {
          method: 'POST', idempotent: true, body: { confirmedDiff: diff, ...(balances.length > 0 ? { balances } : {}) },
        });
      } catch (e) {
        if (e instanceof ApiRequestError && e.code === 'pot_mismatch') {
          await query.refetch();
          setCloseOpen(false);
          throw new Error('Otro miembro cambió los montos. Revisá la diferencia y volvé a cerrar.');
        }
        throw e;
      }
      setCloseOpen(false);
      await invalidate();
      navigate(`/sessions/${sessionId}/debts`);
    });
  };

  const share = () => shareText(buildWhatsAppSummary(session, details.data?.timezone), notify);

  return (
    <>
      <Link className="breadcrumb" to={`/seasons/${session.seasonId}`}>← Partidas · {group.name}</Link>
      <h1 style={{ marginBottom: 12 }}>{session.name}</h1>

      <div className="card center">
        <div className="xs muted strong">POZO TOTAL</div>
        <div className="big" data-testid="pot"><Money amount={totalPot} /></div>
        <div className="small muted">{session.participants.length} jugadores</div>
        {!isClosed && session.participants.some(p => p.finalAmount !== null) && (
          Math.abs(diff) > POT_TOLERANCE
            ? <p className="badge badge-amber" style={{ marginTop: 8 }} data-testid="diff">{status === 'faltan' ? 'Faltan' : 'Sobran'} {formatMoney(Math.abs(diff))}</p>
            : session.missingResults.length === 0 && <p className="badge badge-green" style={{ marginTop: 8 }}>✓ Los montos cuadran</p>
        )}
        {isClosed && Math.abs(diff) > POT_TOLERANCE && (
          <p className="badge badge-amber" style={{ marginTop: 8 }}>Cerrada con diferencia: {formatMoney(diff)}</p>
        )}
        {isClosed && <p className="badge badge-green" style={{ marginTop: 8, marginLeft: 6 }}>✓ Partida cerrada</p>}
      </div>

      {session.participants.length > 0 && (
        <div className="row" style={{ marginBottom: 12 }}>
          <Btn variant="ghost" className="grow" onClick={() => { void share(); }}><Emoji>📤</Emoji> WhatsApp</Btn>
          <Link className="btn btn-ghost grow" to={`/sessions/${sessionId}/debts`}><Emoji>💳</Emoji> Saldos</Link>
          <Link className="btn btn-ghost grow" to={`/sessions/${sessionId}/analysis`}><Emoji>📊</Emoji> Análisis</Link>
        </div>
      )}

      <h2 className="section-title">Jugadores</h2>
      {session.participants.length === 0 && <p className="muted small" style={{ marginBottom: 12 }}>Todavía no hay jugadores en esta partida.</p>}
      <div className="grid-2">
        {session.participants.map(p => {
          const totalBought = p.buys.reduce((s, b) => s + b.amount, 0);
          const has = p.finalAmount !== null;
          const balance = (p.finalAmount ?? 0) - totalBought;
          return (
            <div className="card" key={p.playerId} data-testid={`player-${p.name}`}>
              <div className="row">
                <Avatar name={p.name} />
                <h3 className="grow ellipsis">{p.name}</h3>
                {editable && (
                  <button type="button" className="icon-btn" aria-label={`Quitar a ${p.name}`} onClick={() => { void removeParticipant(p); }}>✕</button>
                )}
              </div>

              {p.buys.length === 0 ? (
                <p className="small muted" style={{ marginTop: 8 }}>Sin compras aún</p>
              ) : (
                <button type="button" className="btn btn-text" style={{ paddingLeft: 0 }}
                  aria-expanded={!!expanded[p.playerId]}
                  onClick={() => setExpanded(e => ({ ...e, [p.playerId]: !e[p.playerId] }))}>
                  Compras de fichas ({p.buys.length}) {expanded[p.playerId] ? '▾' : '▸'}
                </button>
              )}
              {expanded[p.playerId] && p.buys.map(b => (
                <div className="row small" key={b.id}>
                  <span className="grow"><Emoji>🎰</Emoji> <Money amount={b.amount} /></span>
                  <span className="xs muted">{new Date(b.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
                  {editable && (
                    <button type="button" className="icon-btn" aria-label={`Eliminar compra de ${formatMoney(b.amount)}`}
                      onClick={() => { void removeBuy(b.id, b.amount); }}><Emoji>🗑</Emoji></button>
                  )}
                </div>
              ))}

              <div className="row-between small" style={{ marginTop: 6 }}>
                <span className="muted">Total invertido</span>
                <Money amount={totalBought} className="strong" />
              </div>
              <div className="row-between small" style={{ marginTop: 4 }}>
                <span className="muted">Al terminar tenía</span>
                <span className="strong">{has ? <Money amount={p.finalAmount as number} /> : '—'}</span>
              </div>
              <div className="row-between small" style={{ marginTop: 4 }}>
                <span className="muted">Balance</span>
                <span className="strong" data-testid="balance">{has ? <Money amount={balance} signed tone /> : '—'}</span>
              </div>

              {editable && (
                <div className="row" style={{ marginTop: 10 }}>
                  <Btn variant="ghost" className="grow" onClick={() => { setBuyFor(p); setBuyAmount(''); }}>+ Compra</Btn>
                  <Btn variant="ghost" className="grow" onClick={() => { setFinalFor(p); setFinalAmount(has ? String(p.finalAmount) : ''); }}>
                    {has ? 'Editar final' : 'Resultado final'}
                  </Btn>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editable && (
        <div className="stack" style={{ marginTop: 4 }}>
          <Btn variant="ghost" block onClick={() => setAddOpen(true)}>Agregar jugador a la partida</Btn>
          {session.participants.length > 0 && (
            <Btn variant="danger" block busy={busy} onClick={openClose}><Emoji>🏁</Emoji> Cerrar partida</Btn>
          )}
        </div>
      )}

      <Modal open={closeOpen} onClose={() => setCloseOpen(false)} title="Cerrar partida">
        {Math.abs(diff) > POT_TOLERANCE && (
          <div className="notice notice-warn" role="status">El pozo no cuadra: {status} {formatMoney(Math.abs(diff))}.</div>
        )}
        {session.missingResults.length > 0 && (
          <div className="notice notice-warn" role="status">
            {session.missingResults.length} jugador{session.missingResults.length === 1 ? '' : 'es'} sin resultado: su saldo no cambia.
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 8 }}>
          Saldo final de cada jugador (último saldo conocido + resultado). Corregilo si hubo pagos por fuera.
        </p>
        {currentBalances.isLoading && <Loading />}
        {currentBalances.data && (() => {
          const current = new Map(currentBalances.data.map(b => [b.playerId, b.balance]));
          return (
            <BalanceInputs
              rows={session.participants.map(p => ({
                playerId: p.playerId,
                name: p.name,
                hint: `Previo ${formatMoney(current.get(p.playerId) ?? 0)}${p.finalAmount === null ? '' : ` · resultado ${formatMoney(round2(calcParticipant(p).balance))}`}`,
              }))}
              values={Object.fromEntries(session.participants.map(p => [
                p.playerId, closeValues[p.playerId] ?? balanceText(defaultClosing(p, current)),
              ]))}
              onChange={(id, v) => setCloseValues(prev => ({ ...prev, [id]: v }))}
            />
          );
        })()}
        <p className="small muted" style={{ marginTop: 8 }}>Una partida cerrada no se puede editar.</p>
        <div className="modal-actions">
          <Btn variant="ghost" onClick={() => setCloseOpen(false)}>Cancelar</Btn>
          <Btn variant="danger" busy={busy} disabled={!currentBalances.data} onClick={closeSession}>Cerrar partida</Btn>
        </div>
      </Modal>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Agregar jugador">
        {available.isLoading && <Loading />}
        {available.data && addable.length === 0 && (
          <p className="muted">No hay jugadores disponibles. Creá jugadores en <Link to="/players">Jugadores</Link>.</p>
        )}
        {addable.map(player => (
          <button type="button" key={player.id} className="btn btn-ghost btn-block" style={{ justifyContent: 'flex-start', marginBottom: 8 }}
            onClick={() => {
              void mutate(() => api<ApiSession>(path(`/sessions/${sessionId}/participants`), {
                method: 'POST', body: { playerId: player.id },
              }), () => setAddOpen(false));
            }}>
            <Avatar name={player.name} /> <span className="grow ellipsis" style={{ textAlign: 'left' }}>{player.name}</span> +
          </button>
        ))}
        <div className="modal-actions"><Btn variant="ghost" onClick={() => setAddOpen(false)}>Cerrar</Btn></div>
      </Modal>

      <Modal open={!!buyFor} onClose={() => setBuyFor(null)} title={`Compra — ${buyFor?.name ?? ''}`}>
        <form onSubmit={e => { e.preventDefault(); saveBuy(); }}>
          <TextField label="¿Cuánto compra en fichas?" value={buyAmount} onChange={setBuyAmount} decimal autoFocus placeholder="Ej: 20000" />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setBuyFor(null)}>Cancelar</Btn>
            <Btn type="submit" busy={busy}>Registrar</Btn>
          </div>
        </form>
      </Modal>

      <Modal open={!!finalFor} onClose={() => setFinalFor(null)} title={`Resultado — ${finalFor?.name ?? ''}`}>
        <form onSubmit={e => { e.preventDefault(); saveFinal(); }}>
          <TextField label="¿Con cuánto terminó?" value={finalAmount} onChange={setFinalAmount} decimal autoFocus placeholder="Ej: 35000" />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setFinalFor(null)}>Cancelar</Btn>
            <Btn type="submit" busy={busy}>Guardar</Btn>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function SessionDebtsPage() {
  const { sessionId = '' } = useParams();
  const { path, key } = useGroup();
  const query = useQuery({
    queryKey: key('session-debts', sessionId),
    queryFn: () => api<ApiSessionDebtsView>(path(`/sessions/${sessionId}/debts`)),
  });

  if (query.isLoading) return <Loading />;
  if (query.error instanceof ApiRequestError && query.error.status === 404) {
    return <Empty icon="🔍" title="Partida no encontrada"><p><Link to="/seasons">Volver a temporadas</Link></p></Empty>;
  }
  if (query.error || !query.data) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;
  const view = query.data;
  const closed = view.sessionStatus === 'closed';

  return (
    <>
      <Link className="breadcrumb" to={`/sessions/${sessionId}`}>← Partida</Link>
      <h1 style={{ marginBottom: 12 }}>Saldos de la partida</h1>

      {!view.allHaveResult && view.balances.length > 0 && (
        <div className="notice notice-warn" role="status">
          No todos los jugadores tienen resultado: el cálculo está incompleto.
        </div>
      )}

      <div className="card">
        {view.balances.length === 0 && <p className="muted small">Sin jugadores.</p>}
        {view.balances.map(b => (
          <div className="list-row" key={b.playerId} data-testid={`result-${b.name}`}>
            <Avatar name={b.name} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis">{b.name}</div>
              {b.before !== null && <div className="xs muted">Previo {formatMoney(b.before)}</div>}
            </div>
            {b.result === null ? <span className="muted small">sin resultado</span> : <Money amount={b.result} signed tone className="strong" />}
            {b.after !== null && <Money amount={b.after} className="strong" />}
          </div>
        ))}
      </div>
      {closed
        ? <p className="small muted" style={{ marginTop: 12 }}>Resultado de la partida y saldo resultante de cada uno. <Link to="/debts">Ver saldos de todos</Link></p>
        : <div className="notice notice-info">Cerrá la partida para sumar estos resultados a los saldos.</div>}
    </>
  );
}
