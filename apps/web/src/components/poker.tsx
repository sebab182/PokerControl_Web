import type { ApiHandView, ApiTableView } from '@pokercontrol/contracts';
import { formatMoney } from '@pokercontrol/core';
import { Avatar } from './ui';

const SUIT = { s: { sym: '♠', name: 'picas', red: false }, h: { sym: '♥', name: 'corazones', red: true },
  d: { sym: '♦', name: 'diamantes', red: true }, c: { sym: '♣', name: 'tréboles', red: false } } as const;
const RANK_NAME: Record<string, string> = { A: 'as', K: 'rey', Q: 'reina', J: 'jota', T: '10' };

/** Carta con su nombre accesible. "??" es una carta oculta (dorso). */
export function PokerCard({ card, size = 'md' }: { card: string; size?: 'sm' | 'md' | 'lg' }) {
  if (card === '??') {
    return <span role="img" aria-label="Carta oculta" className={`pcard pcard-back pcard-${size}`} />;
  }
  const suit = SUIT[card[1] as keyof typeof SUIT];
  const rank = card[0] === 'T' ? '10' : card[0];
  return (
    <span role="img" aria-label={`${RANK_NAME[card[0]] ?? card[0]} de ${suit.name}`}
      className={`pcard pcard-${size} ${suit.red ? 'pcard-red' : ''}`}>
      <span aria-hidden="true">{rank}{suit.sym}</span>
    </span>
  );
}

/** Lugar vacío del board (todavía sin repartir). */
export function EmptyCard({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span aria-hidden="true" className={`pcard pcard-empty pcard-${size}`} />;
}

/** Posición (en %) de cada asiento alrededor de la mesa; yo siempre abajo, en sentido horario. */
export function seatPosition(offset: number, total: number): { left: string; top: string } {
  const angle = (Math.PI / 2) + (offset * 2 * Math.PI) / total;
  return { left: `${50 + 50 * Math.cos(angle)}%`, top: `${50 + 50 * Math.sin(angle)}%` };
}

export function PlayerSeat({ view, hand, playerId, offset, total, showCards }: {
  view: ApiTableView; hand: ApiHandView; playerId: string; offset: number; total: number; showCards: boolean;
}) {
  const p = hand.players.find(x => x.playerId === playerId);
  const seat = view.seats.find(s => s.playerId === playerId);
  if (!p || !seat) return null;
  const turn = hand.toActPlayerId === playerId;
  const dealer = hand.players[hand.button]?.playerId === playerId;
  const won = hand.payouts.find(x => x.playerId === playerId);
  const status = p.folded ? 'Retirado' : p.allIn ? 'All-in' : null;
  return (
    <div className={`pseat ${turn ? 'pseat-turn' : ''} ${p.folded ? 'pseat-folded' : ''} ${won ? 'pseat-won' : ''}`}
      style={seatPosition(offset, total)} data-testid={`seat-${seat.name}`}>
      <div className="pseat-cards">
        {!p.folded && showCards && p.hole.map((c, i) => <PokerCard key={i} card={c} size="sm" />)}
      </div>
      <Avatar name={seat.name} />
      <div className="pseat-name ellipsis">{seat.isYou ? 'Vos' : seat.name}{dealer && <span className="dealer" title="Botón"> D</span>}</div>
      <div className="pseat-stack num">{formatMoney(p.stack)}</div>
      {p.bet > 0 && <div className="pseat-bet num">Apuesta {formatMoney(p.bet)}</div>}
      {status && <div className="pseat-status">{status}</div>}
      {turn && <div className="pseat-status">{seat.isYou ? 'Tu turno' : 'Piensa…'}</div>}
      {won && <div className="pseat-status">+{formatMoney(won.amount)}</div>}
    </div>
  );
}
