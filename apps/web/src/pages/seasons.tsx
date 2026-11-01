import type { ApiPlayer, ApiSeason, ApiSession, ApiSessionSummary } from '@pokercontrol/contracts';
import { defaultSeasonName, formatMoney, parseAmount } from '@pokercontrol/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import {
  Btn, Emoji, Empty, Loading, Modal, Money, QueryError, TextField, useAction, useFeedback,
} from '../components/ui';
import { useGroup } from '../context';

const date = (iso: string) => new Date(iso).toLocaleDateString('es-AR');

export function SeasonsPage() {
  const { path, key, invalidate } = useGroup();
  const navigate = useNavigate();
  const { confirm } = useFeedback();
  const { busy, run } = useAction();
  const query = useQuery({ queryKey: key('seasons'), queryFn: () => api<ApiSeason[]>(path('/seasons')) });
  const [sortAsc, setSortAsc] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<ApiSeason | null>(null);
  const [renameValue, setRenameValue] = useState('');

  if (query.isLoading) return <Loading />;
  if (query.error) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;
  const seasons = query.data ?? [];
  const active = seasons.find(s => s.status === 'active');
  const list = sortAsc ? [...seasons].reverse() : seasons;

  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await invalidate(); });

  const close = async (s: ApiSeason) => {
    const warning = s.openSessionCount > 0
      ? `\n\n⚠️ Hay ${s.openSessionCount} partida${s.openSessionCount === 1 ? '' : 's'} sin cerrar en esta temporada; vas a poder seguir cerrándolas después.`
      : '';
    const ok = await confirm({
      title: 'Cerrar temporada', danger: true, confirmLabel: 'Cerrar',
      message: `¿Cerrar "${s.name}"? No va a quedar ninguna temporada activa hasta que crees o reabras otra.${warning}`,
    });
    if (ok) void act(() => api(path(`/seasons/${s.id}/close`), { method: 'POST' }));
  };
  const reopen = async (s: ApiSeason) => {
    const ok = await confirm({
      title: 'Reabrir temporada', confirmLabel: 'Reabrir',
      message: `"${s.name}" va a pasar a ser la temporada activa${active ? ` y se va a cerrar "${active.name}"` : ''}.`,
    });
    if (ok) void act(() => api(path(`/seasons/${s.id}/reopen`), { method: 'POST' }));
  };
  const remove = async (s: ApiSeason) => {
    const ok = await confirm({
      title: 'Borrar temporada', danger: true, confirmLabel: 'Borrar',
      message: `¿Borrar "${s.name}"? Esta acción no se puede deshacer.`,
    });
    if (ok) void act(() => api(path(`/seasons/${s.id}`), { method: 'DELETE' }));
  };

  return (
    <>
      <div className="page-head">
        <h1 className="grow">Temporadas</h1>
        <Btn onClick={() => { setName(defaultSeasonName(seasons.length)); setCreating(true); }}>+ Nueva temporada</Btn>
      </div>

      {seasons.length > 1 && (
        <Btn variant="text" onClick={() => setSortAsc(v => !v)} style={{ marginBottom: 8 }}>
          {sortAsc ? '↑ Más antiguas primero' : '↓ Más nuevas primero'}
        </Btn>
      )}

      {list.length === 0 && (
        <Empty icon="♠" title="No hay temporadas aún"><p>Creá la primera para empezar a cargar partidas.</p></Empty>
      )}

      <div className="grid-2">
        {list.map(s => (
          <div className="card" key={s.id} data-testid={`season-${s.name}`}>
            <div className="row-between">
              <Link to={`/seasons/${s.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none' }}>
                <h3>{s.name}</h3>
              </Link>
              <span className={`badge ${s.status === 'active' ? 'badge-green' : 'badge-muted'}`}>
                {s.status === 'active' ? '● Activa' : 'Cerrada'}
              </span>
            </div>
            <p className="small muted">
              {date(s.createdAt)} – {s.closedAt ? date(s.closedAt) : 'en curso'} · {s.sessionCount} partida{s.sessionCount === 1 ? '' : 's'}
            </p>
            {s.leader && (
              <p className="small" style={{ marginTop: 4 }}>
                <Emoji>🏆</Emoji> {s.leader.name} <Money amount={s.leader.sessionBalance} signed tone />
              </p>
            )}
            <div className="row-wrap" style={{ marginTop: 8 }}>
              <Link className="btn btn-ghost" to={`/seasons/${s.id}`}>Ver partidas</Link>
              <button type="button" className="icon-btn" aria-label={`Renombrar ${s.name}`}
                onClick={() => { setRenaming(s); setRenameValue(s.name); }}><Emoji>✏️</Emoji></button>
              {s.status === 'active' && (
                <button type="button" className="icon-btn" aria-label={`Cerrar ${s.name}`} onClick={() => { void close(s); }}><Emoji>🔒</Emoji></button>
              )}
              {s.status === 'closed' && (
                <button type="button" className="icon-btn" aria-label={`Reabrir ${s.name}`} onClick={() => { void reopen(s); }}><Emoji>↺</Emoji></button>
              )}
              {s.sessionCount === 0 && (
                <button type="button" className="icon-btn" aria-label={`Borrar ${s.name}`} onClick={() => { void remove(s); }}><Emoji>🗑</Emoji></button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Nueva temporada"
        description={active ? `Se va a cerrar "${active.name}".` : undefined}>
        <form onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            const created = await api<ApiSeason>(path('/seasons'), { method: 'POST', body: { name } });
            await invalidate();
            setCreating(false);
            navigate(`/seasons/${created.id}`);
          });
        }}>
          <TextField label="Nombre" value={name} onChange={setName} autoFocus maxLength={120} />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setCreating(false)}>Cancelar</Btn>
            <Btn type="submit" busy={busy}>Crear</Btn>
          </div>
        </form>
      </Modal>

      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="Renombrar temporada">
        <form onSubmit={e => {
          e.preventDefault();
          if (!renaming) return;
          void act(() => api(path(`/seasons/${renaming.id}`), { method: 'PATCH', body: { name: renameValue } }))
            .then(() => setRenaming(null));
        }}>
          <TextField label="Nombre" value={renameValue} onChange={setRenameValue} autoFocus maxLength={120} />
          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setRenaming(null)}>Cancelar</Btn>
            <Btn type="submit" busy={busy} disabled={!renameValue.trim()}>Guardar</Btn>
          </div>
        </form>
      </Modal>
    </>
  );
}

function defaultPartyName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Party ${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear()).slice(2)}`;
}

export function SeasonSessionsPage() {
  const { seasonId = '' } = useParams();
  const { path, key, invalidate } = useGroup();
  const navigate = useNavigate();
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const seasons = useQuery({ queryKey: key('seasons'), queryFn: () => api<ApiSeason[]>(path('/seasons')) });
  const query = useQuery({
    queryKey: key('sessions', seasonId),
    queryFn: () => api<ApiSessionSummary[]>(path(`/seasons/${seasonId}/sessions`)),
  });
  const [open, setOpen] = useState(false);
  const players = useQuery({
    queryKey: key('players'),
    queryFn: () => api<ApiPlayer[]>(path('/players')),
    enabled: open,
  });
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const season = seasons.data?.find(s => s.id === seasonId);

  const parsed = parseAmount(amount);
  const total = useMemo(() => (parsed ?? 0) * selected.size, [parsed, selected]);

  if (query.isLoading) return <Loading />;
  if (query.error) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;
  if (seasons.data && !season) {
    return <Empty icon="🔍" title="Temporada no encontrada"><p><Link to="/seasons">Volver a temporadas</Link></p></Empty>;
  }
  const sessions = query.data ?? [];

  const remove = async (s: ApiSessionSummary) => {
    const ok = await confirm({ title: 'Eliminar partida', message: `¿Eliminar "${s.name}"?`, danger: true, confirmLabel: 'Eliminar' });
    if (ok) {
      void run(async () => {
        await api(path(`/sessions/${s.id}`), { method: 'DELETE' });
        await invalidate();
      });
    }
  };

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const create = () => {
    if (selected.size > 0 && (parsed === null || parsed <= 0)) return notify('Ingresá un monto inicial válido.');
    void run(async () => {
      const created = await api<ApiSession>(path(`/seasons/${seasonId}/sessions`), {
        method: 'POST',
        idempotent: true,
        body: { name: name.trim(), playerIds: [...selected], ...(selected.size > 0 ? { initialBuyIn: parsed } : {}) },
      });
      await invalidate();
      navigate(`/sessions/${created.id}`);
    });
  };

  return (
    <>
      <Link className="breadcrumb" to="/seasons">← Temporadas</Link>
      <div className="page-head">
        <h1 className="grow">{season?.name ?? 'Partidas'}</h1>
        <Link className="btn btn-ghost" to={`/ranking?seasonId=${seasonId}`}><Emoji>🏆</Emoji> Ranking</Link>
        <Btn onClick={() => { setName(defaultPartyName()); setAmount(''); setSelected(new Set()); setOpen(true); }}>+ Nueva partida</Btn>
      </div>

      {sessions.length === 0 && <Empty icon="🃏" title="No hay partidas aún"><p>Creá la primera con “Nueva partida”.</p></Empty>}

      <div className="grid-2">
        {sessions.map(s => (
          <div className="card row" key={s.id} data-testid={`session-${s.name}`}>
            <Link to={`/sessions/${s.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none', minWidth: 0 }}>
              <div className="row-between">
                <h3 className="ellipsis">{s.name}</h3>
                <span className={`badge ${s.status === 'active' ? 'badge-green' : 'badge-muted'}`}>
                  {s.status === 'active' ? 'Activa' : 'Cerrada'}
                </span>
              </div>
              <p className="small muted">
                {date(s.createdAt)} · {s.playerCount} jugador{s.playerCount === 1 ? '' : 'es'} · <span className="money">{formatMoney(s.pot)}</span>
              </p>
            </Link>
            <button type="button" className="icon-btn" aria-label={`Eliminar ${s.name}`} onClick={() => { void remove(s); }}><Emoji>🗑</Emoji></button>
          </div>
        ))}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Nueva partida">
        <TextField label="Nombre" value={name} onChange={setName} maxLength={120} />
        <TextField label="Compra inicial por jugador" value={amount} onChange={setAmount} decimal placeholder="Ej: 20000" />
        <div className="row-between">
          <span className="strong small">Jugadores</span>
          <span>
            <Btn variant="text" onClick={() => setSelected(new Set(players.data?.map(p => p.id)))}>Todos</Btn>
            <Btn variant="text" onClick={() => setSelected(new Set())}>Ninguno</Btn>
          </span>
        </div>
        {players.data?.length === 0 && (
          <p className="muted small">Creá jugadores en <Link to="/players">Jugadores</Link> primero.</p>
        )}
        {players.data?.map(p => (
          <label className="check-row" key={p.id}>
            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
            {p.name}
          </label>
        ))}
        {selected.size > 0 && parsed !== null && parsed > 0 && (
          <p className="small muted" style={{ marginTop: 8 }}>
            Pozo inicial: <Money amount={total} className="strong" /> ({selected.size} × {formatMoney(parsed)})
          </p>
        )}
        <div className="modal-actions">
          <Btn variant="ghost" onClick={() => setOpen(false)}>Cancelar</Btn>
          <Btn onClick={create} busy={busy}>Crear partida</Btn>
        </div>
      </Modal>
    </>
  );
}
