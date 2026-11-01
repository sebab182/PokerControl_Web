import type {
  ApiDebt, ApiPlayer, ApiPlayerAdjustment, ApiPlayerDebts, ApiPlayerReport, ApiPlayerStats, ApiRankingEntry, ApiSeason,
} from '@pokercontrol/contracts';
import { formatMoney, parseAmount } from '@pokercontrol/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiRequestError, api } from '../api';
import { LineChart } from '../components/LineChart';
import {
  Avatar, Btn, Emoji, Empty, Loading, Modal, Money, QueryError, TextField, useAction, useFeedback,
} from '../components/ui';
import { useGroup } from '../context';

const date = (iso: string) => new Date(iso).toLocaleDateString('es-AR');

export function PlayersPage() {
  const { path, key, invalidate } = useGroup();
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const [showArchived, setShowArchived] = useState(false);
  const query = useQuery({
    queryKey: key('players', 'all'),
    queryFn: () => api<ApiPlayer[]>(path('/players?includeArchived=true')),
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<ApiPlayer | null>(null);

  if (query.isLoading) return <Loading />;
  if (query.error) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;
  const all = query.data ?? [];
  const active = all.filter(p => !p.archivedAt);
  const archived = all.filter(p => p.archivedAt);

  const remove = async (p: ApiPlayer) => {
    const ok = await confirm({
      title: 'Eliminar jugador', danger: true, confirmLabel: 'Eliminar',
      message: `¿Eliminar a ${p.name}? Si tiene historial se archiva: deja de aparecer para nuevas partidas, pero conserva sus resultados.`,
    });
    if (!ok) return;
    void run(async () => {
      const r = await api<{ archived: boolean }>(path(`/players/${p.id}`), { method: 'DELETE' });
      await invalidate();
      if (r.archived) notify(`${p.name} tenía historial: quedó archivado.`);
    });
  };

  const submitName = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    void run(async () => {
      if (renaming) await api(path(`/players/${renaming.id}`), { method: 'PATCH', body: { name } });
      else await api(path('/players'), { method: 'POST', body: { name } });
      await invalidate();
      setAdding(false);
      setRenaming(null);
    });
  };

  return (
    <>
      <div className="page-head">
        <h1 className="grow">Jugadores</h1>
        <Btn onClick={() => { setName(''); setAdding(true); }}>+ Agregar</Btn>
      </div>
      <Link className="btn btn-ghost btn-block" to="/debts" style={{ marginBottom: 12 }}><Emoji>💳</Emoji> Ver deudas pendientes</Link>

      {active.length === 0 && <Empty icon="👥" title="No hay jugadores"><p>Agregá a los jugadores del grupo.</p></Empty>}
      <div className="grid-2">
        {active.map(p => (
          <div className="card row" key={p.id}>
            <Avatar name={p.name} />
            <span className="grow ellipsis strong">{p.name}</span>
            <Link className="icon-btn" to={`/players/${p.id}/stats`} aria-label={`Estadísticas de ${p.name}`}><Emoji>📊</Emoji></Link>
            <button type="button" className="icon-btn" aria-label={`Renombrar a ${p.name}`} onClick={() => { setRenaming(p); setName(p.name); }}><Emoji>✏️</Emoji></button>
            <button type="button" className="icon-btn" aria-label={`Eliminar a ${p.name}`} onClick={() => { void remove(p); }}><Emoji>🗑</Emoji></button>
          </div>
        ))}
      </div>

      {archived.length > 0 && (
        <Btn variant="text" onClick={() => setShowArchived(v => !v)} aria-expanded={showArchived}>
          {showArchived ? 'Ocultar' : 'Ver'} archivados ({archived.length})
        </Btn>
      )}
      {showArchived && archived.map(p => (
        <div className="card row" key={p.id}>
          <Avatar name={p.name} />
          <span className="grow ellipsis muted">{p.name}</span>
          <Link className="icon-btn" to={`/players/${p.id}/stats`} aria-label={`Estadísticas de ${p.name}`}><Emoji>📊</Emoji></Link>
          <Btn variant="ghost" busy={busy} onClick={() => {
            void run(async () => {
              await api(path(`/players/${p.id}/unarchive`), { method: 'POST' });
              await invalidate();
            });
          }}>Restaurar</Btn>
        </div>
      ))}

      <Modal open={adding || !!renaming} onClose={() => { setAdding(false); setRenaming(null); }}
        title={renaming ? 'Renombrar jugador' : 'Nuevo jugador'}
        description={renaming ? 'El nombre nuevo se ve también en sus partidas y deudas anteriores.' : undefined}>
        <form onSubmit={submitName}>
          <TextField label="Nombre" value={name} onChange={setName} autoFocus maxLength={120} />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => { setAdding(false); setRenaming(null); }}>Cancelar</Btn>
            <Btn type="submit" busy={busy} disabled={!name.trim()}>Guardar</Btn>
          </div>
        </form>
      </Modal>
    </>
  );
}

function SeasonSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { path, key } = useGroup();
  const seasons = useQuery({ queryKey: key('seasons'), queryFn: () => api<ApiSeason[]>(path('/seasons')) });
  return (
    <label className="field">
      Alcance
      <select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Histórico</option>
        {seasons.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}

function PlayerDebtsSection({ playerId, debts }: { playerId: string; debts: ApiPlayerDebts }) {
  const { path, invalidate } = useGroup();
  const { confirm } = useFeedback();
  const { busy, run } = useAction();

  const summarize = (list: ApiDebt[], counterpart: (d: ApiDebt) => { id: string; name: string }) => {
    const map = new Map<string, { name: string; total: number; ids: string[] }>();
    list.filter(d => d.status !== 'paid').forEach(d => {
      const c = counterpart(d);
      const entry = map.get(c.id) ?? { name: c.name, total: 0, ids: [] };
      entry.total += d.pendingAmount;
      entry.ids.push(d.id);
      map.set(c.id, entry);
    });
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  };
  const owes = summarize(debts.owes, d => d.toPlayer);
  const owed = summarize(debts.owed, d => d.fromPlayer);

  const settle = async (name: string, total: number, ids: string[]) => {
    const ok = await confirm({ title: 'Saldar deudas', message: `¿Marcar ${formatMoney(total)} con ${name} como saldado?` });
    if (!ok) return;
    void run(async () => {
      await api(path('/debts/mark-paid'), { method: 'POST', idempotent: true, body: { debtIds: ids } });
      await invalidate();
    });
  };

  return (
    <div className="card" data-player={playerId}>
      {owes.length === 0 && owed.length === 0 && <p className="muted small center"><Emoji>🤝</Emoji> Sin deudas pendientes</p>}
      {owes.length > 0 && <h3>Debe pagar</h3>}
      {owes.map(([id, c]) => (
        <div className="list-row" key={id}>
          <span className="grow ellipsis">{c.name}</span>
          <Money amount={c.total} className="neg strong" />
          <button type="button" className="icon-btn" disabled={busy} aria-label={`Saldar deudas con ${c.name}`}
            onClick={() => { void settle(c.name, c.total, c.ids); }}>✓</button>
        </div>
      ))}
      {owed.length > 0 && <h3 style={{ marginTop: owes.length > 0 ? 12 : 0 }}>Le deben</h3>}
      {owed.map(([id, c]) => (
        <div className="list-row" key={id}>
          <span className="grow ellipsis">{c.name}</span>
          <Money amount={c.total} className="pos strong" />
        </div>
      ))}
    </div>
  );
}

export function StatsPage() {
  const { playerId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const seasonId = params.get('seasonId') ?? '';
  const { path, key, invalidate } = useGroup();
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const qs = seasonId ? `?seasonId=${seasonId}` : '';

  const players = useQuery({ queryKey: key('players', 'all'), queryFn: () => api<ApiPlayer[]>(path('/players?includeArchived=true')) });
  const stats = useQuery({ queryKey: key('stats', playerId, seasonId), queryFn: () => api<ApiPlayerStats | null>(path(`/players/${playerId}/stats${qs}`)) });
  const report = useQuery({ queryKey: key('report', playerId, seasonId), queryFn: () => api<ApiPlayerReport | null>(path(`/players/${playerId}/report${qs}`)) });
  const debts = useQuery({ queryKey: key('player-debts', playerId), queryFn: () => api<ApiPlayerDebts>(path(`/players/${playerId}/debts`)) });

  const [manualOpen, setManualOpen] = useState(false);
  const [direction, setDirection] = useState<'cobro' | 'deuda'>('cobro');
  const [counterpart, setCounterpart] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [editing, setEditing] = useState<ApiPlayerAdjustment | null>(null);
  const [editDirection, setEditDirection] = useState<'cobro' | 'deuda'>('cobro');
  const [editDescription, setEditDescription] = useState('');
  const [editAmount, setEditAmount] = useState('');

  if (stats.isLoading || players.isLoading) return <Loading />;
  if (stats.error instanceof ApiRequestError && stats.error.status === 404) {
    return <Empty icon="🔍" title="Jugador no encontrado"><p><Link to="/players">Volver a jugadores</Link></p></Empty>;
  }
  if (stats.error) return <QueryError error={stats.error} onRetry={() => { void stats.refetch(); }} />;

  const player = players.data?.find(p => p.id === playerId);
  const others = (players.data ?? []).filter(p => p.id !== playerId && !p.archivedAt);
  const s = stats.data ?? null;
  const r = report.data ?? null;
  const allDebts = debts.data;
  const manualDebts = allDebts
    ? [...allDebts.owes, ...allDebts.owed].filter(d => d.sourceType === 'manual' && d.status !== 'paid')
    : [];

  const openManual = () => {
    setDirection('cobro'); setCounterpart(''); setDescription(''); setAmount(''); setManualOpen(true);
  };

  const saveManual = () => {
    const value = parseAmount(amount);
    if (value === null || value <= 0) return notify('Ingresá un monto mayor a 0.');
    if (!counterpart) return notify('Elegí con quién es la deuda previa.');
    void run(async () => {
      await api(path('/debts/manual'), {
        method: 'POST',
        body: {
          fromPlayerId: direction === 'deuda' ? playerId : counterpart,
          toPlayerId: direction === 'deuda' ? counterpart : playerId,
          amount: value,
          description,
        },
      });
      await invalidate();
      setManualOpen(false);
    });
  };

  const deleteManual = async (d: ApiDebt) => {
    const ok = await confirm({ title: 'Eliminar deuda previa', message: '¿Eliminar este registro?', danger: true, confirmLabel: 'Eliminar' });
    if (!ok) return;
    void run(async () => {
      await api(path(`/debts/manual/${d.id}`), { method: 'DELETE' });
      await invalidate();
    });
  };

  const payManual = async (d: ApiDebt) => {
    const ok = await confirm({ title: 'Saldar deuda previa', message: `¿Confirmar que se pagó ${formatMoney(d.pendingAmount)}?` });
    if (!ok) return;
    void run(async () => {
      await api(path(`/debts/${d.id}/mark-paid`), { method: 'POST', idempotent: true });
      await invalidate();
    });
  };

  const deleteAdjustment = async (a: ApiPlayerAdjustment) => {
    const ok = await confirm({ title: 'Eliminar ajuste', message: '¿Eliminar este ajuste?', danger: true, confirmLabel: 'Eliminar' });
    if (!ok) return;
    void run(async () => {
      await api(path(`/players/${playerId}/adjustments/${a.id}`), { method: 'DELETE' });
      await invalidate();
    });
  };

  const saveAdjustment = () => {
    if (!editing) return;
    const value = parseAmount(editAmount);
    if (value === null || value <= 0) return notify('Ingresá un monto mayor a 0.');
    void run(async () => {
      await api(path(`/players/${playerId}/adjustments/${editing.id}`), {
        method: 'PATCH',
        body: { description: editDescription, amount: editDirection === 'deuda' ? -value : value },
      });
      await invalidate();
      setEditing(null);
    });
  };

  const hero = s ? (seasonId ? s.sessionBalance : s.totalBalance) : 0;
  const chronological = s ? [...s.history].reverse() : [];

  return (
    <>
      <Link className="breadcrumb" to="/players">← Jugadores</Link>
      <div className="row" style={{ marginBottom: 12 }}>
        <Avatar name={player?.name ?? '?'} large />
        <div className="grow">
          <h1 className="ellipsis">{player?.name ?? 'Jugador'}</h1>
          {player?.archivedAt && <span className="badge badge-muted">Archivado</span>}
        </div>
      </div>
      <SeasonSelect value={seasonId} onChange={id => setParams(id ? { seasonId: id } : {}, { replace: true })} />

      {!s && (
        <Empty icon="📊" title="Sin historial aún">
          <p>{player?.name} todavía no tiene partidas cerradas{seasonId ? ' en esta temporada' : ''}.</p>
        </Empty>
      )}

      {s && (
        <div className="card center">
          <div className="xs muted strong">{seasonId ? 'BALANCE DE LA TEMPORADA' : 'BALANCE HISTÓRICO'}</div>
          <div className="big" data-testid="hero-balance"><Money amount={hero} signed tone /></div>
          {!seasonId && (s.adjustmentsTotal !== 0 || s.manualDebtsNet !== 0) && (
            <p className="small muted">
              Partidas <Money amount={s.sessionBalance} signed />
              {s.adjustmentsTotal !== 0 && <> · Ajustes <Money amount={s.adjustmentsTotal} signed /></>}
              {s.manualDebtsNet !== 0 && <> · Deudas previas <Money amount={s.manualDebtsNet} signed /></>}
            </p>
          )}
          {s.totalGames > 0 && (
            <div className="stats-row num">
              <div className="stat"><b>{s.totalGames}</b><span>Partidas</span></div>
              <div className="stat"><b className="pos">{s.wins}</b><span>Ganadas</span></div>
              <div className="stat"><b className="neg">{s.losses}</b><span>Perdidas</span></div>
              {s.ties > 0 && <div className="stat"><b>{s.ties}</b><span>Empates</span></div>}
              <div className="stat"><b>{s.winRate}%</b><span>Win rate</span></div>
            </div>
          )}
        </div>
      )}

      {chronological.length >= 2 && (
        <div className="card">
          <h3>Balance por partida</h3>
          <p className="xs muted" style={{ marginBottom: 8 }}>Escala x1.000 · deslizá para ver historial</p>
          <LineChart data={chronological.map(h => h.balance)} labels={chronological.map(h => h.sessionName)} />
        </div>
      )}

      {s?.bestGame && s.worstGame && (
        <div className="row" style={{ alignItems: 'stretch', marginBottom: 12 }}>
          <div className="card grow" style={{ marginBottom: 0 }}>
            <div className="small muted"><Emoji>🏆</Emoji> Mejor</div>
            <div className="strong"><Money amount={s.bestGame.balance} signed className="pos" /></div>
            <div className="xs muted ellipsis">{s.bestGame.sessionName}</div>
          </div>
          <div className="card grow" style={{ marginBottom: 0 }}>
            <div className="small muted"><Emoji>💸</Emoji> Peor</div>
            <div className="strong"><Money amount={s.worstGame.balance} signed className="neg" /></div>
            <div className="xs muted ellipsis">{s.worstGame.sessionName}</div>
          </div>
        </div>
      )}

      {r && (
        <div className="card">
          <h3>Compras y rachas</h3>
          <div className="stats-row num">
            <div className="stat"><b>{r.avgBuysPerGame.toLocaleString('es-AR')}</b><span>Compras/partida</span></div>
            <div className="stat"><b>{r.rebuyRate}%</b><span>Recompra</span></div>
            <div className="stat"><b className={r.roi >= 0 ? 'pos' : 'neg'}>{r.roi > 0 ? '+' : ''}{r.roi}%</b><span>Retorno</span></div>
            <div className="stat"><b className="pos">{r.longestWinStreak}</b><span>Mejor racha</span></div>
            <div className="stat"><b className="neg">{r.longestLossStreak}</b><span>Peor racha</span></div>
            <div className="stat">
              <b>{r.currentStreak.count >= 2 ? `${r.currentStreak.type === 'win' ? '🔥' : '🥶'} ${r.currentStreak.count}` : '—'}</b>
              <span>Racha actual</span>
            </div>
          </div>
          {r.lowestCumulative < 0 && (
            <p className="small muted" style={{ marginTop: 10 }}>
              Peor momento: <Money amount={r.lowestCumulative} />
              {r.recoveries.length > 0 && ` · salió de negativo ${r.recoveries.length === 1 ? '1 vez' : `${r.recoveries.length} veces`}`}
            </p>
          )}
          {r.nightComebacks > 0 && (
            <p className="small muted" style={{ marginTop: 4 }}>
              Remontó en la noche {r.nightComebacks === 1 ? '1 vez' : `${r.nightComebacks} veces`} (recompró y terminó ganando)
            </p>
          )}
        </div>
      )}

      <div className="row-between section-title">
        <h2>Deudas previas</h2>
        {!player?.archivedAt && <Btn variant="ghost" onClick={openManual}>+ Agregar</Btn>}
      </div>
      {seasonId && <p className="small muted" style={{ marginBottom: 8 }}>No dependen de la temporada, son siempre globales.</p>}
      {manualDebts.length === 0 && <p className="small muted" style={{ marginBottom: 12 }}>Sin deudas previas registradas</p>}
      {manualDebts.map(d => {
        const iAmOwed = d.toPlayer.id === playerId;
        const other = iAmOwed ? d.fromPlayer.name : d.toPlayer.name;
        return (
          <div className="card row" key={d.id}>
            <div className="grow">
              <div className="strong small">{iAmOwed ? `${other} le debe` : `Le debe a ${other}`}</div>
              <div className="xs muted ellipsis">{d.label}</div>
            </div>
            <Money amount={iAmOwed ? d.pendingAmount : -d.pendingAmount} signed tone className="strong" />
            {!iAmOwed && <button type="button" className="icon-btn" aria-label="Saldar deuda previa" onClick={() => { void payManual(d); }}>✓</button>}
            {!d.isConsolidated && <button type="button" className="icon-btn" aria-label="Eliminar deuda previa" onClick={() => { void deleteManual(d); }}><Emoji>🗑</Emoji></button>}
          </div>
        );
      })}

      {s && s.adjustments.length > 0 && (
        <>
          <h2 className="section-title">Ajustes previos (sin jugador asociado)</h2>
          {s.adjustments.map(a => (
            <div className="card row" key={a.id}>
              <div className="grow">
                <div className="small strong ellipsis">{a.description || 'Ajuste'}</div>
                <div className="xs muted">{date(a.date)}</div>
              </div>
              <Money amount={a.amount} signed tone className="strong" />
              <button type="button" className="icon-btn" aria-label="Editar ajuste" onClick={() => {
                setEditing(a);
                setEditDirection(a.amount < 0 ? 'deuda' : 'cobro');
                setEditDescription(a.description);
                setEditAmount(String(Math.abs(a.amount)));
              }}><Emoji>✏️</Emoji></button>
              <button type="button" className="icon-btn" aria-label="Eliminar ajuste" onClick={() => { void deleteAdjustment(a); }}><Emoji>🗑</Emoji></button>
            </div>
          ))}
        </>
      )}

      <h2 className="section-title">Deudas</h2>
      {allDebts && <PlayerDebtsSection playerId={playerId} debts={allDebts} />}

      {s && s.history.length > 0 && (
        <>
          <h2 className="section-title">Historial</h2>
          <div className="card table-wrap" tabIndex={0} role="group" aria-label="Historial de partidas">
            <table>
              <thead>
                <tr><th>Partida</th><th>Fecha</th><th className="right">Comprado</th><th className="right">Final</th><th className="right">Balance</th></tr>
              </thead>
              <tbody>
                {s.history.map(h => (
                  <tr key={h.sessionId}>
                    <td><Link to={`/sessions/${h.sessionId}`}>{h.sessionName}</Link></td>
                    <td>{date(h.date)}</td>
                    <td className="right"><Money amount={h.totalBought} /></td>
                    <td className="right"><Money amount={h.finalAmount} /></td>
                    <td className="right strong"><Money amount={h.balance} signed tone /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal open={manualOpen} onClose={() => setManualOpen(false)} title="Deuda previa">
        <div className="segmented">
          <Btn variant="ghost" aria-pressed={direction === 'cobro'} onClick={() => setDirection('cobro')}><Emoji>💰</Emoji> Me debe</Btn>
          <Btn variant="ghost" aria-pressed={direction === 'deuda'} onClick={() => setDirection('deuda')}><Emoji>💸</Emoji> Le debo</Btn>
        </div>
        <label className="field">
          {direction === 'deuda' ? '¿A quién le debe?' : '¿Quién le debe?'}
          <select value={counterpart} onChange={e => setCounterpart(e.target.value)}>
            <option value="">Elegí un jugador</option>
            {others.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <TextField label="Descripción (opcional)" value={description} onChange={setDescription} maxLength={200}
          placeholder={direction === 'deuda' ? 'Ej: Deuda de torneo anterior' : 'Ej: Cobro de apuesta vieja'} />
        <TextField label="Monto" value={amount} onChange={setAmount} decimal placeholder="Ej: 5000" />
        <div className="modal-actions">
          <Btn variant="ghost" onClick={() => setManualOpen(false)}>Cancelar</Btn>
          <Btn onClick={saveManual} busy={busy}>Guardar</Btn>
        </div>
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Editar ajuste">
        <div className="segmented">
          <Btn variant="ghost" aria-pressed={editDirection === 'cobro'} onClick={() => setEditDirection('cobro')}><Emoji>💰</Emoji> Me debe</Btn>
          <Btn variant="ghost" aria-pressed={editDirection === 'deuda'} onClick={() => setEditDirection('deuda')}><Emoji>💸</Emoji> Le debo</Btn>
        </div>
        <TextField label="Descripción" value={editDescription} onChange={setEditDescription} maxLength={200} />
        <TextField label="Monto" value={editAmount} onChange={setEditAmount} decimal />
        <div className="modal-actions">
          <Btn variant="ghost" onClick={() => setEditing(null)}>Cancelar</Btn>
          <Btn onClick={saveAdjustment} busy={busy}>Guardar</Btn>
        </div>
      </Modal>
    </>
  );
}

export function RankingPage() {
  const [params, setParams] = useSearchParams();
  const seasonId = params.get('seasonId') ?? '';
  const { path, key } = useGroup();
  const query = useQuery({
    queryKey: key('ranking', seasonId),
    queryFn: () => api<ApiRankingEntry[]>(path(`/ranking${seasonId ? `?seasonId=${seasonId}` : ''}`)),
  });
  const statsLink = (id: string) => `/players/${id}/stats${seasonId ? `?seasonId=${seasonId}` : ''}`;
  const value = (r: ApiRankingEntry) => (seasonId ? r.sessionBalance : r.totalBalance);
  const ranking = query.data ?? [];
  const hasPodium = ranking.length >= 2;
  const rest = hasPodium ? ranking.slice(3) : ranking;
  const MEDALS = ['🥇', '🥈', '🥉'];
  const BORDER = ['#D4A017', '#9CA3AF', '#B4693A'];

  return (
    <>
      <h1 style={{ marginBottom: 12 }}>Ranking</h1>
      <SeasonSelect value={seasonId} onChange={id => setParams(id ? { seasonId: id } : {}, { replace: true })} />
      {query.isLoading && <Loading />}
      {query.error && <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />}
      {query.data && ranking.length === 0 && (
        <Empty icon="🏆" title="Sin ranking aún">
          <p>{seasonId ? 'Todavía no se cerró ninguna partida en esta temporada.' : 'Aparece cuando se cierre la primera partida.'}</p>
        </Empty>
      )}

      {hasPodium && (
        <ol className="podium" style={{ listStyle: 'none', padding: 0 }}>
          {[1, 0, 2].filter(i => ranking[i]).map(i => {
            const r = ranking[i];
            return (
              <li key={r.playerId} className={`podium-${i + 1}`} style={{ flex: 1, maxWidth: 160, minWidth: 0 }}>
                <Link to={statsLink(r.playerId)} style={{ display: 'block', maxWidth: 'none' }}>
                  <Avatar name={r.name} large style={{ border: `3px solid ${BORDER[i]}` }} />
                  <div className="podium-step">
                    <div aria-label={`Puesto ${i + 1}`}><Emoji>{MEDALS[i]}</Emoji></div>
                    <div className="strong small ellipsis">{r.name}</div>
                    <div className="strong small"><Money amount={value(r)} signed tone /></div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      {rest.length > 0 && (
        <div className="card">
          {rest.map((r, idx) => (
            <Link to={statsLink(r.playerId)} key={r.playerId} className="list-row" style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="muted num" style={{ width: 24 }}>{idx + (hasPodium ? 4 : 1)}</span>
              <Avatar name={r.name} />
              <span className="grow ellipsis">
                {r.name} {r.archived && <span className="badge badge-muted">Archivado</span>}
              </span>
              <Money amount={value(r)} signed tone className="strong" />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
