import type { ApiTableAction, ApiTableView } from '@pokercontrol/contracts';
import { evaluate, formatMoney, parseAmount } from '@pokercontrol/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError, api } from '../api';
import { EmptyCard, PlayerSeat, PokerCard } from '../components/poker';
import {
  Avatar, Btn, Emoji, Loading, Modal, QueryError, TextField, useAction, useFeedback,
} from '../components/ui';
import { useGroup } from '../context';
import { NickChooser } from './auth';

const HEARTBEAT_MS = 20_000;
const HAND_POLL_MS = 2_000;
const WAIT_POLL_MS = 3_000;

type Hand = NonNullable<ApiTableView['hand']>;

export function TablePage() {
  const { group } = useGroup();
  if (!group.playerId) {
    return (
      <>
        <div className="page-head"><h1 className="grow">Mesa</h1></div>
        <p className="muted" style={{ marginBottom: 16 }}>Elegí tu jugador para sentarte a la mesa.</p>
        <NickChooser />
      </>
    );
  }
  return <TableView />;
}

function TableView() {
  const { path, key, invalidate } = useGroup();
  const qc = useQueryClient();
  const { confirm } = useFeedback();
  const { busy, run } = useAction();
  const queryKey = key('table');
  const [standing, setStanding] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [closedId, setClosedId] = useState<string | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => api<ApiTableView>(path('/table')),
    refetchInterval: q => (q.state.data?.status === 'playing' ? HAND_POLL_MS : WAIT_POLL_MS),
    staleTime: 0,
  });
  const view = query.data;
  const me = view?.seats.find(s => s.isYou);

  /** Cada operación devuelve la mesa ya actualizada. */
  const post = async (suffix: string, body?: unknown, opts: { idempotent?: boolean; refresh?: boolean } = {}) => {
    const next = await api<ApiTableView>(path(`/table/${suffix}`), { method: 'POST', body, idempotent: opts.idempotent });
    qc.setQueryData(queryKey, next);
    if (opts.refresh) await invalidate();
    return next;
  };

  // Presencia: en la sala de espera se sienta solo al entrar; con partida en curso solo
  // renueva a quien ya está sentado (sumarse tiene costo: una nueva entrada).
  const canBeat = !!view && !standing && (view.status === 'waiting' || me?.status === 'sitting');
  const beat = useRef<() => void>(() => {});
  beat.current = () => {
    api<ApiTableView>(path('/table/join'), { method: 'POST' }).then(next => qc.setQueryData(queryKey, next)).catch(() => {});
  };
  useEffect(() => {
    if (!canBeat) return;
    beat.current();
    const id = setInterval(() => { if (document.visibilityState === 'visible') beat.current(); }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [canBeat]);

  if (query.isLoading) return <Loading />;
  if (query.error || !view) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;

  const join = () => { setStanding(false); void run(() => post('join', undefined, { refresh: true })); };
  const leave = () => { setStanding(true); void run(() => post('leave')); };
  const deal = () => run(() => post('deal'));
  const close = async () => {
    const ok = await confirm({
      title: '¿Cerrar la partida?',
      message: 'Las fichas de cada uno pasan a ser su resultado final y se generan las deudas. No se puede deshacer.',
      confirmLabel: 'Cerrar partida',
    });
    if (!ok) return;
    void run(async () => {
      const res = await api<{ sessionId: string; table: ApiTableView }>(path('/table/close'), { method: 'POST', idempotent: true });
      qc.setQueryData(queryKey, res.table);
      await invalidate();
      setClosedId(res.sessionId);
    });
  };

  return (
    <>
      <div className="page-head">
        <h1 className="grow">Mesa</h1>
        {view.status === 'playing' && <span className="badge badge-green">Partida en curso</span>}
      </div>
      {closedId && view.status === 'waiting' && (
        <div className="notice notice-ok" role="status">
          Partida cerrada. <Link to={`/sessions/${closedId}`}>Ver resultados y deudas</Link>
        </div>
      )}
      {view.status === 'waiting'
        ? <Waiting view={view} standing={standing} busy={busy} onJoin={join} onLeave={leave} onStart={() => setStartOpen(true)} />
        : <Playing view={view} busy={busy} onJoin={join} onDeal={deal} onClose={close}
          onAction={action => run(async () => {
            try {
              await post('action', { version: view.version, action });
            } catch (e) {
              // La mesa cambió mientras decidías: se muestra el estado nuevo, sin molestar.
              if (e instanceof ApiRequestError && e.code === 'stale_state') await query.refetch();
              else throw e;
            }
          })}
          onRebuy={() => run(() => post('rebuy', undefined, { idempotent: true }))} />}
      <StartModal view={view} open={startOpen} onClose={() => setStartOpen(false)}
        onStart={cfg => run(async () => {
          await post('start', cfg, { idempotent: true, refresh: true });
          setStartOpen(false);
          setClosedId(null);
        })} busy={busy} />
    </>
  );
}

// ─── Sala de espera ──────────────────────────────────────────────────────────
function Waiting({ view, standing, busy, onJoin, onLeave, onStart }: {
  view: ApiTableView; standing: boolean; busy: boolean; onJoin: () => void; onLeave: () => void; onStart: () => void;
}) {
  const present = view.seats.filter(s => s.online);
  const canStart = present.length >= 2 && present.some(s => s.isYou);
  return (
    <div className="card">
      <h2 style={{ marginBottom: 4 }}><Emoji>🃏</Emoji> Mesa del grupo</h2>
      <p className="muted small" style={{ marginBottom: 8 }}>
        Sin partida en curso. Cuando haya al menos 2 jugadores conectados se puede iniciar.
      </p>
      {view.seats.length === 0 && <p className="muted" style={{ padding: '12px 0' }}>Todavía no hay nadie sentado.</p>}
      {view.seats.map(s => (
        <div className="list-row" key={s.playerId}>
          <Avatar name={s.name} />
          <div className="grow"><strong>{s.isYou ? `${s.name} (vos)` : s.name}</strong></div>
          <span className={`badge ${s.online ? 'badge-green' : 'badge-muted'}`}>{s.online ? 'Conectado' : 'No conectado'}</span>
        </div>
      ))}
      <div className="stack" style={{ marginTop: 14 }}>
        <Btn block disabled={!canStart || standing} onClick={onStart}>Iniciar partida ({present.length} {present.length === 1 ? 'jugador' : 'jugadores'})</Btn>
        {standing
          ? <Btn variant="ghost" block busy={busy} onClick={onJoin}>Sentarme</Btn>
          : <Btn variant="ghost" block busy={busy} onClick={onLeave}>Levantarme</Btn>}
      </div>
      {!canStart && <p className="muted small center" style={{ marginTop: 10 }}>Los demás miembros pueden sumarse después de iniciar.</p>}
    </div>
  );
}

function StartModal({ view, open, onClose, onStart, busy }: {
  view: ApiTableView; open: boolean; onClose: () => void; busy: boolean;
  onStart: (cfg: { buyIn: number; smallBlind: number; bigBlind: number }) => void;
}) {
  const { notify } = useFeedback();
  const [buyIn, setBuyIn] = useState(String(view.buyIn));
  const [sb, setSb] = useState(String(view.smallBlind));
  const [bb, setBb] = useState(String(view.bigBlind));
  const submit = () => {
    const cfg = { buyIn: parseAmount(buyIn), smallBlind: parseAmount(sb), bigBlind: parseAmount(bb) };
    if ([cfg.buyIn, cfg.smallBlind, cfg.bigBlind].some(n => n === null || n <= 0 || !Number.isInteger(n))) {
      return notify('Ingresá montos enteros mayores a 0.');
    }
    onStart(cfg as { buyIn: number; smallBlind: number; bigBlind: number });
  };
  return (
    <Modal open={open} onClose={onClose} title="Iniciar partida"
      description="Se crea una partida con los jugadores conectados. Cada ficha vale $1 y la entrada se registra como compra.">
      <TextField label="Entrada por jugador" value={buyIn} onChange={setBuyIn} decimal />
      <div className="row">
        <TextField label="Ciega chica" value={sb} onChange={setSb} decimal />
        <TextField label="Ciega grande" value={bb} onChange={setBb} decimal />
      </div>
      <div className="modal-actions">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn busy={busy} onClick={submit}>Iniciar partida</Btn>
      </div>
    </Modal>
  );
}

// ─── Partida en curso ────────────────────────────────────────────────────────
function Playing({ view, busy, onJoin, onDeal, onClose, onAction, onRebuy }: {
  view: ApiTableView; busy: boolean; onJoin: () => void; onDeal: () => void; onClose: () => void;
  onAction: (a: ApiTableAction) => void; onRebuy: () => void;
}) {
  const me = view.seats.find(s => s.isYou);
  const hand = view.hand;
  const live = !!hand && hand.street !== 'done';
  const inHand = !!hand && hand.players.some(p => p.playerId === view.myPlayerId);
  const waitingSeats = view.seats.filter(s => !hand?.players.some(p => p.playerId === s.playerId));

  return (
    <>
      {hand && <Felt view={view} hand={hand} />}
      {hand && <Status view={view} hand={hand} />}
      {hand && inHand && <MyHand hand={hand} myId={view.myPlayerId as string} />}
      {live && hand?.legal && <Controls hand={hand} busy={busy} onAction={onAction} />}

      {waitingSeats.length > 0 && (
        <p className="muted small center" style={{ marginBottom: 12 }}>
          Esperan la próxima mano: {waitingSeats.map(s => `${s.isYou ? 'vos' : s.name} (${formatMoney(s.stack)}${s.status === 'out' ? ', afuera' : ''})`).join(', ')}
        </p>
      )}

      <div className="stack">
        {!live && me?.status === 'sitting' && (
          <Btn block busy={busy} onClick={onDeal}>{hand ? 'Repartir próxima mano' : 'Repartir'}</Btn>
        )}
        {!live && me && me.stack === 0 && (
          <Btn variant="ghost" block busy={busy} onClick={onRebuy}>Recomprar por {formatMoney(view.buyIn)}</Btn>
        )}
        {!me && <Btn variant="ghost" block busy={busy} onClick={onJoin}>Sumarme a la mesa por {formatMoney(view.buyIn)}</Btn>}
        {me?.status === 'out' && <Btn variant="ghost" block busy={busy} onClick={onJoin}>Volver a sentarme</Btn>}
        {me && !live && <Btn variant="danger" block busy={busy} onClick={onClose}>Cerrar partida</Btn>}
      </div>
    </>
  );
}

function Felt({ view, hand }: { view: ApiTableView; hand: Hand }) {
  const players = hand.players;
  const myIdx = Math.max(0, players.findIndex(p => p.playerId === view.myPlayerId));
  const showdown = hand.showdown.length > 0;
  return (
    <div className="felt-wrap">
      <div className="felt" data-testid="felt">
        <div className="felt-center">
          <div className="pot num" data-testid="pot">Pozo {formatMoney(hand.pot)}</div>
          <div className="board" role="group" aria-label="Cartas comunitarias">
            {Array.from({ length: 5 }, (_, i) => hand.board[i]
              ? <PokerCard key={i} card={hand.board[i]} />
              : <EmptyCard key={i} />)}
          </div>
        </div>
        {players.map((p, i) => (
          <PlayerSeat key={p.playerId} view={view} hand={hand} playerId={p.playerId}
            offset={(i - myIdx + players.length) % players.length} total={players.length}
            showCards={showdown && !p.hole.includes('??')} />
        ))}
      </div>
    </div>
  );
}

function nameOf(view: ApiTableView, id: string) {
  const s = view.seats.find(x => x.playerId === id);
  return s?.isYou ? 'Vos' : s?.name ?? 'Alguien';
}

function Status({ view, hand }: { view: ApiTableView; hand: Hand }) {
  let text: string;
  if (hand.street === 'done') {
    const parts = hand.payouts.map(w => {
      const hn = hand.showdown.find(s => s.playerId === w.playerId)?.handName;
      return `${nameOf(view, w.playerId)} ${w.playerId === view.myPlayerId ? 'ganaste' : 'ganó'} ${formatMoney(w.amount)}${hn ? ` con ${hn}` : ''}`;
    });
    text = parts.join(' · ') || 'Mano terminada.';
  } else if (hand.legal) {
    text = 'Es tu turno.';
  } else if (hand.toActPlayerId) {
    text = `Turno de ${nameOf(view, hand.toActPlayerId)}.`;
  } else {
    text = 'Repartiendo…';
  }
  return (
    <p className={`table-status ${hand.street === 'done' ? 'notice notice-ok' : 'notice notice-info'}`} role="status" aria-live="polite">
      <span className="xs muted">Mano {hand.handNo} · </span>{text}
    </p>
  );
}

function MyHand({ hand, myId }: { hand: Hand; myId: string }) {
  const me = hand.players.find(p => p.playerId === myId);
  if (!me || me.hole.length === 0 || me.hole.includes('??')) return null;
  const cards = [...me.hole, ...hand.board];
  const name = cards.length >= 5 ? evaluate(cards).name : null;
  return (
    <div className="hero" data-testid="my-hand">
      <div className="hero-cards">{me.hole.map((c, i) => <PokerCard key={i} card={c} size="lg" />)}</div>
      <p className="small muted center">
        Tus cartas · {formatMoney(me.stack)}{name ? ` · Tenés ${name.toLowerCase()}` : ''}{me.folded ? ' · Te retiraste' : ''}
      </p>
    </div>
  );
}

function Controls({ hand, busy, onAction }: { hand: Hand; busy: boolean; onAction: (a: ApiTableAction) => void }) {
  const legal = hand.legal;
  const [raising, setRaising] = useState(false);
  const [amount, setAmount] = useState('');
  const { notify } = useFeedback();
  if (!legal) return null;
  const me = hand.players.find(p => p.playerId === hand.toActPlayerId);
  const allInCall = !!me && legal.canCall && legal.callAmount >= me.stack;

  const submitRaise = () => {
    const to = parseAmount(amount);
    if (to === null || !Number.isInteger(to)) return notify('Ingresá un monto entero.');
    if (to < legal.minRaiseTo && to !== legal.maxRaiseTo) return notify(`La subida mínima es a ${formatMoney(legal.minRaiseTo)}.`);
    if (to > legal.maxRaiseTo) return notify(`No tenés fichas para tanto: máximo ${formatMoney(legal.maxRaiseTo)}.`);
    setRaising(false);
    onAction(to === legal.maxRaiseTo ? { type: 'allin' } : { type: 'raise', to });
  };
  const quick = [
    { label: 'Mínimo', to: legal.minRaiseTo },
    { label: '½ pozo', to: hand.currentBet + Math.round(hand.pot / 2) },
    { label: 'Pozo', to: hand.currentBet + hand.pot },
    { label: 'All-in', to: legal.maxRaiseTo },
  ].map(q => ({ ...q, to: Math.min(Math.max(q.to, legal.minRaiseTo), legal.maxRaiseTo) }));

  return (
    <div className="card controls" aria-label="Tus acciones">
      <div className="controls-row">
        <Btn variant="danger" busy={busy} onClick={() => onAction({ type: 'fold' })}>Retirarme</Btn>
        {legal.canCheck
          ? <Btn busy={busy} onClick={() => onAction({ type: 'check' })}>Pasar</Btn>
          : <Btn busy={busy} onClick={() => onAction({ type: 'call' })}>{allInCall ? 'All-in' : 'Igualar'} {formatMoney(legal.callAmount)}</Btn>}
        {legal.canRaise && (
          <Btn variant="ghost" busy={busy} aria-expanded={raising}
            onClick={() => { setRaising(r => !r); setAmount(String(legal.minRaiseTo)); }}>Subir</Btn>
        )}
      </div>
      {raising && legal.canRaise && (
        <div className="raise" style={{ marginTop: 12 }}>
          <div className="row-wrap" style={{ marginBottom: 8 }}>
            {quick.map(q => (
              <Btn key={q.label} variant="ghost" className="btn-chip" onClick={() => setAmount(String(q.to))}>{q.label}</Btn>
            ))}
          </div>
          <TextField label="Subir a" value={amount} onChange={setAmount} decimal />
          <Btn block onClick={submitRaise}>Confirmar subida</Btn>
        </div>
      )}
    </div>
  );
}

