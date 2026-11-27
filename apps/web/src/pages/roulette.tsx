import type { ApiHandView, ApiRouletteBet, ApiRouletteView, ApiTableView } from '@pokercontrol/contracts';
import { WHEEL_ORDER, colorOf, formatMoney } from '@pokercontrol/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PlayerSeat } from '../components/poker';
import { Btn } from '../components/ui';
import { playSfx } from '../sounds';

type Bet = ApiRouletteBet;
const COLOR_LABEL = { red: 'rojo', black: 'negro', green: 'verde' } as const;
const STEP = 360 / WHEEL_ORDER.length;

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatMoney(Math.abs(n))}`;

/**
 * La ronda de ruleta vista como una mano del paño de póker, para dibujarla con los mismos asientos (avatar, video, emojis,
 * posiciones): se sientan los conectados y cada asiento muestra lo que apostó ese jugador.
 */
export function rouAsHand(view: ApiTableView, r: ApiRouletteView): ApiHandView {
  const seated = view.seats.filter(s => s.status === 'sitting');
  const betting = r.status === 'betting';
  return {
    handNo: r.roundNo,
    gameHandNo: 0,
    street: betting ? 'preflop' : 'done',
    board: [],
    pot: 0,
    currentBet: 0,
    minRaise: r.minBet,
    button: -1,
    toActPlayerId: null,
    players: seated.map(s => {
      const total = betting ? r.totals.find(t => t.playerId === s.playerId)?.total ?? 0 : 0;
      return { playerId: s.playerId, stack: s.stack, bet: total, totalBet: total, folded: false, allIn: false, pending: false, hole: [], shown: [] };
    }),
    legal: null,
    actingPlayerId: r.actingPlayerId,
    lastAction: null,
    payouts: betting ? [] : r.deltas.filter(d => d.delta > 0).map(d => ({ playerId: d.playerId, amount: d.delta })),
    showdown: [],
    runout: 0,
  };
}

// ─── La rueda ────────────────────────────────────────────────────────────────

const FILL = { red: '#B91C1C', black: '#1F2937', green: '#15803D' } as const;
const point = (deg: number, radius: number): [number, number] => [100 + radius * Math.sin((deg * Math.PI) / 180), 100 - radius * Math.cos((deg * Math.PI) / 180)];

function reduceMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Rueda europea con la bola: al salir un número nuevo gira unos segundos y queda ese número arriba, bajo la flecha. */
function Wheel({ result, spinId }: { result: number | null; spinId: number }) {
  const rest = (n: number | null) => (n === null ? 0 : -WHEEL_ORDER.indexOf(n) * STEP);
  const turns = useRef(0);
  const seen = useRef(spinId);
  const [angle, setAngle] = useState(() => rest(result));
  const [ball, setBall] = useState(0);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    if (seen.current === spinId) return;
    seen.current = spinId;
    if (result === null) { setAngle(0); setBall(0); return; }
    if (reduceMotion()) { setAngle(rest(result)); setBall(0); return; }
    turns.current += 1;
    setSpinning(true);
    setAngle(rest(result) - 360 * 5 * turns.current);
    setBall(360 * 7 * turns.current);
    const id = window.setTimeout(() => { setSpinning(false); setBall(0); setAngle(rest(result) - 360 * 5 * turns.current); }, 4200);
    return () => window.clearTimeout(id);
  }, [spinId, result]);
  const label = result === null ? 'Rueda de ruleta' : `Rueda de ruleta: salió el ${result} (${COLOR_LABEL[colorOf(result)]})`;
  return (
    <svg className="rou-wheel" viewBox="0 0 200 200" role="img" aria-label={label} data-testid="rou-wheel">
      <circle cx="100" cy="100" r="98" fill="#3B2A14" />
      <g className={spinning ? 'rou-spin' : ''} style={{ transform: `rotate(${angle}deg)`, transformOrigin: '100px 100px' }}>
        {WHEEL_ORDER.map((n, i) => {
          const [x1, y1] = point((i - 0.5) * STEP, 92);
          const [x2, y2] = point((i + 0.5) * STEP, 92);
          const [tx, ty] = point(i * STEP, 80);
          return (
            <g key={n}>
              <path d={`M100 100 L${x1} ${y1} A92 92 0 0 1 ${x2} ${y2} Z`} fill={FILL[colorOf(n)]} stroke="#D6B26B" strokeWidth="0.5" />
              <text x={tx} y={ty} fill="#fff" fontSize="7.5" fontWeight="700" textAnchor="middle" dominantBaseline="central" transform={`rotate(${i * STEP} ${tx} ${ty})`}>{n}</text>
            </g>
          );
        })}
        <circle cx="100" cy="100" r="58" fill="#14301F" stroke="#D6B26B" strokeWidth="1" />
      </g>
      <g className={spinning ? 'rou-spin-ball' : ''} style={{ transform: `rotate(${ball}deg)`, transformOrigin: '100px 100px' }}>
        <circle cx="100" cy="17" r="4.5" fill="#fff" stroke="#9CA3AF" strokeWidth="0.8" />
      </g>
      <polygon points="100,3 94,-4 106,-4" fill="#FDE68A" transform="translate(0 6)" />
    </svg>
  );
}

/** El último número: un círculo del color de la casilla. */
function NumberChip({ n, big = false }: { n: number; big?: boolean }) {
  return <span className={`rou-num rou-${colorOf(n)}${big ? ' rou-num-big' : ''}`} aria-label={`${n}, ${COLOR_LABEL[colorOf(n)]}`}>{n}</span>;
}

/** El paño de la ruleta: la misma mesa del póker; en el centro, la rueda y los últimos números. */
export function RouletteFelt({ view, r, hand, fab }: { view: ApiTableView; r: ApiRouletteView; hand: ApiHandView; fab: ReactNode }) {
  const players = hand.players;
  const myIdx = Math.max(0, players.findIndex(p => p.playerId === view.myPlayerId));
  return (
    <div className="felt-wrap">
      {fab}
      <div className="felt" data-testid="felt">
        <div className="felt-center" data-testid="rou">
          <Wheel result={r.status === 'done' ? r.result : null} spinId={r.status === 'done' ? r.roundNo : -1} />
          <div className="rou-last" data-testid="rou-last">
            {r.history.length === 0
              ? <span className="pot">Todavía no salió ningún número</span>
              : r.history.slice(0, 8).map((n, i) => <NumberChip key={`${n}-${i}`} n={n} big={i === 0} />)}
          </div>
        </div>
        {players.map((p, i) => {
          const ready = r.status === 'betting' && r.totals.find(t => t.playerId === p.playerId)?.ready;
          return (
            <PlayerSeat key={p.playerId} view={view} hand={hand} playerId={p.playerId} offset={(i - myIdx + players.length) % players.length} total={players.length}
              note={ready ? 'Listo ✓' : undefined} />
          );
        })}
      </div>
    </div>
  );
}

// ─── El tablero ──────────────────────────────────────────────────────────────

interface CellDef { type: Bet['type']; n?: number; label: string; aria: string; cls: string }

const NUMBER_ROWS: CellDef[][] = Array.from({ length: 12 }, (_, r) => [1, 2, 3].map(c => {
  const n = r * 3 + c;
  return { type: 'straight' as const, n, label: String(n), aria: `Pleno ${n}, ${COLOR_LABEL[colorOf(n)]}`, cls: `rou-${colorOf(n)}` };
}));
const COLUMNS: CellDef[] = [1, 2, 3].map(n => ({ type: 'column', n, label: '2 a 1', aria: `2 a 1, columna ${n}`, cls: 'rou-out' }));
const DOZENS: CellDef[] = [1, 2, 3].map(n => ({ type: 'dozen', n, label: `${['1ª', '2ª', '3ª'][n - 1]} docena`, aria: `${n}ª docena, del ${n * 12 - 11} al ${n * 12}`, cls: 'rou-out' }));
const OUTSIDE: CellDef[] = [
  { type: 'low', label: '1–18', aria: '1–18, del 1 al 18', cls: 'rou-out' },
  { type: 'even', label: 'Par', aria: 'Par', cls: 'rou-out' },
  { type: 'red', label: 'Rojo', aria: 'Rojo', cls: 'rou-red' },
  { type: 'black', label: 'Negro', aria: 'Negro', cls: 'rou-black' },
  { type: 'odd', label: 'Impar', aria: 'Impar', cls: 'rou-out' },
  { type: 'high', label: '19–36', aria: '19–36, del 19 al 36', cls: 'rou-out' },
];

const same = (b: Bet, type: Bet['type'], n?: number) => b.type === type && (b.n ?? null) === (n ?? null);
const sumOf = (bets: Bet[]) => bets.reduce((t, b) => t + b.amount, 0);

/** Lo que hay que hacer en cada momento, debajo del paño: armar las apuestas, tocar «Listo» y ver cómo salió. */
export function RouletteDock({ view, r, busy, timer, onBets, onSpin }: {
  view: ApiTableView; r: ApiRouletteView; busy: boolean; timer: ReactNode;
  onBets: (bets: Bet[], ready: boolean) => void; onSpin: () => void;
}) {
  const betting = r.status === 'betting';
  const mineKey = JSON.stringify(r.mine);
  const [draft, setDraft] = useState<Bet[]>(r.mine);
  const [undo, setUndo] = useState<Bet[][]>([]);
  const [mult, setMult] = useState(1);
  const [hint, setHint] = useState('');
  // Cuando llega una ronda nueva o lo guardado cambia, el borrador vuelve a lo guardado.
  useEffect(() => { setDraft(r.mine); setUndo([]); setHint(''); }, [r.roundNo, r.status, mineKey]);
  const acting = r.actingPlayerId !== null;
  const chip = Math.min(r.minBet * mult, r.maxBet);
  const total = sumOf(draft);
  const dirty = JSON.stringify(draft) !== mineKey;
  const mults = useMemo(() => [1, 2, 5, 10].filter(m => r.minBet * m <= r.maxBet), [r.minBet, r.maxBet]);
  const readyMe = !!r.totals.find(t => t.playerId === r.actingPlayerId)?.ready;

  const add = (type: Bet['type'], n?: number) => {
    if (!acting) return;
    if (total + chip > r.maxBet) { setHint(`Llegaste al máximo: ${formatMoney(r.maxBet)} por ronda.`); return; }
    setHint('');
    setUndo(u => [...u, draft]);
    setDraft(d => (d.some(b => same(b, type, n))
      ? d.map(b => (same(b, type, n) ? { ...b, amount: b.amount + chip } : b))
      : [...d, { type, ...(n !== undefined ? { n } : {}), amount: chip }]));
  };
  const amountOf = (type: Bet['type'], n?: number) => draft.find(b => same(b, type, n))?.amount ?? 0;
  const cell = (c: CellDef) => {
    const amount = amountOf(c.type, c.n);
    return (
      <button key={`${c.type}-${c.n ?? ''}`} type="button" className={`rou-cell ${c.cls}${amount ? ' rou-has' : ''}`} disabled={!acting || busy}
        onClick={() => add(c.type, c.n)} data-testid={`rou-cell-${c.type}${c.n !== undefined ? `-${c.n}` : ''}`}>
        <span aria-hidden="true">{c.label}</span>
        <span className="sr-only">{c.aria}{amount > 0 ? `, apostado ${formatMoney(amount)}` : ''}</span>
        {amount > 0 && <b className="rou-stake num" aria-hidden="true">{formatMoney(amount)}</b>}
      </button>
    );
  };

  const done = r.status === 'done' && r.result !== null;
  const mineNet = r.nets.find(x => x.playerId === (r.actingPlayerId ?? view.myPlayerId))?.net;
  const myDelta = r.deltas.find(x => x.playerId === (r.actingPlayerId ?? view.myPlayerId))?.delta;

  return (
    <section className="hand-dock rou-dock" aria-label="Tus apuestas">
      <h2 className="bj-title">Ruleta contra todos{r.roundNo > 0 ? ` · ronda ${r.roundNo}` : ''}</h2>

      {done && (
        <div className="bj-result" role="status" data-testid="rou-result">
          <strong>Salió el <NumberChip n={r.result as number} /> {COLOR_LABEL[colorOf(r.result as number)]}.</strong>
          {mineNet !== undefined && <span className="small">Tus apuestas: <strong className={`num ${mineNet > 0 ? 'pos' : mineNet < 0 ? 'neg' : ''}`}>{signed(mineNet)}</strong>.</span>}
          {r.house !== null && (
            <span className="small" data-testid="rou-house">
              La casa {r.house > 0 ? 'ganó' : r.house < 0 ? 'perdió' : 'quedó igual'}{r.house !== 0 ? ` ${formatMoney(Math.abs(r.house))}` : ''}: se reparte entre todo el grupo.
              {myDelta !== undefined && <> En total, para vos: <strong className={`num ${myDelta > 0 ? 'pos' : myDelta < 0 ? 'neg' : ''}`}>{signed(myDelta)}</strong>.</>}
            </span>
          )}
        </div>
      )}

      {betting && <p className="small muted" role="status" data-testid="rou-status">Se está apostando{timer}. Cuando todos los conectados estén listos o se acabe el tiempo, gira la bola.</p>}
      {!betting && !done && <p className="small muted" role="status">Apostá para abrir la ronda: arranca el tiempo con la primera apuesta.</p>}

      {!acting && <p className="muted small">Estás mirando: sentate (conectate) para apostar. De todos modos participás del reparto de la casa.</p>}

      <div className="rou-chips" role="group" aria-label="Valor de la ficha">
        {mults.map(m => (
          <button key={m} type="button" className="rou-chipbtn" aria-pressed={m === mult} onClick={() => setMult(m)} data-testid={`rou-chip-${m}`}>
            {formatMoney(r.minBet * m)}
          </button>
        ))}
      </div>

      <div className="rou-board" role="group" aria-label="Tablero">
        <button type="button" className={`rou-cell rou-green rou-zero${amountOf('straight', 0) ? ' rou-has' : ''}`} disabled={!acting || busy}
          onClick={() => add('straight', 0)} data-testid="rou-cell-straight-0">
          <span aria-hidden="true">0</span><span className="sr-only">Pleno 0, verde{amountOf('straight', 0) ? `, apostado ${formatMoney(amountOf('straight', 0))}` : ''}</span>{amountOf('straight', 0) > 0 && <b className="rou-stake num" aria-hidden="true">{formatMoney(amountOf('straight', 0))}</b>}
        </button>
        {NUMBER_ROWS.map(row => row.map(cell))}
        {COLUMNS.map(cell)}
      </div>
      <div className="rou-outside" role="group" aria-label="Docenas">{DOZENS.map(cell)}</div>
      <div className="rou-outside rou-outside-6" role="group" aria-label="Apuestas simples">{OUTSIDE.map(cell)}</div>

      <p className="small" data-testid="rou-total">
        Apostado <strong className="num">{formatMoney(total)}</strong> de {formatMoney(r.maxBet)} por ronda
        {draft.length > 0 && <> · {draft.length} {draft.length === 1 ? 'apuesta' : 'apuestas'}</>}
      </p>
      {hint && <p className="notice notice-err" role="alert">{hint}</p>}

      {acting && (
        <div className="rou-actions">
          <Btn variant="ghost" disabled={undo.length === 0 || busy} onClick={() => { setDraft(undo[undo.length - 1]); setUndo(u => u.slice(0, -1)); setHint(''); }} data-testid="rou-undo">Deshacer</Btn>
          <Btn variant="ghost" disabled={draft.length === 0 || busy} onClick={() => { setUndo(u => [...u, draft]); setDraft([]); setHint(''); }} data-testid="rou-clear">Borrar</Btn>
          <Btn variant="ghost" busy={busy} disabled={!dirty} onClick={() => onBets(draft, false)} data-testid="rou-save">Apostar</Btn>
          <Btn busy={busy} disabled={readyMe && !dirty} onClick={() => onBets(draft, true)} data-testid="rou-ready">{draft.length === 0 ? 'No apuesto' : 'Listo'}</Btn>
        </div>
      )}
      {acting && betting && readyMe && !dirty && <p className="small muted" role="status">Listo ✓ Esperando a los demás.</p>}
      {betting && view.canHost && <Btn variant="ghost" block busy={busy} onClick={onSpin} data-testid="rou-spin">Girar ya</Btn>}
      <p className="xs muted">
        Un pleno paga 35 a 1; docenas y columnas, 2 a 1; el resto, 1 a 1. El 0 pierde las apuestas simples. No hay compra inicial: tu saldo puede quedar en negativo.
        Lo que gana o pierde la casa se reparte en partes iguales entre todo el grupo.
      </p>
      <p className="xs muted">La partida de ruleta se registra aparte: no cuenta en el ranking ni en las estadísticas.</p>
    </section>
  );
}

/** Un sonido al salir el número (el que ya existe para mostrar cartas). */
export function useRouletteSounds(r: ApiRouletteView | null, enabled: boolean) {
  const seen = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!r) return;
    const key = r.status === 'done' && r.result !== null ? r.roundNo : null;
    // Lo que ya estaba al abrir la página no suena.
    if (seen.current !== undefined && enabled && key !== null && key !== seen.current) playSfx('show');
    seen.current = key;
  }, [r, enabled]);
}
