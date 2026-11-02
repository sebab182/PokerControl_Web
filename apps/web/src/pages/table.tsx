import type { ApiPlayer, ApiRtcServerMessage, ApiTableAction, ApiTableView } from '@pokercontrol/contracts';
import { evaluate, formatMoney, parseAmount } from '@pokercontrol/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError, api } from '../api';
import { EmptyCard, PlayerSeat, PokerCard, cardText, seatPosition } from '../components/poker';
import {
  Avatar, Btn, Emoji, Loading, Modal, QueryError, TextField, useAction, useFeedback,
} from '../components/ui';
import { useGroup } from '../context';
import { useTableSocket } from '../useTableSocket';
import { VideoControls, VideoProvider, useTableVideo } from '../video';
import { NickChooser } from './auth';

const HEARTBEAT_MS = 20_000;
const HAND_POLL_MS = 2_000;
const WAIT_POLL_MS = 3_000;
/** Con el socket en vivo, el polling queda como red de seguridad (y renueva quién está conectado). */
const LIVE_POLL_MS = 15_000;

type Hand = NonNullable<ApiTableView['hand']>;

/** Celular en horizontal: la mesa ocupa toda la pantalla y se oculta el menú (clase en <html>, ver styles.css). */
const LANDSCAPE = '(orientation: landscape) and (max-height: 600px) and (pointer: coarse)';

function useLandscapeTable(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const mq = window.matchMedia(LANDSCAPE);
    const touch = window.matchMedia('(pointer: coarse)');
    const root = document.documentElement;
    let asked = false;
    const apply = () => {
      // table-active: celular o tablet, la mesa llena el alto; table-landscape: además horizontal y a pantalla completa.
      root.classList.toggle('table-active', touch.matches);
      root.classList.toggle('table-landscape', mq.matches);
      if (!mq.matches) {
        asked = false;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      }
    };
    // El navegador solo permite pantalla completa tras un toque: se pide una vez por cada vez que se gira.
    const onTap = () => {
      if (!mq.matches || asked || document.fullscreenElement) return;
      asked = true;
      void root.requestFullscreen?.().catch(() => {});
    };
    apply();
    mq.addEventListener('change', apply);
    window.addEventListener('click', onTap);
    return () => {
      mq.removeEventListener('change', apply);
      window.removeEventListener('click', onTap);
      root.classList.remove('table-active', 'table-landscape');
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [active]);
}

/** Solo se ve con la mesa en horizontal: entra o sale de pantalla completa. */
function FullscreenButton() {
  const toggle = () => {
    const root = document.documentElement;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.requestFullscreen?.().catch(() => {});
  };
  return <button type="button" className="fs-btn" aria-label="Pantalla completa" onClick={toggle}>⛶</button>;
}

export function TablePage() {
  const { group, canEdit } = useGroup();
  // Un administrador puede manejar la mesa sin tener jugador propio.
  if (!group.playerId && !canEdit) {
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
  const { group, canEdit, path, key, invalidate } = useGroup();
  const qc = useQueryClient();
  const { confirm } = useFeedback();
  const { busy, run } = useAction();
  const queryKey = key('table');
  const [standing, setStanding] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [closedId, setClosedId] = useState<string | null>(null);

  // Cualquier aviso refresca la mesa. No se compara la versión: sentarse o levantarse cambia lo que
  // se ve sin cambiar la versión de la mano (que solo protege las jugadas). Un GET repetido sale barato.
  // El socket necesita el manejador de video y el video necesita el socket: se une por ref.
  const signal = useRef<(msg: ApiRtcServerMessage) => void>(() => {});
  const socket = useTableSocket(group.id, () => { void qc.invalidateQueries({ queryKey }); }, msg => signal.current(msg));
  const { live } = socket;
  const video = useTableVideo(socket, group.playerId);
  signal.current = video.onSignal;
  const query = useQuery({
    queryKey,
    queryFn: () => api<ApiTableView>(path('/table')),
    refetchInterval: q => (live ? LIVE_POLL_MS : q.state.data?.status === 'playing' ? HAND_POLL_MS : WAIT_POLL_MS),
    staleTime: 0,
  });
  const view = query.data;
  const me = view?.seats.find(s => s.isYou);

  // Con la pestaña en segundo plano, el título avisa cuando te toca.
  const myTurn = !!view?.hand?.legal;
  useEffect(() => {
    if (!myTurn) return;
    const original = document.title;
    document.title = '🃏 Tu turno · ' + original;
    return () => { document.title = original; };
  }, [myTurn]);

  useLandscapeTable(view?.status === 'playing' && !!view.hand);

  /** Cada operación devuelve la mesa ya actualizada. */
  const post = async (suffix: string, body?: unknown, opts: { idempotent?: boolean; refresh?: boolean } = {}) => {
    const next = await api<ApiTableView>(path(`/table/${suffix}`), { method: 'POST', body, idempotent: opts.idempotent });
    qc.setQueryData(queryKey, next);
    if (opts.refresh) await invalidate();
    return next;
  };

  // Presencia: en la sala de espera se sienta solo al entrar; con partida en curso solo
  // renueva a quien ya está sentado (sumarse tiene costo: una nueva entrada).
  const canBeat = !!view && !!group.playerId && !standing && (view.status === 'waiting' || me?.status === 'sitting');
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
  const admin = {
    add: (playerId: string) => run(async () => { await post(`seats/${playerId}`, undefined, { refresh: true }); }),
    remove: (playerId: string) => run(async () => {
      const next = await api<ApiTableView>(path(`/table/seats/${playerId}`), { method: 'DELETE' });
      qc.setQueryData(queryKey, next);
    }),
    rebuy: (playerId: string) => run(async () => { await post(`seats/${playerId}/rebuy`, {}, { idempotent: true }); }),
  };
  const close = async () => {
    const ok = await confirm({
      title: '¿Cerrar la partida?',
      message: 'Las fichas de cada uno pasan a ser su resultado final y se suman a los saldos. No se puede deshacer.',
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
    <VideoProvider state={video.state}>
      {view.status === 'playing' && view.hand && <FullscreenButton />}
      <div className="page-head">
        <h1 className="grow">Mesa</h1>
        {live && <span className="badge badge-muted" title="Recibís los cambios al instante">En vivo</span>}
        {view.status === 'playing' && <span className="badge badge-green">Partida en curso</span>}
      </div>
      {!(view.status === 'playing' && view.hand) && <VideoControls />}
      {closedId && view.status === 'waiting' && (
        <div className="notice notice-ok" role="status">
          Partida cerrada. <Link to={`/sessions/${closedId}`}>Ver resultados y saldos</Link>
        </div>
      )}
      {view.status === 'waiting'
        ? <Waiting view={view} canEdit={canEdit} standing={standing} busy={busy} onJoin={join} onLeave={leave} onStart={() => setStartOpen(true)} />
        : <Playing view={view} canEdit={canEdit} updatedAt={query.dataUpdatedAt} busy={busy} onJoin={join} onLeave={leave} onDeal={deal} onClose={close}
          onReveal={(playerId, cards) => run(() => post('reveal', {
            ...(cards ? { cards } : {}), ...(playerId !== view.myPlayerId ? { playerId } : {}),
          }))}
          onAction={action => run(async () => {
            try {
              // Si el turno es de un jugador sin usuario que manejás, se juega por él.
              const acting = view.hand?.actingPlayerId;
              await post('action', { version: view.version, action, ...(acting && acting !== view.myPlayerId ? { playerId: acting } : {}) });
            } catch (e) {
              // La mesa cambió mientras decidías: se muestra el estado nuevo, sin molestar.
              if (e instanceof ApiRequestError && e.code === 'stale_state') await query.refetch();
              else throw e;
            }
          })}
          onRebuy={amount => run(() => post('rebuy', { amount }, { idempotent: true }))} />}
      {canEdit && !group.playerId && (
        <details className="card" style={{ marginTop: 16 }}>
          <summary className="strong" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Quiero jugar yo también</summary>
          <p className="muted small" style={{ margin: '4px 0 12px' }}>Elegí tu jugador para sentarte a la mesa como cualquier otro miembro.</p>
          <NickChooser />
        </details>
      )}
      {canEdit && <AdminSeats view={view} busy={busy} onAddOpen={() => setAddOpen(true)} {...admin} />}
      {canEdit && <AddPlayerModal view={view} open={addOpen} onClose={() => setAddOpen(false)} busy={busy} onAdd={admin.add} />}
      <StartModal view={view} open={startOpen} onClose={() => setStartOpen(false)}
        onStart={cfg => run(async () => {
          await post('start', cfg, { idempotent: true, refresh: true });
          setStartOpen(false);
          setClosedId(null);
        })} busy={busy} />
    </VideoProvider>
  );
}

// ─── Sala de espera ──────────────────────────────────────────────────────────
function Waiting({ view, canEdit, standing, busy, onJoin, onLeave, onStart }: {
  view: ApiTableView; canEdit: boolean; standing: boolean; busy: boolean; onJoin: () => void; onLeave: () => void; onStart: () => void;
}) {
  const present = view.seats.filter(s => s.online);
  const canStart = present.length >= 2 && (canEdit || present.some(s => s.isYou));
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
        <Btn block disabled={!canStart || (standing && !canEdit)} onClick={onStart}>Iniciar partida ({present.length} {present.length === 1 ? 'jugador' : 'jugadores'})</Btn>
        {view.myPlayerId && (standing
          ? <Btn variant="ghost" block busy={busy} onClick={onJoin}>Sentarme</Btn>
          : <Btn variant="ghost" block busy={busy} onClick={onLeave}>Levantarme</Btn>)}
      </div>
      {!canStart && <p className="muted small center" style={{ marginTop: 10 }}>Los demás miembros pueden sumarse después de iniciar.</p>}
    </div>
  );
}

function StartModal({ view, open, onClose, onStart, busy }: {
  view: ApiTableView; open: boolean; onClose: () => void; busy: boolean;
  onStart: (cfg: { buyIn: number; smallBlind: number; bigBlind: number; turnSeconds: number }) => void;
}) {
  const [error, setError] = useState('');
  const [buyIn, setBuyIn] = useState(String(view.buyIn));
  const [sb, setSb] = useState(String(view.smallBlind));
  const [bb, setBb] = useState(String(view.bigBlind));
  const [turn, setTurn] = useState(String(view.turnSeconds));
  const submit = () => {
    const cfg = { buyIn: parseAmount(buyIn), smallBlind: parseAmount(sb), bigBlind: parseAmount(bb) };
    if ([cfg.buyIn, cfg.smallBlind, cfg.bigBlind].some(n => n === null || n <= 0 || !Number.isInteger(n))) {
      return setError('Ingresá montos enteros mayores a 0.');
    }
    const turnSeconds = parseAmount(turn);
    if (turnSeconds === null || !Number.isInteger(turnSeconds) || (turnSeconds !== 0 && (turnSeconds < 10 || turnSeconds > 300))) {
      return setError('El tiempo por turno es 0 (sin límite) o entre 10 y 300 segundos.');
    }
    setError('');
    onStart({ ...cfg, turnSeconds } as { buyIn: number; smallBlind: number; bigBlind: number; turnSeconds: number });
  };
  return (
    <Modal open={open} onClose={onClose} title="Iniciar partida"
      description="Se crea una partida con los jugadores conectados. Cada ficha vale $1 y la entrada se registra como compra.">
      <TextField label="Entrada por jugador" value={buyIn} onChange={setBuyIn} decimal />
      <div className="row">
        <TextField label="Ciega chica" value={sb} onChange={setSb} decimal />
        <TextField label="Ciega grande" value={bb} onChange={setBb} decimal />
      </div>
      <TextField label="Tiempo por turno (segundos, 0 = sin límite)" value={turn} onChange={setTurn} decimal />
      {error && <p className="notice notice-err" role="alert">{error}</p>}
      <div className="modal-actions">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn busy={busy} onClick={submit}>Iniciar partida</Btn>
      </div>
    </Modal>
  );
}

// ─── Partida en curso ────────────────────────────────────────────────────────
function Playing({ view, canEdit, updatedAt, busy, onJoin, onLeave, onDeal, onClose, onAction, onRebuy, onReveal }: {
  view: ApiTableView; canEdit: boolean; updatedAt: number; busy: boolean; onJoin: () => void; onLeave: () => void; onDeal: () => void;
  onClose: () => void; onAction: (a: ApiTableAction) => void; onRebuy: (amount: number) => void;
  onReveal: (playerId: string, cards?: number[]) => void;
}) {
  const me = view.seats.find(s => s.isYou);
  const hand = view.hand;
  const live = !!hand && hand.street !== 'done';
  // Sin fichas se puede recomprar entre manos o si ya te retiraste de la que está en juego.
  const myPlayer = hand?.players.find(p => p.playerId === me?.playerId);
  const canRebuy = !!me && me.stack === 0 && (!live || !myPlayer || myPlayer.folded);
  const mine = view.seats.filter(s => s.isYou || s.managed);
  const canDeal = !live && (me?.status === 'sitting' || canEdit);
  // Mis cartas y mis controles (y los de los jugadores que manejo) van al costado de cada asiento, fuera de la mesa.
  const global = (
    <>
      {canDeal && <Btn busy={busy} onClick={onDeal}>Repartir próxima mano</Btn>}
      {canRebuy && me && <NoChips view={view} sitting={me.status === 'sitting'} busy={busy} onLeave={onLeave} onRebuy={onRebuy} />}
      <VideoControls compact />
    </>
  );
  const aside: Record<string, { cards: ReactNode; controls: ReactNode }> = {};
  if (hand) {
    for (const s of mine) {
      if (!hand.players.some(p => p.playerId === s.playerId)) continue;
      aside[s.playerId] = {
        cards: <HoleCards hand={hand} playerId={s.playerId} you={s.isYou} />,
        controls: (
          <>
            {live && hand.legal && hand.actingPlayerId === s.playerId && <Controls hand={hand} busy={busy} onAction={onAction} />}
            {hand.street === 'done' && <ShowCards hand={hand} playerId={s.playerId} you={s.isYou} name={s.name} busy={busy} onReveal={onReveal} />}
            {s.isYou && global}
          </>
        ),
      };
    }
  }
  // Sin asiento propio en esta mano (recién llegado, o administrador sin jugador): los controles van debajo de la mesa.
  const loose = hand && !(me && aside[me.playerId]) ? global : null;
  const waitingSeats = view.seats.filter(s => !hand?.players.some(p => p.playerId === s.playerId));

  return (
    <>
      {hand && <Felt view={view} hand={hand} aside={aside} />}
      {loose && <div className="dock-row">{loose}</div>}
      {hand && <Status view={view} hand={hand} updatedAt={updatedAt} />}

      {waitingSeats.length > 0 && (
        <p className="muted small center" style={{ marginBottom: 12 }}>
          Esperan la próxima mano: {waitingSeats.map(s => `${s.isYou ? 'vos' : s.name} (${formatMoney(s.stack)}${s.status === 'out' ? ', afuera' : ''})`).join(', ')}
        </p>
      )}

      <div className="stack">
        {!hand && canDeal && <Btn block busy={busy} onClick={onDeal}>Repartir</Btn>}
        {!me && view.myPlayerId && <Btn variant="ghost" block busy={busy} onClick={onJoin}>Sumarme a la mesa por {formatMoney(view.buyIn)}</Btn>}
        {me?.status === 'out' && <Btn variant="ghost" block busy={busy} onClick={onJoin}>Volver a sentarme</Btn>}
        {(me || canEdit) && !live && <Btn variant="danger" block busy={busy} onClick={onClose}>Cerrar partida</Btn>}
      </div>
    </>
  );
}

/** Sin saldo: levantarse o recomprar hasta la mitad de lo que tiene quien más fichas tiene. */
function NoChips({ view, sitting, busy, onLeave, onRebuy }: {
  view: ApiTableView; sitting: boolean; busy: boolean; onLeave: () => void; onRebuy: (amount: number) => void;
}) {
  const { notify } = useFeedback();
  const max = view.maxRebuy;
  const [text, setText] = useState<string | null>(null);
  const value = text ?? String(Math.min(view.buyIn, max));
  const submit = () => {
    const amount = parseAmount(value);
    if (amount === null || !Number.isInteger(amount) || amount < 1) return notify('Ingresá un monto entero mayor a 0.');
    if (amount > max) return notify(`Podés recomprar hasta ${formatMoney(max)}.`);
    onRebuy(amount);
    setText(null);
  };
  return (
    <section className="dock-box" aria-labelledby="no-chips" data-testid="no-chips">
      <h2 id="no-chips" className="dock-title">Sin saldo</h2>
      {max >= 1 ? (
        <>
          <p className="xs muted" style={{ marginBottom: 4 }}>Hasta {formatMoney(max)} (la mitad del que más tiene).</p>
          <TextField label="Fichas a recomprar" value={value} onChange={setText} decimal />
          <Btn variant="ghost" className="btn-chip" onClick={() => setText(String(max))}>Máximo</Btn>
          <Btn busy={busy} onClick={submit}>Recomprar</Btn>
        </>
      ) : <p className="xs muted">No hay fichas para recomprar.</p>}
      {sitting && <Btn variant="ghost" busy={busy} onClick={onLeave}>Levantarme</Btn>}
    </section>
  );
}

/** Al terminar la mano, hasta que se reparta la próxima: mostrar las cartas o foldear (no mostrarlas). Una sola carta, si todos los demás se retiraron. */
function ShowCards({ hand, playerId, you, name, busy, onReveal }: {
  hand: Hand; playerId: string; you: boolean; name: string; busy: boolean; onReveal: (playerId: string, cards?: number[]) => void;
}) {
  // Foldear = no mostrar: se oculta el panel hasta la próxima mano (las cartas siguen ocultas para los demás).
  const [mucked, setMucked] = useState(0);
  const p = hand.players.find(x => x.playerId === playerId);
  if (!p || p.hole.length < 2 || p.hole.includes('??') || p.shown.length >= 2 || mucked === hand.handNo) return null;
  // Quedó solo porque los demás se retiraron: no hay showdown y decide qué enseñar.
  const alone = hand.showdown.length === 0 && !p.folded && hand.players.filter(x => !x.folded).length === 1;
  return (
    <div className="dock-box" data-testid="show-cards">
      <div className="dock-actions">
        <Btn variant="ghost" busy={busy} onClick={() => onReveal(playerId)}>
          {you ? 'Mostrar mis cartas' : `Mostrar cartas de ${name}`}
        </Btn>
        {alone && p.hole.map((c, i) => !p.shown.includes(i) && (
          <Btn key={i} variant="ghost" busy={busy} aria-label={`Mostrar una carta: ${cardText(c)}`} onClick={() => onReveal(playerId, [i])}>
            Mostrar una carta ({cardText(c)})
          </Btn>
        ))}
        <Btn variant="danger" busy={busy} onClick={() => setMucked(hand.handNo)}>Foldear</Btn>
      </div>
    </div>
  );
}

function Felt({ view, hand, aside }: { view: ApiTableView; hand: Hand; aside: Record<string, { cards: ReactNode; controls: ReactNode }> }) {
  const players = hand.players;
  const myIdx = Math.max(0, players.findIndex(p => p.playerId === view.myPlayerId));
  return (
    <div className="felt-wrap">
      <div className="felt" data-testid="felt">
        <div className="felt-center">
          <div className="pot num" data-testid="pot">Pozo {formatMoney(hand.pot)}</div>
          {/* Vertical: flop arriba y turn + river abajo. Horizontal: en línea, separados 3 | 1 | 1. */}
          <div className="board" role="group" aria-label="Cartas comunitarias">
            <div className="board-row">
              {[0, 1, 2].map(i => hand.board[i] ? <PokerCard key={i} card={hand.board[i]} /> : <EmptyCard key={i} />)}
            </div>
            <div className="board-row">
              {[3, 4].map(i => hand.board[i] ? <PokerCard key={i} card={hand.board[i]} /> : <EmptyCard key={i} />)}
            </div>
          </div>
        </div>
        {players.map((p, i) => {
          const offset = (i - myIdx + players.length) % players.length;
          const a = aside[p.playerId];
          return (
            <Fragment key={p.playerId}>
              <PlayerSeat view={view} hand={hand} playerId={p.playerId} offset={offset} total={players.length} />
              {a && <SeatAside offset={offset} total={players.length} cards={a.cards} controls={a.controls} />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Cartas y controles de un asiento propio, pegados a él. Arriba y abajo van a sus costados (cartas
 * hacia afuera, controles hacia el otro lado); en los laterales de la mesa, debajo del asiento.
 */
function SeatAside({ offset, total, cards, controls }: { offset: number; total: number; cards: ReactNode; controls: ReactNode }) {
  const pos = seatPosition(offset, total);
  const cos = Math.cos(Math.PI / 2 + (offset * 2 * Math.PI) / total);
  if (Math.abs(cos) < 0.5) {
    return (
      <>
        <div className="aside aside-cards" style={pos}>{cards}</div>
        <div className="aside aside-ctl" style={pos}>{controls}</div>
      </>
    );
  }
  return <div className={`aside aside-below ${cos < 0 ? 'aside-below-left' : 'aside-below-right'}`} style={pos}>{cards}{controls}</div>;
}

/** Cuenta regresiva del turno. Se calcula contra la hora del servidor, no la del reloj del dispositivo. */
function TurnTimer({ view, updatedAt }: { view: ApiTableView; updatedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view.turnDeadline) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [view.turnDeadline]);
  if (!view.turnDeadline) return null;
  const skew = Date.parse(view.serverTime) - updatedAt;
  const left = Math.max(0, Math.ceil((Date.parse(view.turnDeadline) - (now + skew)) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <span role="timer" className={`turn-timer ${left <= 10 ? 'strong' : ''}`} data-testid="turn-timer">
      {' '}· <Emoji>⏱</Emoji> {left > 0 ? clock : 'Tiempo agotado…'}
    </span>
  );
}

function nameOf(view: ApiTableView, id: string) {
  const s = view.seats.find(x => x.playerId === id);
  return s?.isYou ? 'Vos' : s?.name ?? 'Alguien';
}

/** "Nico igualó $40", "Vos subiste a $100"… */
function describeLast(view: ApiTableView, la: NonNullable<Hand['lastAction']>): string {
  const you = la.playerId === view.myPlayerId;
  const who = nameOf(view, la.playerId);
  const money = la.amount !== undefined ? formatMoney(la.amount) : '';
  const verbs: Record<typeof la.type, [string, string]> = {
    fold: ['te retiraste', 'se retiró'],
    check: ['pasaste', 'pasó'],
    call: [`igualaste ${money}`, `igualó ${money}`],
    raise: [`subiste a ${money}`, `subió a ${money}`],
    allin: [`fuiste all-in por ${money}`, `fue all-in por ${money}`],
  };
  return `${you ? 'Vos' : who} ${verbs[la.type][you ? 0 : 1]}${la.auto ? ' (tiempo agotado)' : ''}`;
}

function Status({ view, hand, updatedAt }: { view: ApiTableView; hand: Hand; updatedAt: number }) {
  let text: string;
  if (hand.street === 'done') {
    const parts = hand.payouts.map(w => {
      const hn = hand.showdown.find(s => s.playerId === w.playerId)?.handName;
      return `${nameOf(view, w.playerId)} ${w.playerId === view.myPlayerId ? 'ganaste' : 'ganó'} ${formatMoney(w.amount)}${hn ? ` con ${hn}` : ''}`;
    });
    text = parts.join(' · ') || 'Mano terminada.';
  } else if (hand.legal) {
    text = hand.actingPlayerId === view.myPlayerId ? 'Es tu turno.' : `Te toca jugar por ${nameOf(view, hand.actingPlayerId as string)}.`;
  } else if (hand.toActPlayerId) {
    text = `Turno de ${nameOf(view, hand.toActPlayerId)}.`;
  } else {
    text = 'Repartiendo…';
  }
  return (
    <p className={`table-status ${hand.street === 'done' ? 'notice notice-ok' : 'notice notice-info'}`} role="status" aria-live="polite">
      <span className="xs muted">Mano {hand.handNo} · </span>{text}
      {hand.street !== 'done' && <TurnTimer view={view} updatedAt={updatedAt} />}
      {hand.lastAction && <span className="last-action" data-testid="last-action"> · {describeLast(view, hand.lastAction)}.</span>}
    </p>
  );
}

/** Mis cartas (o las de un jugador que manejo) junto al asiento. Las que ya se mostraron pasan a la mesa. */
function HoleCards({ hand, playerId, you }: { hand: Hand; playerId: string; you: boolean }) {
  const p = hand.players.find(x => x.playerId === playerId);
  if (!p || p.hole.length === 0 || p.hole.includes('??')) return null;
  const hidden = p.hole.map((card, i) => ({ card, i })).filter(x => !p.shown.includes(x.i));
  if (hidden.length === 0) return null;
  const cards = [...p.hole, ...hand.board];
  const name = cards.length >= 5 ? evaluate(cards).name : null;
  return (
    <div className="aside-hand" data-testid="my-hand">
      <div className="hole">{hidden.map(x => <PokerCard key={x.i} card={x.card} />)}</div>
      {(name || p.folded) && (
        <p className="xs muted center">{name ? `${you ? 'Tenés' : 'Tiene'} ${name.toLowerCase()}` : ''}{p.folded ? ' · Retirado' : ''}</p>
      )}
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
    <div className="dock-box controls" aria-label="Tus acciones">
      <div className="dock-actions">
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
        <div className="raise dock-popup">
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


// ─── Administración manual (master y admins) ─────────────────────────────────
function AdminSeats({ view, busy, onAddOpen, add, remove, rebuy }: {
  view: ApiTableView; busy: boolean; onAddOpen: () => void;
  add: (id: string) => unknown; remove: (id: string) => unknown; rebuy: (id: string) => unknown;
}) {
  const inHand = new Set(view.hand && view.hand.street !== 'done' ? view.hand.players.filter(p => !p.folded).map(p => p.playerId) : []);
  const playing = view.status === 'playing';
  return (
    <section className="card" aria-labelledby="admin-table" style={{ marginTop: 16 }}>
      <div className="row-between" style={{ marginBottom: 8 }}>
        <h2 id="admin-table">Administrar mesa</h2>
        <Btn variant="ghost" onClick={onAddOpen}>+ Agregar jugador</Btn>
      </div>
      <p className="muted small" style={{ marginBottom: 8 }}>
        Los jugadores sin usuario los jugás vos desde tu pantalla; los demás juegan desde la suya.
      </p>
      {view.seats.length === 0 && <p className="muted small">Todavía no hay nadie en la mesa.</p>}
      {view.seats.map(s => (
        <div className="list-row" key={s.playerId} data-testid={`admin-seat-${s.name}`}>
          <Avatar name={s.name} />
          <div className="grow">
            <strong className="ellipsis">{s.name}</strong>
            <div className="xs muted">
              {playing ? formatMoney(s.stack) : 'En la mesa'}{s.managed ? ' · lo jugás vos' : ''}{s.status === 'out' ? ' · afuera' : ''}
            </div>
          </div>
          <div className="row-wrap">
            {playing && s.stack === 0 && !inHand.has(s.playerId) && (
              <Btn variant="ghost" busy={busy} onClick={() => rebuy(s.playerId)}>Recomprar {formatMoney(view.buyIn)}</Btn>
            )}
            {s.status === 'out' && <Btn variant="ghost" busy={busy} onClick={() => add(s.playerId)}>Volver a sentar</Btn>}
            {s.status !== 'out' && (
              <Btn variant="danger" busy={busy} disabled={inHand.has(s.playerId)} onClick={() => remove(s.playerId)} aria-label={`Quitar a ${s.name}`}>Quitar</Btn>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

function AddPlayerModal({ view, open, onClose, busy, onAdd }: {
  view: ApiTableView; open: boolean; onClose: () => void; busy: boolean; onAdd: (id: string) => unknown;
}) {
  const { path, key } = useGroup();
  const players = useQuery({
    queryKey: key('players'),
    queryFn: () => api<ApiPlayer[]>(path('/players')),
    enabled: open,
  });
  const seated = new Set(view.seats.map(s => s.playerId));
  const free = (players.data ?? []).filter(p => !p.archivedAt && !seated.has(p.id));
  return (
    <Modal open={open} onClose={onClose} title="Agregar jugador a la mesa"
      description={view.status === 'playing'
        ? `Entra con ${formatMoney(view.buyIn)} (se registra como compra) y juega desde la próxima mano.`
        : 'Queda sentado y cuenta como presente para iniciar la partida.'}>
      {players.isLoading && <Loading />}
      {players.error && <QueryError error={players.error} onRetry={() => { void players.refetch(); }} />}
      {players.data && free.length === 0 && <p className="muted">Todos los jugadores del grupo ya están en la mesa.</p>}
      {free.map(p => (
        <div className="list-row" key={p.id}>
          <Avatar name={p.name} />
          <span className="grow ellipsis">{p.name}{!p.linked && <span className="xs muted"> · sin usuario</span>}</span>
          <Btn variant="ghost" busy={busy} aria-label={`Agregar a ${p.name}`} onClick={() => onAdd(p.id)}>Agregar</Btn>
        </div>
      ))}
      <div className="modal-actions"><Btn variant="ghost" onClick={onClose}>Cerrar</Btn></div>
    </Modal>
  );
}
