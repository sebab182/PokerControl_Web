import type { ApiHandView, ApiRouletteBet, ApiRouletteView, ApiTableView } from '@pokercontrol/contracts';
import { WHEEL_ORDER, colorOf, formatMoney } from '@pokercontrol/core';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PlayerSeat } from '../components/poker';
import { Btn } from '../components/ui';
import { playSfx } from '../sounds';

type Bet = ApiRouletteBet;
const COLOR_LABEL = { red: 'rojo', black: 'negro', green: 'verde' } as const;
const STEP = 360 / WHEEL_ORDER.length;
/** Lo que dura el giro de la rueda (tiene que coincidir con la transición de .rou-spin). */
const SPIN_MS = 4200;

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

/**
 * Rueda europea con la bola: al salir un número nuevo gira unos segundos y queda ese número arriba, bajo la flecha.
 * Avisa con `onDone` cuando terminó de girar (o enseguida, si no hay animación), para mostrar recién entonces el resultado.
 */
function Wheel({ result, spinId, onDone }: { result: number | null; spinId: number; onDone: (id: number) => void }) {
  const rest = (n: number | null) => (n === null ? 0 : -WHEEL_ORDER.indexOf(n) * STEP);
  const turns = useRef(0);
  const seen = useRef(spinId);
  const [angle, setAngle] = useState(() => rest(result));
  const [ball, setBall] = useState(0);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    if (seen.current === spinId) return;
    seen.current = spinId;
    // Una ronda nueva que se abre no mueve la rueda: queda donde quedó.
    if (result === null) return;
    if (reduceMotion()) { setAngle(rest(result)); setBall(0); onDone(spinId); return; }
    turns.current += 1;
    setSpinning(true);
    setAngle(rest(result) - 360 * 5 * turns.current);
    setBall(360 * 7 * turns.current);
    const id = window.setTimeout(() => {
      setSpinning(false); setBall(0); setAngle(rest(result) - 360 * 5 * turns.current); onDone(spinId);
    }, SPIN_MS);
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

// ─── El tablero ──────────────────────────────────────────────────────────────

interface CellDef { type: Bet['type']; n?: number; label: string; aria: string; cls: string; style?: CSSProperties }

/** Cada casillero lleva su fila y columna del paño (--r, --c) para acomodarlo en vertical (celular) o en horizontal (pantalla ancha). */
const ZERO: CellDef = { type: 'straight', n: 0, label: '0', aria: 'Pleno 0, verde', cls: 'rou-green rou-zero' };
const NUMBERS: CellDef[] = Array.from({ length: 36 }, (_, i) => {
  const n = i + 1;
  const row = Math.floor(i / 3); // 0 a 11
  const col = (i % 3) + 1; // 1 a 3
  return { type: 'straight' as const, n, label: String(n), aria: `Pleno ${n}, ${COLOR_LABEL[colorOf(n)]}`, cls: `rou-${colorOf(n)} rou-n`, style: { '--r': row, '--c': col } as CSSProperties };
});
const COLUMNS: CellDef[] = [1, 2, 3].map(n => ({ type: 'column', n, label: '2 a 1', aria: `2 a 1, columna ${n}`, cls: 'rou-out rou-col', style: { '--c': n } as CSSProperties }));
const DOZENS: CellDef[] = [1, 2, 3].map(n => ({ type: 'dozen', n, label: `${['1ª', '2ª', '3ª'][n - 1]} docena`, aria: `${n}ª docena, del ${n * 12 - 11} al ${n * 12}`, cls: 'rou-out rou-doz', style: { '--i': n - 1 } as CSSProperties }));
const OUTSIDE: CellDef[] = [
  { type: 'low', label: '1–18', aria: '1–18, del 1 al 18', cls: 'rou-out' },
  { type: 'even', label: 'Par', aria: 'Par', cls: 'rou-out' },
  { type: 'red', label: 'Rojo', aria: 'Rojo', cls: 'rou-red' },
  { type: 'black', label: 'Negro', aria: 'Negro', cls: 'rou-black' },
  { type: 'odd', label: 'Impar', aria: 'Impar', cls: 'rou-out' },
  { type: 'high', label: '19–36', aria: '19–36, del 19 al 36', cls: 'rou-out' },
].map((c, i) => ({ ...c, cls: `${c.cls} rou-simple`, style: { '--i': i } as CSSProperties }) as CellDef);
const CELLS: CellDef[] = [ZERO, ...NUMBERS, ...COLUMNS, ...DOZENS, ...OUTSIDE];

const same = (b: Bet, type: Bet['type'], n?: number) => b.type === type && (b.n ?? null) === (n ?? null);
const sumOf = (bets: Bet[]) => bets.reduce((t, b) => t + b.amount, 0);

/**
 * La ruleta ocupa el lugar de la mesa: los jugadores arriba, la rueda grande y, desde la mitad de la rueda hacia abajo, el
 * tablero para apostar. Mientras gira, el tablero se oculta y se ve la rueda entera; al terminar vuelve y aparece el resultado.
 *
 * Las fichas que ponés se guardan solas (no hay botón de apostar ni de «listo»): si no pusiste fichas, no apostás; si pusiste,
 * lo que tengas en el tablero se juega cuando gira. Arriba, junto a tu avatar, «Repetir jugada» pone lo de la ronda anterior.
 */
export function RouletteStage({ view, r, hand, fab, timer, onBets, onSpin }: {
  view: ApiTableView; r: ApiRouletteView; hand: ApiHandView; fab: ReactNode; timer: ReactNode;
  onBets: (bets: Bet[]) => Promise<void>; onSpin: () => void;
}) {
  const betting = r.status === 'betting';
  const acting = r.actingPlayerId !== null;
  const players = hand.players;
  const settledNow = r.status === 'done' && r.result !== null ? r.roundNo : null;
  // La ronda cuyo resultado ya se puede mostrar: la que estaba al abrir la página o la que terminó de girar la rueda.
  const [settled, setSettled] = useState<number | null>(settledNow);
  const spinning = settledNow !== null && settled !== settledNow;
  const shown = settledNow !== null && !spinning;

  // Borrador local de las apuestas: se guarda solo, de a una a la vez y sin pisar lo que seguís tocando.
  const [draft, setDraft] = useState<Bet[]>(r.mine);
  const [undo, setUndo] = useState<Bet[][]>([]);
  const [mult, setMult] = useState(1);
  const [hint, setHint] = useState('');
  const latest = useRef<Bet[]>(r.mine);
  const dirty = useRef(false);
  const saving = useRef(false);
  const again = useRef(false);
  const timerId = useRef<number | undefined>(undefined);
  const mineRef = useRef(r.mine);
  mineRef.current = r.mine;
  const mineKey = JSON.stringify(r.mine);
  useEffect(() => {
    if (dirty.current) return;
    latest.current = mineRef.current;
    setDraft(mineRef.current);
    setUndo([]);
  }, [mineKey, r.roundNo, r.status]);
  useEffect(() => () => window.clearTimeout(timerId.current), []);

  const flush = async (): Promise<void> => {
    if (saving.current) { again.current = true; return; }
    saving.current = true;
    try {
      await onBets(latest.current);
      setHint('');
    } catch (e) {
      // Lo que rechazó el servidor se descarta: vuelve a lo guardado.
      setHint(e instanceof Error ? e.message : 'No se pudo guardar la apuesta.');
      latest.current = mineRef.current;
      setDraft(mineRef.current);
      again.current = false;
    } finally {
      saving.current = false;
      if (again.current) { again.current = false; void flush(); } else dirty.current = false;
    }
  };
  const change = (next: Bet[], remember = true) => {
    if (remember) setUndo(u => [...u, latest.current]);
    latest.current = next;
    dirty.current = true;
    setDraft(next);
    window.clearTimeout(timerId.current);
    timerId.current = window.setTimeout(() => { void flush(); }, 250);
  };

  const chip = Math.min(r.minBet * mult, r.maxBet);
  const total = sumOf(draft);
  const mults = useMemo(() => [1, 2, 5, 10].filter(m => r.minBet * m <= r.maxBet), [r.minBet, r.maxBet]);
  const add = (type: Bet['type'], n?: number) => {
    if (!acting || spinning) return;
    if (total + chip > r.maxBet) { setHint(`Llegaste al máximo: ${formatMoney(r.maxBet)} por ronda.`); return; }
    setHint('');
    change(draft.some(b => same(b, type, n))
      ? draft.map(b => (same(b, type, n) ? { ...b, amount: b.amount + chip } : b))
      : [...draft, { type, ...(n !== undefined ? { n } : {}), amount: chip }]);
  };
  const amountOf = (type: Bet['type'], n?: number) => draft.find(b => same(b, type, n))?.amount ?? 0;
  const repeat = () => {
    if (sumOf(r.last) > r.maxBet) { setHint(`Esa jugada pasa el máximo: ${formatMoney(r.maxBet)} por ronda.`); return; }
    setHint('');
    change(r.last);
  };
  const canRepeat = acting && !spinning && r.last.length > 0 && JSON.stringify(r.last) !== JSON.stringify(draft);

  const cell = (c: CellDef) => {
    const amount = amountOf(c.type, c.n);
    return (
      <button key={`${c.type}-${c.n ?? ''}`} type="button" className={`rou-cell ${c.cls}${amount ? ' rou-has' : ''}`} style={c.style} disabled={!acting || spinning}
        onClick={() => add(c.type, c.n)} data-testid={`rou-cell-${c.type}${c.n !== undefined ? `-${c.n}` : ''}`}>
        <span aria-hidden="true">{c.label}</span>
        <span className="sr-only">{c.aria}{amount > 0 ? `, apostado ${formatMoney(amount)}` : ''}</span>
        {amount > 0 && <b className="rou-stake num" aria-hidden="true">{formatMoney(amount)}</b>}
      </button>
    );
  };

  const me = r.actingPlayerId ?? view.myPlayerId;
  const mineNet = r.nets.find(x => x.playerId === me)?.net;
  const myDelta = r.deltas.find(x => x.playerId === me)?.delta;
  const fromOthers = myDelta !== undefined ? myDelta - (mineNet ?? 0) : undefined;
  const recent = r.history.slice(spinning ? 1 : 0, spinning ? 9 : 8);

  return (
    <div className="felt-wrap rou-wrap">
      {fab}
      <section className="rou-table" aria-label="Ruleta" data-testid="rou">
        <div className="rou-seats">
          {players.map((p, i) => (
            <PlayerSeat key={p.playerId} inline view={view} hand={spinning ? { ...hand, payouts: [] } : hand} playerId={p.playerId} offset={0} total={players.length || i + 1}
              action={p.playerId === r.actingPlayerId ? (
                <button type="button" className="rou-repeat" disabled={!canRepeat} onClick={repeat} data-testid="rou-repeat">Repetir jugada</button>
              ) : undefined} />
          ))}
        </div>

        <div className="rou-last" data-testid="rou-last">
          {recent.length === 0
            ? <span className="muted xs">Todavía no salió ningún número</span>
            : recent.map((n, i) => <NumberChip key={`${n}-${i}`} n={n} big={i === 0} />)}
        </div>

        <div className="rou-wheelbox">
          <Wheel result={r.status === 'done' ? r.result : null} spinId={r.status === 'done' ? r.roundNo : -1} onDone={setSettled} />
        </div>

        <div className={`rou-bet-area${spinning ? ' rou-hidden' : ''}`} aria-hidden={spinning || undefined}>
          <div className="rou-chips" role="group" aria-label="Valor de la ficha">
            {mults.map(m => (
              <button key={m} type="button" className="rou-chipbtn" aria-pressed={m === mult} onClick={() => setMult(m)} data-testid={`rou-chip-${m}`}>
                {formatMoney(r.minBet * m)}
              </button>
            ))}
          </div>
          <div className="rou-board" role="group" aria-label="Tablero">{CELLS.map(cell)}</div>
        </div>

        <div className="rou-info">
          <h2 className="bj-title">Ruleta contra todos{r.roundNo > 0 ? ` · ronda ${r.roundNo}` : ''}</h2>

          {shown && (
            <div className="bj-result" role="status" data-testid="rou-result">
              <strong>Salió el <NumberChip n={r.result as number} /> {COLOR_LABEL[colorOf(r.result as number)]}.</strong>
              {mineNet !== undefined && <span className="small">Tus apuestas: <strong className={`num ${mineNet > 0 ? 'pos' : mineNet < 0 ? 'neg' : ''}`}>{signed(mineNet)}</strong>.</span>}
              {r.house !== null && (
                <span className="small" data-testid="rou-house">
                  {fromOthers !== undefined && fromOthers !== 0 && <>Por lo que apostaron los demás, {fromOthers > 0 ? 'cobrás' : 'pagás'} <strong className={`num ${fromOthers > 0 ? 'pos' : 'neg'}`}>{formatMoney(Math.abs(fromOthers))}</strong>. </>}
                  {myDelta !== undefined && <>En total, para vos: <strong className={`num ${myDelta > 0 ? 'pos' : myDelta < 0 ? 'neg' : ''}`}>{signed(myDelta)}</strong>. </>}
                  Lo que gana o pierde cada apostador se reparte en partes iguales entre los demás del grupo, estén o no conectados.
                </span>
              )}
            </div>
          )}

          {betting && <p className="small muted" role="status" data-testid="rou-status">Se está apostando{timer}. La bola gira cuando se acaba el tiempo{view.canHost ? ' o cuando toques «Girar ya»' : ''}.</p>}
          {!betting && !shown && !spinning && <p className="small muted" role="status">Tocá el tablero para apostar: la ronda arranca con la primera ficha. Si no ponés fichas, no apostás.</p>}
          {spinning && <p className="small muted" role="status">Girando…</p>}
          {!acting && <p className="muted small">Estás mirando: sentate (conectate) para apostar. De todos modos participás cuando otros ganan o pierden.</p>}

          <p className="small" data-testid="rou-total">
            Apostado <strong className="num">{formatMoney(total)}</strong> de {formatMoney(r.maxBet)} por ronda
            {draft.length > 0 && <> · {draft.length} {draft.length === 1 ? 'apuesta' : 'apuestas'}</>}
          </p>
          {hint && <p className="notice notice-err" role="alert">{hint}</p>}

          {acting && (
            <div className="rou-actions">
              <Btn variant="ghost" disabled={undo.length === 0 || spinning} onClick={() => { change(undo[undo.length - 1], false); setUndo(u => u.slice(0, -1)); setHint(''); }} data-testid="rou-undo">Deshacer</Btn>
              <Btn variant="ghost" disabled={draft.length === 0 || spinning} onClick={() => { change([]); setHint(''); }} data-testid="rou-clear">Borrar</Btn>
            </div>
          )}
          {betting && view.canHost && <Btn variant="ghost" block onClick={onSpin} data-testid="rou-spin">Girar ya</Btn>}
          <p className="xs muted">
            Un pleno paga 35 a 1; docenas y columnas, 2 a 1; el resto, 1 a 1. El 0 pierde las apuestas simples. No hay compra inicial: tu saldo puede quedar en negativo.
          </p>
          <p className="xs muted">La partida de ruleta se registra aparte: no cuenta en el ranking ni en las estadísticas.</p>
        </div>
      </section>
    </div>
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
