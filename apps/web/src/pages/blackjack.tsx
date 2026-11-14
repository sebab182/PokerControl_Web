import type { ApiBjView, ApiTableView } from '@pokercontrol/contracts';
import { formatMoney, parseAmount } from '@pokercontrol/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PokerCard } from '../components/poker';
import { Avatar, Btn, Emoji, TextField } from '../components/ui';
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
 * Mano de blackjack «contra todos»: un jugador contra el croupier y, por cabeza, contra todos los demás. Se muestra
 * en el lugar de la mano de póker mientras dura (y hasta que se reparte la que sigue).
 */
export function BlackjackTable({ view, bj, busy, sound, timer, canDeal, waiting, onBet, onAct, onDeal }: {
  view: ApiTableView; bj: ApiBjView; busy: boolean; sound: boolean; timer: ReactNode; canDeal: boolean; waiting: ReactNode;
  onBet: (amount: number) => void; onAct: (action: BjAction) => void; onDeal: () => void;
}) {
  useBjSounds(bj, sound);
  const player = nameOf(view, bj.playerId);
  const youPlay = bj.actingPlayerId !== null;
  const rivals = bj.rivals.length;
  const done = bj.phase === 'done';
  const interlude = bj.kind === 'interlude' && bj.position;
  const lastOfInterlude = !!bj.position && bj.position.index >= bj.position.total;
  const myDelta = bj.deltas.find(d => d.playerId === view.myPlayerId)?.delta;

  return (
    <section className="bj" aria-label="Blackjack contra todos" data-testid="bj">
      <header className="bj-head">
        <h2>
          <Emoji>🂡</Emoji>{' '}
          {interlude ? `Subieron las ciegas · blackjack ${bj.position?.index} de ${bj.position?.total}` : 'Blackjack contra todos'}
        </h2>
        {!done && timer}
      </header>
      <p className="muted small bj-rule">
        {player === 'Vos' ? 'Jugás' : `Juega ${player}`} contra el croupier y contra {rivals === 1 ? 'el otro jugador' : `los otros ${rivals}`}: cada uno pone la misma apuesta.
        Si {player === 'Vos' ? 'ganás' : 'gana'}, {player === 'Vos' ? 'cobrás' : 'cobra'} a cada uno; si {player === 'Vos' ? 'perdés' : 'pierde'}, {player === 'Vos' ? 'le pagás' : 'le paga'} a cada uno.
      </p>

      <div className="bj-hands">
        <div className="bj-hand" aria-label="Croupier">
          <strong>Croupier</strong>
          <div className="bj-cards" data-testid="bj-dealer">
            {bj.dealer.length ? bj.dealer.map((c, i) => <PokerCard key={`${c}${i}`} card={c} size="md" />) : <span className="muted small">Sin cartas todavía</span>}
          </div>
          {bj.dealerTotal !== null && bj.dealer.length > 0 && <span className="num bj-total" data-testid="bj-dealer-total">{bj.dealerTotal}{bj.dealer.includes('??') ? '+' : ''}</span>}
        </div>
        <div className="bj-hand" aria-label={`Mano de ${player}`}>
          <strong>{player === 'Vos' ? 'Tu mano' : `Mano de ${player}`}</strong>
          <div className="bj-cards" data-testid="bj-player">
            {bj.player.length ? bj.player.map((c, i) => <PokerCard key={`${c}${i}`} card={c} size="md" />) : <span className="muted small">Todavía no apostó</span>}
          </div>
          {bj.player.length > 0 && <span className="num bj-total" data-testid="bj-player-total">{bj.playerTotal}</span>}
        </div>
      </div>

      {bj.bet > 0 && (
        <p className="bj-bet" data-testid="bj-bet">
          Apuesta <strong className="num">{formatMoney(bj.bet)}</strong> por cabeza · en juego <strong className="num">{formatMoney(bj.bet * rivals)}</strong>
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
        : <p className="muted center" role="status">{player} está decidiendo…</p>)}

      {done && (
        <div className="bj-result" role="status" data-testid="bj-result">
          <strong>
            {bj.result === 'skipped'
              ? `${player === 'Vos' ? 'No tenías' : `${player} no tenía`} fichas suficientes para apostar: se saltea.`
              : `${player === 'Vos' ? RESULT_LABEL[bj.result ?? 'lose'].you.replace(/^./, c => c.toUpperCase()) : `${player} ${RESULT_LABEL[bj.result ?? 'lose'].other}`}.`}
          </strong>
          {bj.result !== 'skipped' && (
            <ul className="bj-deltas">
              {bj.deltas.map(d => (
                <li key={d.playerId}><span>{nameOf(view, d.playerId)}</span> <strong className={`num ${d.delta > 0 ? 'pos' : d.delta < 0 ? 'neg' : ''}`}>{signed(d.delta)}</strong></li>
              ))}
            </ul>
          )}
          {myDelta !== undefined && myDelta !== 0 && bj.result !== 'skipped' && (
            <p className="small">{myDelta > 0 ? 'Ganaste' : 'Perdiste'} {formatMoney(Math.abs(myDelta))} en esta mano.</p>
          )}
        </div>
      )}

      {done && canDeal && (
        <Btn block busy={busy} onClick={onDeal} data-testid="bj-next">
          {interlude ? (lastOfInterlude ? 'Seguir con el póker' : 'Siguiente mano de blackjack') : 'Repartir próxima mano'}
        </Btn>
      )}
      {done && !canDeal && waiting}

      <div className="bj-stacks" aria-label="Fichas">
        {view.seats.map(s => (
          <div key={s.playerId} className={`bj-stack${s.playerId === bj.playerId ? ' bj-stack-active' : ''}`}>
            <Avatar name={s.name} />
            <span className="small">{s.isYou ? `${s.name} (vos)` : s.name}</span>
            <strong className="num">{formatMoney(s.stack)}</strong>
          </div>
        ))}
      </div>
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
        El tope cubre que dobles: {rivals === 1 ? 'el otro jugador pone' : `cada uno de los otros ${rivals} pone`} lo mismo y nadie queda debiendo más de lo que tiene.
        {valid && n !== null && <> Si perdés, pagás hasta {formatMoney(n * rivals * 2)} doblando.</>}
      </p>
      {error && <p className="notice notice-err" role="alert">{error}</p>}
      <Btn block busy={busy} onClick={submit} data-testid="bj-bet-button">Apostar{valid && n !== null ? ` ${formatMoney(n)}` : ''}</Btn>
    </div>
  );
}
