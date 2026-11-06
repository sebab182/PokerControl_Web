import type { ApiEmojiServerMessage, ApiGroup, ApiPlayer, ApiRtcServerMessage, ApiTableAction, ApiTableView } from '@pokercontrol/contracts';
import { formatMoney, parseAmount } from '@pokercontrol/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError, api } from '../api';
import { EmptyCard, PlayerSeat, PokerCard, SeatScore, cardText, markOf, winningCards } from '../components/poker';
import {
  Avatar, Btn, Emoji, Loading, Modal, QueryError, TextField, useAction, useFeedback,
} from '../components/ui';
import { useGroup } from '../context';
import { DECKS, type Deck, type TablePrefs, useTablePrefs, useTurnAlert, useWakeLock } from '../tablePrefs';
import { shareInvite } from '../share';
import { EmojiFab, EmojiLayer } from '../components/emoji';
import { useTableSocket } from '../useTableSocket';
import { VideoControls, VideoMenu, VideoProvider, useTableVideo } from '../video';
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
  return (
    <button type="button" className="tool-btn fs-btn" aria-label="Pantalla completa" onClick={toggle}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      </svg>
    </button>
  );
}

const PrefsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
  </svg>
);

/**
 * Barra de la mesa mientras se juega una mano (celular y compu): el estado de la mano y las herramientas
 * (video, preferencias). En el celular reemplaza al menú de abajo, así que lleva una flecha para volver.
 */
function TableBar({ view, hand, updatedAt, live, onPrefs }: {
  view: ApiTableView; hand: Hand; updatedAt: number; live: boolean; onPrefs: () => void;
}) {
  return (
    <div className="table-bar">
      <h1 className="sr-only">Mesa</h1>
      <Link to="/ranking" className="tool-btn table-back" aria-label="Volver al menú">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </Link>
      <Status view={view} hand={hand} updatedAt={updatedAt} />
      <div className="table-tools">
        {live && <span className="live-dot" role="img" aria-label="En vivo" title="En vivo: recibís los cambios al instante" />}
        <VideoMenu />
        <FullscreenButton />
        <button type="button" className="tool-btn tool-btn-plain" aria-label="Preferencias de la mesa" onClick={onPrefs}><PrefsIcon /></button>
      </div>
    </div>
  );
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
  const { confirm, notify } = useFeedback();
  const { busy, run } = useAction();
  const queryKey = key('table');
  const [standing, setStanding] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [closedId, setClosedId] = useState<string | null>(null);
  const [prefs, setPrefs] = useTablePrefs();

  // Cualquier aviso refresca la mesa. No se compara la versión: sentarse o levantarse cambia lo que
  // se ve sin cambiar la versión de la mano (que solo protege las jugadas). Un GET repetido sale barato.
  // El socket necesita el manejador de video y el video necesita el socket: se une por ref.
  const signal = useRef<(msg: ApiRtcServerMessage) => void>(() => {});
  const emojiHandler = useRef<(m: ApiEmojiServerMessage) => void>(() => {});
  const socket = useTableSocket(group.id, () => { void qc.invalidateQueries({ queryKey }); }, msg => signal.current(msg), msg => emojiHandler.current(msg));
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
  useTurnAlert(myTurn, prefs);
  useWakeLock(prefs.keepAwake && view?.status === 'playing');
  const log = useHandLog(view);
  // Las ciegas suben entre manos: al empezar la que ya las trae más altas, un aviso.
  const lastHand = useRef<number | null>(null);
  const lastBig = useRef<number | null>(null);
  const handNo = view?.hand?.handNo;
  const bigBlind = view?.bigBlind;
  const smallBlind = view?.smallBlind;
  useEffect(() => {
    if (handNo === undefined || bigBlind === undefined || handNo === lastHand.current) return;
    lastHand.current = handNo;
    if (lastBig.current !== null && bigBlind > lastBig.current) notify(`Las ciegas subieron a ${formatMoney(smallBlind ?? 0)}/${formatMoney(bigBlind)}.`);
    lastBig.current = bigBlind;
  }, [handNo, bigBlind, smallBlind, notify]);

  useLandscapeTable(view?.status === 'playing' && !!view.hand);
  // En la compu la mesa usa más ancho que el resto de las páginas (ver styles.css).
  useEffect(() => {
    document.documentElement.classList.add('table-page');
    return () => document.documentElement.classList.remove('table-page');
  }, []);

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

  // Quien inició la partida reparte: su pantalla avisa que sigue ahí aunque no esté sentado.
  // Si deja de avisar, el servidor habilita a los sentados para que la partida no se trabe.
  const isHost = !!view?.isHost;
  useEffect(() => {
    if (!isHost) return;
    const ping = () => { if (document.visibilityState === 'visible') api<ApiTableView>(path('/table/ping'), { method: 'POST' }).catch(() => {}); };
    ping();
    const id = setInterval(ping, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [isHost]);

  // Esperando que otro reparta: el permiso puede llegar sin que cambie la mesa (quien inició se fue), así que se consulta cada tanto.
  const waitingDeal = !!view && view.status === 'playing' && !view.canHost && (!view.hand || view.hand.street === 'done');
  useEffect(() => {
    if (!waitingDeal) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void query.refetch(); }, HEARTBEAT_MS / 2);
    return () => clearInterval(id);
  }, [waitingDeal]);

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
      <EmojiLayer handler={emojiHandler} enabled={prefs.emojis} />
      {/* En el paño el botón va en la esquina del propio paño; en la sala de espera, flotando sobre la página. */}
      {prefs.emojis && !(view.status === 'playing' && view.hand) && <EmojiFab placement="page" live={live} onSend={socket.sendEmoji} />}
      {/* Con una mano en juego, la barra de la mesa reemplaza al encabezado. */}
      {!(view.status === 'playing' && view.hand) && (
        <div className="page-head">
          <h1 className="grow">Mesa</h1>
          {live && <span className="badge badge-muted" title="Recibís los cambios al instante">En vivo</span>}
          {view.status === 'playing' && <span className="badge badge-green">Partida en curso</span>}
          <button type="button" className="icon-btn" aria-label="Preferencias de la mesa" onClick={() => setPrefsOpen(true)}><PrefsIcon /></button>
        </div>
      )}
      <div className={`table-layout${prefs.animations ? ' table-anim' : ''} deck-${prefs.deck}`}>
        <div className="table-main">
          {view.status === 'playing' && !view.hand && <VideoControls />}
          {closedId && view.status === 'waiting' && (
            <div className="notice notice-ok" role="status">
              Partida cerrada. <Link to={`/sessions/${closedId}`}>Ver resultados y saldos</Link>
            </div>
          )}
          {view.status === 'waiting'
            ? <Waiting view={view} canEdit={canEdit} standing={standing} busy={busy} onJoin={join} onLeave={leave} onStart={() => setStartOpen(true)} onAddOpen={() => setAddOpen(true)} />
            : <Playing view={view} updatedAt={query.dataUpdatedAt} busy={busy}
              fab={prefs.emojis ? <EmojiFab placement="felt" live={live} onSend={socket.sendEmoji} /> : null} onJoin={join} onLeave={leave} onDeal={deal} onClose={close}
              bar={view.hand && <TableBar view={view} hand={view.hand} updatedAt={query.dataUpdatedAt} live={live} onPrefs={() => setPrefsOpen(true)} />}
              onReveal={(playerIds, cards) => run(async () => {
                // Varios a la vez (los jugadores que manejás): uno por vez, cada uno con la mesa ya actualizada.
                for (const playerId of playerIds) {
                  await post('reveal', { ...(cards ? { cards } : {}), ...(playerId !== view.myPlayerId ? { playerId } : {}) });
                }
              })}
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
        </div>
        <aside className="table-side" aria-label="Detalle de la mesa">
          {view.status === 'playing' && log.lines.length > 0 && <HandLog handNo={log.handNo} lines={log.lines} />}
          {canEdit && !group.playerId && (
            <details className="card" style={{ marginTop: 16 }}>
              <summary className="strong" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Quiero jugar yo también</summary>
              <p className="muted small" style={{ margin: '4px 0 12px' }}>Elegí tu jugador para sentarte a la mesa como cualquier otro miembro.</p>
              <NickChooser />
            </details>
          )}
          {canEdit && <AdminSeats view={view} busy={busy} onAddOpen={() => setAddOpen(true)} {...admin} />}
        </aside>
      </div>
      <PrefsModal open={prefsOpen} onClose={() => setPrefsOpen(false)} prefs={prefs} onChange={setPrefs} />
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
function Waiting({ view, canEdit, standing, busy, onJoin, onLeave, onStart, onAddOpen }: {
  view: ApiTableView; canEdit: boolean; standing: boolean; busy: boolean; onJoin: () => void; onLeave: () => void; onStart: () => void;
  onAddOpen: () => void;
}) {
  const { group, path, key } = useGroup();
  const { notify } = useFeedback();
  const present = view.seats.filter(s => s.online);
  const canStart = present.length >= 2 && (canEdit || present.some(s => s.isYou));
  // El código de invitación solo les llega a master y admins (misma consulta que Configuración).
  const details = useQuery({ queryKey: key('group-details'), queryFn: () => api<ApiGroup>(path('')), enabled: canEdit });
  const inviteCode = details.data?.inviteCode;
  return (
    <div className="lobby">
      <section className="card" aria-labelledby="lobby-cfg">
        <div className="row-between">
          <h2 id="lobby-cfg">Configuración</h2>
          {inviteCode && <Btn variant="ghost" onClick={() => { void shareInvite(group.name, inviteCode, notify); }}>Invitar</Btn>}
        </div>
        <div className="lobby-cfg">
          <div><span className="xs muted">Entrada</span><strong className="num">{formatMoney(view.buyIn)}</strong></div>
          <div><span className="xs muted">Ciegas</span><strong className="num">{formatMoney(view.smallBlind)}/{formatMoney(view.bigBlind)}</strong></div>
          <div><span className="xs muted">Turno</span><strong className="num">{view.turnSeconds ? `${view.turnSeconds} s` : 'Sin límite'}</strong></div>
          <div><span className="xs muted">Ciegas ×2</span><strong className="num">{view.blinds.minutes ? `cada ${view.blinds.minutes} min` : 'Nunca'}</strong></div>
        </div>
        <p className="xs muted">Se puede cambiar al iniciar la partida.</p>
      </section>

      <section className="card" aria-labelledby="lobby-seats">
        <div className="row-between">
          <h2 id="lobby-seats">En la mesa <span className="muted num">· {view.seats.length}</span></h2>
          {canEdit && <Btn variant="ghost" onClick={onAddOpen}>+ Agregar</Btn>}
        </div>
        {view.seats.length === 0 && <p className="muted" style={{ padding: '12px 0' }}>Todavía no hay nadie sentado.</p>}
        {view.seats.map(s => (
          <div className="list-row" key={s.playerId}>
            <Avatar name={s.name} />
            <div className="grow">
              <strong>{s.isYou ? `${s.name} (vos)` : s.name}</strong>
              <div className="xs muted">
                <span className={`seat-dot${s.online ? (s.managed ? ' seat-dot-managed' : ' seat-dot-on') : ''}`} aria-hidden="true" />
                {s.online ? (s.managed ? 'Lo jugás vos' : 'Conectado') : 'No conectado'}
              </div>
            </div>
          </div>
        ))}
        <p className="xs muted" style={{ marginTop: 8 }}>Cuando haya al menos 2 jugadores conectados se puede iniciar.</p>
      </section>

      <div className="lobby-actions">
        {view.myPlayerId && (standing
          ? <Btn variant="ghost" busy={busy} onClick={onJoin}>Sentarme</Btn>
          : <Btn variant="ghost" busy={busy} onClick={onLeave}>Levantarme</Btn>)}
        <Btn disabled={!canStart || (standing && !canEdit)} onClick={onStart}>
          Iniciar partida ({present.length} {present.length === 1 ? 'jugador' : 'jugadores'})
        </Btn>
      </div>
      {!canStart && <p className="muted small center">Los demás miembros pueden sumarse después de iniciar.</p>}
    </div>
  );
}

function StartModal({ view, open, onClose, onStart, busy }: {
  view: ApiTableView; open: boolean; onClose: () => void; busy: boolean;
  onStart: (cfg: { buyIn: number; smallBlind: number; bigBlind: number; turnSeconds: number; blindMinutes: number }) => void;
}) {
  const [error, setError] = useState('');
  const [buyIn, setBuyIn] = useState(String(view.buyIn));
  const [sb, setSb] = useState(String(view.smallBlind));
  const [bb, setBb] = useState(String(view.bigBlind));
  const [turn, setTurn] = useState(String(view.turnSeconds));
  const [blindMin, setBlindMin] = useState(String(view.blinds.minutes));
  const submit = () => {
    const cfg = { buyIn: parseAmount(buyIn), smallBlind: parseAmount(sb), bigBlind: parseAmount(bb) };
    if ([cfg.buyIn, cfg.smallBlind, cfg.bigBlind].some(n => n === null || n <= 0 || !Number.isInteger(n))) {
      return setError('Ingresá montos enteros mayores a 0.');
    }
    const turnSeconds = parseAmount(turn);
    if (turnSeconds === null || !Number.isInteger(turnSeconds) || (turnSeconds !== 0 && (turnSeconds < 10 || turnSeconds > 300))) {
      return setError('El tiempo por turno es 0 (sin límite) o entre 10 y 300 segundos.');
    }
    const blindMinutes = parseAmount(blindMin);
    if (blindMinutes === null || !Number.isInteger(blindMinutes) || (blindMinutes !== 0 && (blindMinutes < 5 || blindMinutes > 120))) {
      return setError('Las ciegas se duplican cada 0 (nunca) o entre 5 y 120 minutos.');
    }
    setError('');
    onStart({ ...cfg, turnSeconds, blindMinutes } as { buyIn: number; smallBlind: number; bigBlind: number; turnSeconds: number; blindMinutes: number });
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
      <TextField label="Duplicar las ciegas cada (minutos, 0 = nunca)" value={blindMin} onChange={setBlindMin} decimal />
      <p className="xs muted" style={{ marginTop: -6, marginBottom: 12 }}>
        Suben entre manos y se frenan cuando la ciega grande llega a la mitad de la entrada.
      </p>
      {error && <p className="notice notice-err" role="alert">{error}</p>}
      <div className="modal-actions">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn busy={busy} onClick={submit}>Iniciar partida</Btn>
      </div>
    </Modal>
  );
}

// ─── Partida en curso ────────────────────────────────────────────────────────
type Seat = ApiTableView['seats'][number];

function Playing({ view, updatedAt, bar, fab, busy, onJoin, onLeave, onDeal, onClose, onAction, onRebuy, onReveal }: {
  view: ApiTableView; updatedAt: number; bar: ReactNode; fab: ReactNode; busy: boolean; onJoin: () => void; onLeave: () => void; onDeal: () => void;
  onClose: () => void; onAction: (a: ApiTableAction) => void; onRebuy: (amount: number) => void;
  onReveal: (playerIds: string[], cards?: number[]) => void;
}) {
  const me = view.seats.find(s => s.isYou);
  const hand = view.hand;
  const live = !!hand && hand.street !== 'done';
  // Sin fichas se puede recomprar entre manos, si ya te retiraste de la que está en juego o mientras seguís pendiente de pagar.
  const myPlayer = hand?.players.find(p => p.playerId === me?.playerId);
  const canRebuy = !!me && me.stack === 0 && (!live || !myPlayer || myPlayer.folded || myPlayer.pending);
  // Vos y los jugadores sin usuario que manejás, en el orden de la mesa.
  const mine = (hand?.players ?? [])
    .map(p => view.seats.find(s => s.playerId === p.playerId))
    .filter((s): s is Seat => !!s && (s.isYou || s.managed));
  // Reparte (y cierra) quien inició la partida o un administrador; el resto ve a quién esperan.
  const canDeal = !live && view.canHost;
  const waitingDeal = !live && !view.canHost && !!view.host && <p className="muted small center" data-testid="waiting-deal">Esperando que {view.host} reparta la próxima mano.</p>;
  const waitingSeats = view.seats.filter(s => !hand?.players.some(p => p.playerId === s.playerId));

  return (
    <>
      {hand && (
        <div className="table-stage">
          {bar}
          <Felt view={view} hand={hand} updatedAt={updatedAt} fab={fab} />
          {/* Tus cartas van en tu asiento; acá solo lo que hay que decidir, siempre en el mismo lugar. */}
          <section className="hand-dock" aria-label="Tus acciones">
            <HandResult view={view} hand={hand} where="dock" />
            {live && hand.legal && <Controls view={view} hand={hand} updatedAt={updatedAt} busy={busy} onAction={onAction} />}
            {hand.street === 'done' && <ShowCards hand={hand} players={mine} busy={busy} onReveal={onReveal} />}
            {canDeal && <Btn block busy={busy} onClick={onDeal}>Repartir próxima mano</Btn>}
            {hand.street === 'done' && waitingDeal}
            {canRebuy && me && <NoChips view={view} sitting={me.status === 'sitting'} pending={!!myPlayer?.pending && !myPlayer.folded} busy={busy} onLeave={onLeave} onRebuy={onRebuy} />}
          </section>
        </div>
      )}

      {waitingSeats.length > 0 && (
        <p className="muted small center" style={{ margin: '12px 0' }}>
          Esperan la próxima mano: {waitingSeats.map(s => `${s.isYou ? 'vos' : s.name} (${formatMoney(s.stack)}${s.status === 'out' ? ', afuera' : ''})`).join(', ')}
        </p>
      )}

      <div className="stack table-extra">
        {!hand && canDeal && <Btn block busy={busy} onClick={onDeal}>Repartir</Btn>}
        {!hand && waitingDeal}
        {!me && view.myPlayerId && <Btn variant="ghost" block busy={busy} onClick={onJoin}>Sumarme a la mesa por {formatMoney(view.buyIn)}</Btn>}
        {me?.status === 'out' && <Btn variant="ghost" block busy={busy} onClick={onJoin}>Volver a sentarme</Btn>}
        {view.canHost && !live && <Btn variant="danger" block busy={busy} onClick={onClose}>Cerrar partida</Btn>}
      </div>
    </>
  );
}

/** Sin saldo: levantarse o recomprar hasta la mitad de lo que tiene quien más fichas tiene. */
function NoChips({ view, sitting, pending, busy, onLeave, onRebuy }: {
  view: ApiTableView; sitting: boolean; pending: boolean; busy: boolean; onLeave: () => void; onRebuy: (amount: number) => void;
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
      {pending && (
        <p className="xs" data-testid="pending-note" style={{ marginBottom: 4 }}>
          Te repartieron cartas, pero no las ves hasta que recompres. Si no recomprás en tu turno, te retirás de la mano.
        </p>
      )}
      {max >= 1 ? (
        <>
          <p className="xs muted" style={{ marginBottom: 4 }}>Hasta {formatMoney(max)} (la mitad del que más tiene).</p>
          <TextField label="Fichas a recomprar" value={value} onChange={setText} decimal />
          <div className="controls-row">
            <Btn variant="ghost" onClick={() => setText(String(max))}>Máximo</Btn>
            <Btn busy={busy} onClick={submit}>Recomprar</Btn>
          </div>
        </>
      ) : <p className="xs muted">No hay fichas para recomprar.</p>}
      {sitting && !pending && <Btn variant="ghost" busy={busy} onClick={onLeave}>Levantarme</Btn>}
    </section>
  );
}

/**
 * Al terminar la mano, hasta que se reparta la próxima: un solo panel para decidir qué mostrar,
 * tuyas y de los jugadores que manejás. "No" lo oculta hasta la próxima mano (las cartas siguen ocultas para los demás).
 * Una sola carta solo si todos los demás se retiraron.
 * Los jugadores que manejás van juntos en una fila (con "Elegir" para decidir uno por uno): así el panel
 * mide lo mismo con 2 que con 8 y "Repartir próxima mano" queda a la vista.
 */
function ShowCards({ hand, players, busy, onReveal }: {
  hand: Hand; players: Seat[]; busy: boolean; onReveal: (playerIds: string[], cards?: number[]) => void;
}) {
  const [mucked, setMucked] = useState<Record<string, number>>({});
  const [picking, setPicking] = useState(0);
  const rows = players.flatMap(s => {
    const p = hand.players.find(x => x.playerId === s.playerId);
    if (!p || p.hole.length < 2 || p.hole.includes('??') || p.shown.length >= 2 || mucked[s.playerId] === hand.handNo) return [];
    // Quedó solo porque los demás se retiraron: no hay showdown y decide qué enseñar.
    const alone = hand.showdown.length === 0 && !p.folded && hand.players.filter(x => !x.folded).length === 1;
    return [{ s, p, alone }];
  });
  if (rows.length === 0) return null;
  const muck = (ids: string[]) => setMucked(m => ({ ...m, ...Object.fromEntries(ids.map(id => [id, hand.handNo])) }));
  // Vos y quien quedó solo (puede mostrar una carta) van siempre en su propia fila.
  const group = rows.filter(r => !r.s.isYou && !r.alone);
  const grouped = group.length >= 2 && picking !== hand.handNo;
  const single = grouped ? rows.filter(r => !group.includes(r)) : rows;
  const ids = group.map(r => r.s.playerId);
  return (
    <div className="dock-box show-cards" data-testid="show-cards">
      <h3 className="dock-title">¿Mostrar cartas?</h3>
      {single.map(({ s, p, alone }) => (
        <div className="show-row" key={s.playerId}>
          <span className="grow ellipsis">
            <strong>{s.isYou ? 'Vos' : s.name}</strong>
            {!s.isYou && <span className="xs muted"> · lo jugás vos</span>}
          </span>
          <div className="show-actions">
            <Btn variant="ghost" busy={busy} aria-label={s.isYou ? 'Mostrar mis cartas' : `Mostrar cartas de ${s.name}`}
              onClick={() => onReveal([s.playerId])}>Mostrar</Btn>
            {alone && p.hole.map((c, i) => !p.shown.includes(i) && (
              <Btn key={i} variant="ghost" busy={busy} aria-label={`Mostrar una carta: ${cardText(c)}`} onClick={() => onReveal([s.playerId], [i])}>
                {cardText(c)}
              </Btn>
            ))}
            <Btn variant="ghost" busy={busy} aria-label={s.isYou ? 'No mostrar mis cartas' : `No mostrar las cartas de ${s.name}`}
              onClick={() => muck([s.playerId])}>No</Btn>
          </div>
        </div>
      ))}
      {grouped && (
        <div className="show-row" data-testid="show-group">
          <span className="grow ellipsis">
            <strong>{listNames(group.map(r => r.s.name))}</strong>
            <span className="xs muted"> · los jugás vos</span>
          </span>
          <div className="show-actions">
            <Btn variant="ghost" busy={busy} aria-label="Mostrar las cartas de los jugadores que manejás" onClick={() => onReveal(ids)}>Mostrar</Btn>
            <Btn variant="ghost" busy={busy} aria-label="No mostrar las cartas de los jugadores que manejás" onClick={() => muck(ids)}>No</Btn>
            <Btn variant="ghost" aria-label="Elegir uno por uno" onClick={() => setPicking(hand.handNo)}>Elegir</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Ana", "Ana y Beto", "Ana, Beto y Caro", "Ana, Beto y 3 más". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} y ${names.length - 2} más`;
}

/**
 * Resultado de la mano en el centro del paño, en el lugar del pozo y sin tapar las cartas. Queda hasta
 * que se reparte la próxima mano; si se oculta, vuelve el pozo.
 */
function HandResult({ view, hand, fallback = null, where = 'felt' }: {
  view: ApiTableView; hand: Hand; fallback?: ReactNode; where?: 'felt' | 'dock';
}) {
  const [hidden, setHidden] = useState(0);
  if (hand.street !== 'done' || hand.payouts.length === 0 || hidden === hand.handNo) return fallback;
  const alone = hand.showdown.length === 0;
  return (
    // Se dibuja en el paño y en la zona de la mano; el CSS muestra uno solo (en horizontal, el de la zona de la mano).
    <div className={`hand-result hand-result-${where}`} role="status" aria-live="polite" data-testid="hand-result">
      <button type="button" className="hand-result-close" aria-label="Ocultar resultado" onClick={() => setHidden(hand.handNo)}>×</button>
      {groupPayouts(hand.payouts).map(g => (
        <p key={g.ids.join()}>
          <strong>{winnersText(view, g.ids)} <span className="num">{formatMoney(g.amount)}</span>{g.ids.length > 1 && ' cada uno'}</strong>
          {g.reason && <span className="hand-result-reason">{g.reason}</span>}
        </p>
      ))}
      {alone && <span className="hand-result-reason">Los demás se retiraron.</span>}
    </div>
  );
}

/** Un pozo dividido: los que ganan lo mismo por la misma jugada van juntos, así el resultado no ocupa media mesa. */
function groupPayouts(payouts: Hand['payouts']) {
  const groups: { ids: string[]; amount: number; reason?: string }[] = [];
  for (const w of payouts) {
    const g = groups.find(x => x.amount === w.amount && x.reason === w.reason);
    if (g) g.ids.push(w.playerId);
    else groups.push({ ids: [w.playerId], amount: w.amount, reason: w.reason });
  }
  return groups;
}

/** "Nico ganó", "Ganaste", "Ana, Beto y vos ganan"… (vos siempre al final). */
function winnersText(view: ApiTableView, ids: string[]): string {
  const you = ids.includes(view.myPlayerId ?? '');
  const others = ids.filter(id => id !== view.myPlayerId).map(id => nameOf(view, id));
  if (ids.length === 1) return you ? 'Vos ganaste' : `${others[0]} ganó`;
  const names = you ? [...others, 'vos'] : others;
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]} ganan`;
}

function Felt({ view, hand, updatedAt, fab }: { view: ApiTableView; hand: Hand; updatedAt: number; fab: ReactNode }) {
  const players = hand.players;
  const myIdx = Math.max(0, players.findIndex(p => p.playerId === view.myPlayerId));
  // Al terminar con showdown se resaltan las cartas de la jugada ganadora.
  const win = winningCards(hand);
  const heroSeat = view.seats.find(s => s.playerId === players[myIdx]?.playerId);
  const hero = players[myIdx];
  const heroCards = !!heroSeat && (heroSeat.isYou || heroSeat.managed) && !!hero && hero.hole.some(c => c !== '??');
  return (
    <div className="felt-wrap">
      <BlindsChip view={view} updatedAt={updatedAt} />
      {fab}
      <div className={`felt${heroCards ? ' felt-hero' : ''}`} data-testid="felt">
        <div className="felt-center">
          <HandResult view={view} hand={hand} fallback={<div className="pot num" data-testid="pot">Pozo {formatMoney(hand.pot)}</div>} />
          {/* En línea (compu y celular horizontal) separados 3 | 1 | 1; en un paño angosto, flop arriba y turn + river abajo. El pozo va arriba. */}
          <div className="board" role="group" aria-label="Cartas comunitarias">
            <div className="board-row">
              {[0, 1, 2].map(i => hand.board[i] ? <PokerCard key={i} card={hand.board[i]} mark={markOf(win, hand.board[i])} /> : <EmptyCard key={i} />)}
            </div>
            <div className="board-row board-late">
              {[3, 4].map(i => hand.board[i] ? <PokerCard key={i} card={hand.board[i]} mark={markOf(win, hand.board[i])} /> : <EmptyCard key={i} />)}
            </div>
          </div>
        </div>
        {players.map((p, i) => (
          <PlayerSeat key={p.playerId} view={view} hand={hand} playerId={p.playerId}
            offset={(i - myIdx + players.length) % players.length} total={players.length} />
        ))}
      </div>
    </div>
  );
}

/** "8:31" a partir de milisegundos. */
const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Ciegas de la mano y cuándo suben. Se calcula contra la hora del servidor, no la del dispositivo.
 * Con "nunca" (0 minutos) muestra solo las ciegas.
 */
function BlindsChip({ view, updatedAt }: { view: ApiTableView; updatedAt: number }) {
  const b = view.blinds;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!b.nextAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [b.nextAt]);
  let note: string | null = null;
  if (b.minutes > 0) {
    if (view.bigBlind < b.big) note = `Próxima mano: ${formatMoney(b.small)}/${formatMoney(b.big)}`;
    else if (b.atCap) note = 'Ciegas al máximo';
    else if (b.nextAt) {
      const left = Date.parse(b.nextAt) - (now + (Date.parse(view.serverTime) - updatedAt));
      note = left > 0 ? `Suben a ${formatMoney(b.small * 2)}/${formatMoney(b.big * 2)} en ${clock(left)}` : 'Suben en la próxima mano';
    }
  }
  return (
    <div className="blinds-chip" data-testid="blinds">
      <strong className="num">Ciegas {formatMoney(view.smallBlind)}/{formatMoney(view.bigBlind)}</strong>
      {note && <span className="blinds-note" data-testid="blinds-note">{note}</span>}
    </div>
  );
}

/** Segundos que quedan del turno. Se calcula contra la hora del servidor, no la del reloj del dispositivo. */
function useSecondsLeft(view: ApiTableView, updatedAt: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view.turnDeadline) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [view.turnDeadline]);
  if (!view.turnDeadline) return null;
  const skew = Date.parse(view.serverTime) - updatedAt;
  return Math.max(0, Math.ceil((Date.parse(view.turnDeadline) - (now + skew)) / 1000));
}

/** Cuenta regresiva del turno. */
function TurnTimer({ view, updatedAt }: { view: ApiTableView; updatedAt: number }) {
  const left = useSecondsLeft(view, updatedAt);
  if (left === null) return null;
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
    // Quién ganó y por qué va en el centro del paño (HandResult).
    text = 'Terminada.';
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


/** Tecla de atajo, solo visible con mouse. No forma parte del nombre del botón. */
function Kbd({ children }: { children: string }) {
  return <kbd className="kbd" aria-hidden="true">{children}</kbd>;
}

function Controls({ view, hand, updatedAt, busy, onAction }: {
  view: ApiTableView; hand: Hand; updatedAt: number; busy: boolean; onAction: (a: ApiTableAction) => void;
}) {
  const legal = hand.legal;
  const [raising, setRaising] = useState(false);
  const left = useSecondsLeft(view, updatedAt);
  // Atajos en la compu: F retirarse, C pasar o igualar, R subir. Se ignoran mientras se escribe o hay un diálogo abierto.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = e => {
    if (!legal || busy || raising || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest?.('input, textarea, select, [role="dialog"]')) return;
    const k = e.key.toLowerCase();
    if (k === 'f') onAction({ type: 'fold' });
    else if (legal.mustBuy) return;
    else if (k === 'c') onAction({ type: legal.canCheck ? 'check' : 'call' });
    else if (k === 'r' && legal.canRaise) setRaising(true);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  if (!legal) return null;

  const actorId = hand.actingPlayerId as string;
  const actor = hand.players.find(p => p.playerId === actorId);
  const allInCall = !!actor && legal.canCall && legal.callAmount >= actor.stack;
  const forOther = actorId !== view.myPlayerId;
  const fraction = left !== null && view.turnSeconds > 0 ? Math.min(1, left / view.turnSeconds) : null;

  return (
    <div className="controls" role="group" aria-label={forOther ? `Acciones de ${nameOf(view, actorId)}` : 'Tus acciones'}>
      {forOther && <p className="acting-for">Jugás por <strong>{nameOf(view, actorId)}</strong></p>}
      {fraction !== null && (
        <div className={`turn-bar${left !== null && left <= 10 ? ' turn-bar-low' : ''}`} aria-hidden="true">
          <span style={{ width: `${fraction * 100}%` }} />
        </div>
      )}
      <div className="controls-row">
        <Btn variant="danger" busy={busy} aria-keyshortcuts="F" onClick={() => onAction({ type: 'fold' })}>Retirarme<Kbd>F</Kbd></Btn>
        {legal.mustBuy ? null : legal.canCheck
          ? <Btn busy={busy} aria-keyshortcuts="C" onClick={() => onAction({ type: 'check' })}>Pasar<Kbd>C</Kbd></Btn>
          : (
            <Btn busy={busy} aria-keyshortcuts="C" onClick={() => onAction({ type: 'call' })}>
              {allInCall ? 'All-in' : 'Igualar'} {formatMoney(legal.callAmount)}<Kbd>C</Kbd>
            </Btn>
          )}
        {legal.canRaise && (
          <Btn variant="ghost" busy={busy} aria-keyshortcuts="R" aria-haspopup="dialog" onClick={() => setRaising(true)}>Subir<Kbd>R</Kbd></Btn>
        )}
      </div>
      {legal.mustBuy && <p className="xs muted" style={{ marginTop: 6 }}>Recomprá para jugar esta mano, o retirate.</p>}
      {legal.canRaise && (
        <RaiseSheet view={view} hand={hand} open={raising} onClose={() => setRaising(false)} busy={busy} onAction={onAction} />
      )}
    </div>
  );
}

/** Hoja para subir: monto grande con − / + de a una ciega grande, deslizador y atajos con el monto ya calculado. */
function RaiseSheet({ view, hand, open, onClose, busy, onAction }: {
  view: ApiTableView; hand: Hand; open: boolean; onClose: () => void; busy: boolean; onAction: (a: ApiTableAction) => void;
}) {
  const legal = hand.legal as NonNullable<Hand['legal']>;
  const { notify } = useFeedback();
  const [text, setText] = useState(String(legal.minRaiseTo));
  // Cada vez que se abre arranca en la subida mínima.
  useEffect(() => { if (open) setText(String(legal.minRaiseTo)); }, [open, legal.minRaiseTo]);

  const min = legal.minRaiseTo;
  const max = legal.maxRaiseTo;
  const clamp = (n: number) => Math.min(Math.max(Math.round(n), min), max);
  const parsed = parseAmount(text);
  const value = parsed ?? min;
  const set = (n: number) => setText(String(clamp(n)));
  const quick = [
    { label: 'Mínimo', to: min },
    { label: '½ pozo', to: hand.currentBet + Math.round(hand.pot / 2) },
    { label: 'Pozo', to: hand.currentBet + hand.pot },
    { label: 'All-in', to: max },
  ].map(q => ({ ...q, to: clamp(q.to) }));
  // Si dos atajos dan el mismo monto, se marca solo el primero.
  const pressed = quick.findIndex(q => q.to === value);

  const submit = () => {
    if (parsed === null || !Number.isInteger(parsed)) return notify('Ingresá un monto entero.');
    if (parsed < min && parsed !== max) return notify(`La subida mínima es a ${formatMoney(min)}.`);
    if (parsed > max) return notify(`No tenés fichas para tanto: máximo ${formatMoney(max)}.`);
    onClose();
    onAction(parsed === max ? { type: 'allin' } : { type: 'raise', to: parsed });
  };

  return (
    <Modal open={open} onClose={onClose} title="Subir" className="raise-modal"
      description={`Para igualar: ${formatMoney(legal.callAmount)} · Máximo: ${formatMoney(max)}`}>
      <div className="raise-amount">
        <button type="button" className="raise-step" aria-label={`Bajar ${formatMoney(view.bigBlind)}`}
          disabled={value <= min} onClick={() => set(value - view.bigBlind)}>−</button>
        <label className="raise-input">
          Subir a
          <input type="text" inputMode="numeric" autoComplete="off" className="num" value={text} onChange={e => setText(e.target.value)} />
        </label>
        <button type="button" className="raise-step" aria-label={`Subir ${formatMoney(view.bigBlind)}`}
          disabled={value >= max} onClick={() => set(value + view.bigBlind)}>+</button>
      </div>
      <input type="range" className="raise-range" aria-label="Monto de la subida" min={min} max={max} step={1}
        value={clamp(value)} onChange={e => setText(e.target.value)} />
      <div className="raise-limits xs muted num"><span>Mín {formatMoney(min)}</span><span>All-in {formatMoney(max)}</span></div>
      <div className="raise-quick">
        {quick.map((q, i) => (
          <button type="button" key={q.label} className="raise-chip" aria-pressed={i === pressed} onClick={() => set(q.to)}>
            <span>{q.label}</span>
            <span className="num">{formatMoney(q.to)}</span>
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn busy={busy} onClick={submit}>{value >= max ? `All-in ${formatMoney(max)}` : `Subir a ${formatMoney(value)}`}</Btn>
      </div>
    </Modal>
  );
}

/**
 * Historial de la mano en curso. La API solo manda la última acción, así que se arma con cada una que llega
 * (con el socket en vivo llegan todas; sin él puede faltar alguna).
 */
function useHandLog(view: ApiTableView | undefined) {
  const [log, setLog] = useState({ handNo: 0, lines: [] as string[], sig: '', board: 0 });
  const hand = view?.hand;
  const la = hand?.lastAction;
  const sig = hand && la ? [hand.handNo, la.playerId, la.type, la.amount ?? '', hand.board.length, hand.pot].join('|') : '';
  useEffect(() => {
    if (!view || !hand) return;
    setLog(prev => {
      const fresh = prev.handNo !== hand.handNo;
      const lines = fresh ? [] : [...prev.lines];
      if (la && sig !== prev.sig) lines.push(describeLast(view, la));
      const board = fresh ? 0 : prev.board;
      if (hand.board.length > board) {
        const street = hand.board.length === 3 ? 'Flop' : hand.board.length === 4 ? 'Turn' : 'River';
        lines.push(`${street}: ${hand.board.slice(board).map(cardText).join(' ')}`);
      }
      return { handNo: hand.handNo, lines, sig: sig || prev.sig, board: hand.board.length };
    });
    // sig y board resumen todo lo que cambia el historial.
  }, [hand?.handNo, sig, hand?.board.length]);
  return log;
}

function HandLog({ handNo, lines }: { handNo: number; lines: string[] }) {
  // Abierto en la compu, donde va en el panel lateral; plegado en el celular, debajo de todo.
  const [open] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  return (
    <details className="card hand-log" open={open}>
      <summary className="strong">Mano {handNo}</summary>
      <ol>{lines.map((line, i) => <li key={i}>{line}</li>)}</ol>
    </details>
  );
}

const DECK_LABEL: Record<Deck, string> = { classic: 'Clásico', four: '4 colores', color: 'Color' };
const DECK_HINT: Record<Deck, string> = {
  classic: 'Picas y tréboles negros; corazones y diamantes rojos.',
  four: 'Diamantes azules y tréboles verdes, para no confundirlos con corazones y picas.',
  color: 'Cada carta con el fondo del color de su palo y el número grande: se distinguen de un vistazo.',
};

function PrefsModal({ open, onClose, prefs, onChange }: {
  open: boolean; onClose: () => void; prefs: TablePrefs; onChange: (patch: Partial<TablePrefs>) => void;
}) {
  const items: { key: 'sound' | 'vibrate' | 'animations' | 'keepAwake' | 'emojis'; label: string; hint: string }[] = [
    { key: 'sound', label: 'Sonidos', hint: 'Un tono cuando te toca jugar' },
    { key: 'vibrate', label: 'Vibrar en mi turno', hint: 'Solo en celulares que lo permiten' },
    { key: 'animations', label: 'Animaciones', hint: 'Reparto de cartas y fichas' },
    { key: 'keepAwake', label: 'Mantener la pantalla encendida', hint: 'Mientras haya una partida en juego' },
    { key: 'emojis', label: 'Emojis', hint: 'Ver los de los demás y poder mandar los tuyos' },
  ];
  return (
    <Modal open={open} onClose={onClose} title="Preferencias de la mesa" description="Se guardan en este dispositivo.">
      <fieldset className="pref-deck">
        <legend className="strong">Mazo</legend>
        <div className="segmented">
          {DECKS.map(d => (
            <button type="button" key={d} className="btn btn-ghost deck-option" aria-pressed={prefs.deck === d} onClick={() => onChange({ deck: d })}>
              {/* Muestra: trébol y pica, los que más se confunden. */}
              <span className={`deck-sample deck-${d}`} aria-hidden="true"><PokerCard card="Kc" size="sm" /><PokerCard card="As" size="sm" /></span>
              {DECK_LABEL[d]}
            </button>
          ))}
        </div>
        <p className="xs muted">{DECK_HINT[prefs.deck]}</p>
      </fieldset>
      {items.map(it => (
        <label className="check-row pref-row" key={it.key}>
          <span className="grow">
            <strong>{it.label}</strong>
            <span className="xs muted" style={{ display: 'block' }}>{it.hint}</span>
          </span>
          <input type="checkbox" role="switch" checked={prefs[it.key]} onChange={e => onChange({ [it.key]: e.target.checked })} />
        </label>
      ))}
      <div className="modal-actions"><Btn onClick={onClose}>Listo</Btn></div>
    </Modal>
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
              {playing && <> · <SeatScore seat={s} /></>}
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
