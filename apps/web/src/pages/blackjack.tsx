import type { ApiBjView, ApiHandView, ApiTableView } from '@pokercontrol/contracts';
import { formatMoney, handValue, parseAmount } from '@pokercontrol/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyCard, PlayerSeat, PokerCard } from '../components/poker';
import { Btn, TextField } from '../components/ui';
import { playSfx } from '../sounds';

type BjAction = 'hit' | 'stand' | 'double';

/** Qué le pasó a quien jugó, en tercera persona o, si sos vos, en segunda. */
const RESULT_LABEL: Record<NonNullable<ApiBjView['result']>, { other: string; you: string }> = {
  blackjack: { other: 'hizo blackjack', you: 'hiciste blackjack' },
  win: { other: 'ganó la mano', you: 'ganaste la mano' },
  push: { other: 'empató con el croupier', you: 'empataste con el croupier' },
  lose: { other: 'perdió la mano', you: 'perdiste la mano' },
  bust: { other: 'se pasó de 21', you: 'te pasaste de 21' },
  skipped: { other: 'no pudo apostar', you: 'no pudiste apostar' },
};

const seatOf = (view: ApiTableView, id: string) => view.seats.find(s => s.playerId === id);
const nameOf = (view: ApiTableView, id: string) => { const s = seatOf(view, id); return s?.isYou ? 'Vos' : s?.name ?? 'Alguien'; };
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatMoney(Math.abs(n))}`;

/**
 * Lo que suman las cartas: un solo valor, o los dos cuando hay un as que cuenta como 11 o como 1 ("7 o 17").
 */
export function bjTotals(cards: string[]): string {
  const real = cards.filter(c => c !== '??');
  if (real.length === 0) return '';
  const { total, soft } = handValue(real);
  if (real.length === 2 && total === 21) return 'Blackjack · 21';
  if (total > 21) return `Se pasó · ${total}`;
  return soft ? `${total - 10} o ${total}` : String(total);
}

/** Fichas de cada uno en el paño: las de la mesa, o en el interludio las virtuales de su partida de blackjack aparte. */
function stackOf(bj: ApiBjView, seat: ApiTableView['seats'][number]): number {
  if (bj.kind !== 'interlude') return seat.stack;
  const delta = bj.phase === 'done' ? bj.deltas.find(d => d.playerId === seat.playerId)?.delta ?? 0 : 0;
  if (seat.playerId === bj.playerId) return bj.playerStack + delta;
  const rival = bj.rivals.find(r => r.playerId === seat.playerId);
  return rival ? rival.stack + delta : seat.stack;
}

/**
 * La mano de blackjack vista como una mano del paño de póker, para dibujarla con los mismos asientos (avatar, video,
 * emojis, posiciones): se sientan los conectados, las cartas del que juega van en su asiento y a la vista de todos.
 */
export function bjAsHand(view: ApiTableView, bj: ApiBjView): ApiHandView {
  const seated = view.seats.filter(s => s.status === 'sitting');
  const seats = seated.some(s => s.playerId === bj.playerId) ? seated : [...seated, ...view.seats.filter(s => s.playerId === bj.playerId)];
  const live = bj.phase !== 'done';
  return {
    handNo: bj.handId,
    gameHandNo: 0,
    street: live ? 'preflop' : 'done',
    board: [],
    pot: 0,
    currentBet: bj.bet,
    minRaise: bj.minBet,
    button: -1,
    toActPlayerId: live ? bj.playerId : null,
    players: seats.map(s => {
      const plays = s.playerId === bj.playerId;
      return {
        playerId: s.playerId, stack: stackOf(bj, s), bet: plays ? bj.bet : 0, totalBet: plays ? bj.bet : 0, folded: false, allIn: false, pending: false,
        hole: plays ? bj.player : [], shown: plays ? bj.player.map((_, i) => i) : [],
      };
    }),
    legal: null,
    actingPlayerId: bj.actingPlayerId,
    lastAction: null,
    payouts: bj.deltas.filter(d => d.delta > 0).map(d => ({ playerId: d.playerId, amount: d.delta })),
    showdown: [],
    runout: 0,
  };
}

/** Mezclar y repartir al empezar la mano, una carta cada vez que se pide y mostrar la carta tapada del croupier. */
function useBjSounds(bj: ApiBjView, enabled: boolean) {
  const seen = useRef<{ id: number; cards: number; revealed: boolean } | null>(null);
  useEffect(() => {
    const cards = bj.player.length + bj.dealer.length;
    const revealed = bj.phase === 'done' || !bj.dealer.includes('??');
    const before = seen.current;
    seen.current = { id: bj.handId, cards, revealed };
    if (!before || !enabled) return; // lo que ya estaba al abrir la página no suena
    if (bj.handId !== before.id) {
      playSfx('shuffle');
      for (let i = 0; i < cards; i++) playSfx('deal', { delayMs: 650 + i * 200, volume: 0.6 });
      return;
    }
    if (cards > before.cards) playSfx('deal', { volume: 0.7 });
    if (revealed && !before.revealed && bj.dealer.length >= 2) playSfx('show');
  }, [bj, enabled]);
}

/**
 * El paño del blackjack contra todos: la misma mesa que el póker. En el centro, las cartas del croupier; las del jugador
 * de turno van en su asiento. La banca son todos los jugadores del grupo, estén o no conectados.
 */
export function BjFelt({ view, bj, hand, fab }: { view: ApiTableView; bj: ApiBjView; hand: ApiHandView; fab: ReactNode }) {
  const players = hand.players;
  const myIdx = Math.max(0, players.findIndex(p => p.playerId === view.myPlayerId));
  const hero = players[myIdx];
  const heroSeat = view.seats.find(s => s.playerId === hero?.playerId);
  const heroCards = !!heroSeat && (heroSeat.isYou || heroSeat.managed) && !!hero && hero.hole.some(c => c !== '??');
  const hidden = bj.dealer.includes('??');
  return (
    <div className="felt-wrap">
      {fab}
      <div className={`felt${heroCards ? ' felt-hero' : ''}`} data-testid="felt">
        <div className="felt-center" data-testid="bj">
          <div className="pot num" data-testid="bj-bank">Contra la banca · {bj.rivals.length} {bj.rivals.length === 1 ? 'jugador' : 'jugadores'} del grupo</div>
          <div className="bj-dealer" role="group" aria-label="Croupier" data-testid="bj-dealer">
            {bj.dealer.length > 0
              ? bj.dealer.map((c, i) => <PokerCard key={`${c}${i}`} card={c} />)
              : [0, 1].map(i => <EmptyCard key={i} />)}
          </div>
          {bj.dealerTotal !== null && bj.dealer.length > 0 && (
            <div className="pot bj-dealer-total num" data-testid="bj-dealer-total">Croupier {bj.dealerTotal}{hidden ? '+' : ''}</div>
          )}
        </div>
        {players.map((p, i) => (
          <PlayerSeat key={p.playerId} view={view} hand={hand} playerId={p.playerId} offset={(i - myIdx + players.length) % players.length} total={players.length}
            note={p.playerId === bj.playerId && bj.player.length > 0 ? bjTotals(bj.player) : undefined} />
        ))}
      </div>
    </div>
  );
}

/** Lo que hay que decidir en cada momento, debajo del paño: apostar, pedir / plantarse / doblar, el resultado y repartir la siguiente. */
export function BjDock({ view, bj, busy, sound, canDeal, waiting, onBet, onAct, onDeal }: {
  view: ApiTableView; bj: ApiBjView; busy: boolean; sound: boolean; canDeal: boolean; waiting: ReactNode;
  onBet: (amount: number) => void; onAct: (action: BjAction) => void; onDeal: () => void;
}) {
  useBjSounds(bj, sound);
  const player = nameOf(view, bj.playerId);
  const you = player === 'Vos';
  const youPlay = bj.actingPlayerId !== null;
  const rivals = bj.rivals.length;
  const done = bj.phase === 'done';
  const interlude = bj.kind === 'interlude' && bj.position;
  const lastOfInterlude = !!bj.position && bj.position.index >= bj.position.total;
  const myDelta = bj.deltas.find(d => d.playerId === view.myPlayerId)?.delta;

  return (
    <section className="hand-dock bj-dock" aria-label="Tus acciones">
      <h2 className="bj-title">
        {interlude ? `Subieron las ciegas · blackjack ${bj.position?.index} de ${bj.position?.total}` : 'Blackjack contra todos'}
      </h2>

      {interlude && !bj.sessionClosed && (
        <p className="xs muted" data-testid="bj-aside">Esta vuelta se registra en una partida de blackjack aparte, con todo el grupo y sin compra inicial: no cambia tus fichas ni tus estadísticas del póker.</p>
      )}
      {bj.sessionClosed && (
        <p className="notice notice-ok" role="status" data-testid="bj-closed">
          Terminó la vuelta: la partida de blackjack se cerró. <Link to={`/sessions/${bj.sessionId}`}>Ver resultados y saldos</Link>
        </p>
      )}

      {bj.bet > 0 && (
        <p className="bj-bet" data-testid="bj-bet">
          {you ? 'Apostás' : `Apuesta ${player}:`} <strong className="num">{formatMoney(bj.bet)}</strong> por cabeza · en juego <strong className="num">{formatMoney(bj.bet * rivals)}</strong>
        </p>
      )}

      {bj.phase === 'betting' && (youPlay
        ? <BetControl key={bj.handId} bj={bj} rivals={rivals} busy={busy} onBet={onBet} />
        : <p className="muted center" role="status">{player} está eligiendo su apuesta…</p>)}

      {bj.phase === 'player' && (youPlay
        ? (
          <div className="bj-actions" role="group" aria-label="Tu jugada">
            <Btn busy={busy} onClick={() => onAct('hit')} data-testid="bj-hit">Pedir</Btn>
            <Btn variant="ghost" busy={busy} onClick={() => onAct('stand')} data-testid="bj-stand">Plantarse</Btn>
            {bj.canDouble && <Btn variant="ghost" busy={busy} onClick={() => onAct('double')} data-testid="bj-double">Doblar</Btn>}
          </div>
        )
        : <p className="muted center" role="status">{player} está decidiendo… <span className="num">{bj.playerTotal}</span></p>)}

      {done && (
        <div className="bj-result" role="status" data-testid="bj-result">
          <strong>
            {bj.result === 'skipped'
              ? `${you ? 'No tenías' : `${player} no tenía`} fichas suficientes para apostar: se saltea.`
              : `${you ? RESULT_LABEL[bj.result ?? 'lose'].you.replace(/^./, c => c.toUpperCase()) : `${player} ${RESULT_LABEL[bj.result ?? 'lose'].other}`} (${bj.playerTotal} contra ${bj.dealerTotal ?? '—'}).`}
          </strong>
          {bj.result !== 'skipped' && bj.deltas.length > 0 && (
            <span className="small">
              {signed(bj.deltas.find(d => d.playerId === bj.playerId)?.delta ?? 0)} para {you ? 'vos' : player}, que {you ? 'cobrás' : 'cobra'} de la banca por cabeza.
              {myDelta !== undefined && !you && myDelta !== 0 && <> Para vos: <strong className={`num ${myDelta > 0 ? 'pos' : 'neg'}`}>{signed(myDelta)}</strong>.</>}
            </span>
          )}
        </div>
      )}

      {done && canDeal && (
        <Btn block busy={busy} onClick={onDeal} data-testid="bj-next">
          {interlude ? (lastOfInterlude ? 'Seguir con el póker' : 'Siguiente mano de blackjack') : 'Repartir próxima mano'}
        </Btn>
      )}
      {done && !canDeal && waiting}
    </section>
  );
}

function BetControl({ bj, rivals, busy, onBet }: { bj: ApiBjView; rivals: number; busy: boolean; onBet: (amount: number) => void }) {
  const [text, setText] = useState(String(bj.minBet));
  const [error, setError] = useState('');
  const submit = () => {
    const n = parseAmount(text);
    if (n === null || !Number.isInteger(n) || n < bj.minBet || n > bj.maxBet) return setError(`Apostá un monto entero entre ${formatMoney(bj.minBet)} y ${formatMoney(bj.maxBet)}.`);
    setError('');
    onBet(n);
  };
  const n = parseAmount(text);
  const valid = n !== null && Number.isInteger(n) && n >= bj.minBet && n <= bj.maxBet;
  return (
    <div className="bj-bet-box" role="group" aria-label="Tu apuesta">
      <TextField label={`Tu apuesta (mínimo ${formatMoney(bj.minBet)}, tope ${formatMoney(bj.maxBet)})`} value={text} onChange={setText} decimal />
      <div className="row-wrap">
        <Btn variant="ghost" onClick={() => setText(String(bj.minBet))}>Mínima</Btn>
        <Btn variant="ghost" onClick={() => setText(String(Math.max(bj.minBet, Math.floor(bj.maxBet / 2))))}>Mitad del tope</Btn>
        <Btn variant="ghost" onClick={() => setText(String(bj.maxBet))}>Tope</Btn>
      </div>
      <p className="xs muted">
        Cada uno de la banca ({rivals}) pone lo mismo. No hay compra inicial: tu saldo puede quedar en negativo.
        {valid && n !== null && <> Si perdés, pagás {formatMoney(n * rivals)} ({formatMoney(n * rivals * 2)} si doblás).</>}
      </p>
      {error && <p className="notice notice-err" role="alert">{error}</p>}
      <Btn block busy={busy} onClick={submit} data-testid="bj-bet-button">Apostar{valid && n !== null ? ` ${formatMoney(n)}` : ''}</Btn>
    </div>
  );
}
