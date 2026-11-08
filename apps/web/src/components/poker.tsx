import type { ApiHandView, ApiTableView } from '@pokercontrol/contracts';
import { evaluate, formatMoney } from '@pokercontrol/core';
import type { CSSProperties } from 'react';
import { StreamVideo, useSeatStream, useVideo } from '../video';
import { Avatar } from './ui';

const SUIT = { s: { sym: '♠', name: 'picas', red: false }, h: { sym: '♥', name: 'corazones', red: true },
  d: { sym: '♦', name: 'diamantes', red: true }, c: { sym: '♣', name: 'tréboles', red: false } } as const;
const RANK_NAME: Record<string, string> = { A: 'as', K: 'rey', Q: 'reina', J: 'jota', T: '10' };

/** Texto corto de una carta, p. ej. "10♠". */
export function cardText(card: string): string {
  return `${card[0] === 'T' ? '10' : card[0]}${SUIT[card[1] as keyof typeof SUIT].sym}`;
}

/** Carta con su nombre accesible. "??" es una carta oculta (dorso). */
/**
 * Al terminar una mano con showdown, las cartas que forman alguna jugada ganadora; null si no hay que marcar nada.
 * Las demás de la mesa (y las mostradas) se atenúan.
 */
export function winningCards(hand: ApiHandView): Set<string> | null {
  if (hand.street !== 'done') return null;
  const cards = hand.payouts.flatMap(w => w.cards ?? []);
  return cards.length > 0 ? new Set(cards) : null;
}

/** Marca de una carta al final de la mano: forma la jugada ganadora o queda atenuada. */
export const markOf = (win: Set<string> | null, card: string) => (win ? (win.has(card) ? 'win' : 'dim') : undefined);

export function PokerCard({ card, size = 'md', mark, own = false }: {
  card: string; size?: 'sm' | 'md' | 'lg'; mark?: 'win' | 'dim';
  /** Carta propia que los demás todavía no ven. */
  own?: boolean;
}) {
  if (card === '??') {
    return <span role="img" aria-label="Carta oculta" className={`pcard pcard-back pcard-${size}`} />;
  }
  const suit = SUIT[card[1] as keyof typeof SUIT];
  const rank = card[0] === 'T' ? '10' : card[0];
  return (
    <span role="img" aria-label={`${RANK_NAME[card[0]] ?? card[0]} de ${suit.name}${mark === 'win' ? ', de la jugada ganadora' : ''}`}
      className={`pcard pcard-${size} pcard-suit-${card[1]} ${suit.red ? 'pcard-red' : ''}${mark ? ` pcard-${mark}` : ''}${own ? ' pcard-own' : ''}`}>
      {/* Diseño de naipe clásico: índice arriba a la izquierda (y al revés abajo) y el palo grande al centro. */}
      <span className="pcard-corner" aria-hidden="true"><span>{rank}</span><span>{suit.sym}</span></span>
      <span className="pcard-pip" aria-hidden="true">{suit.sym}</span>
      <span className="pcard-corner pcard-corner-br" aria-hidden="true"><span>{rank}</span><span>{suit.sym}</span></span>
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

/**
 * Hacia dónde correr la imagen agrandada de quien piensa: hacia el centro de la mesa (-1 a 1 en cada eje, según el
 * asiento). Así los asientos de los costados no se salen de la pantalla ni tapan el borde de arriba.
 */
export function seatInward(offset: number, total: number): CSSProperties {
  const angle = (Math.PI / 2) + (offset * 2 * Math.PI) / total;
  return { '--in-x': (-Math.cos(angle)).toFixed(2), '--in-y': (-Math.sin(angle)).toFixed(2) } as CSSProperties;
}

/**
 * Contador de recompras y neto de esta partida (fichas ahora menos compradas), en una línea: "↻2 · +$340".
 * El signo acompaña siempre al color; para lectores de pantalla va escrito completo.
 */
export function SeatScore({ seat }: { seat: { rebuys: number; net: number } }) {
  const { rebuys, net } = seat;
  const tone = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
  const spoken = `${rebuys} ${rebuys === 1 ? 'recompra' : 'recompras'}, ${net > 0 ? `ganó ${formatMoney(net)}` : net < 0 ? `perdió ${formatMoney(-net)}` : 'sin ganancia ni pérdida'}`;
  return (
    <span className="seat-score num" data-testid="seat-score">
      <span aria-hidden="true">↻{rebuys} · <span className={tone}>{net === 0 ? '$0' : `${net > 0 ? '+' : '−'}${formatMoney(Math.abs(net))}`}</span></span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

/**
 * Un asiento del paño. Las cartas propias (las tuyas y las de los jugadores sin usuario que manejás) van en el asiento:
 * en el tuyo, abajo y grandes, con el nombre de tu jugada; en los demás, chicas en abanico sobre el avatar.
 */
export function PlayerSeat({ view, hand, playerId, offset, total }: {
  view: ApiTableView; hand: ApiHandView; playerId: string; offset: number; total: number;
}) {
  const video = useVideo();
  const stream = useSeatStream(playerId);
  const p = hand.players.find(x => x.playerId === playerId);
  const seat = view.seats.find(s => s.playerId === playerId);
  if (!p || !seat) return null;
  const turn = hand.toActPlayerId === playerId;
  const dealer = hand.players[hand.button]?.playerId === playerId;
  const won = hand.payouts.find(x => x.playerId === playerId);
  const win = winningCards(hand);
  const status = p.folded ? 'Retirado' : p.allIn ? 'All-in' : p.pending ? 'Sin fichas' : null;
  const mine = seat.isYou || seat.managed;
  // Se ve lo que se mostró y, en los asientos propios, también lo que solo ves vos.
  const cards = p.hole.flatMap((c, i) => c !== '??' && (p.shown.includes(i) || mine) ? [{ c, i, own: !p.shown.includes(i) }] : []);
  const hero = offset === 0 && mine && cards.length > 0;
  const handName = mine && !p.folded && p.hole.length + hand.board.length >= 5 && !p.hole.includes('??')
    ? evaluate([...p.hole, ...hand.board]).name : null;
  const name = seat.isYou ? 'Vos' : seat.name;
  // Con cámara se ve el video; si solo transmite el micrófono se ve la inicial, con el audio sonando y un ícono de micrófono.
  const hasPicture = !!stream && stream.getVideoTracks().length > 0;
  const avatar = stream && hasPicture
    ? <StreamVideo stream={stream} className="pseat-video" muted={seat.isYou || video?.muteOthers} mirrored={seat.isYou} />
    : (
      <span className="pseat-face">
        <Avatar name={seat.name} />
        {stream && (
          <>
            <StreamVideo stream={stream} className="pseat-audio" muted={seat.isYou || video?.muteOthers} />
            <span className="pseat-mic" role="img" aria-label="Micrófono activo">🎙️</span>
          </>
        )}
      </span>
    );
  const chips = (
    <>
      {p.bet > 0 && <div className="pseat-bet num">Apuesta {formatMoney(p.bet)}</div>}
      {status && <div className="pseat-status">{status}</div>}
      {turn && <div className="pseat-status">{seat.isYou ? 'Tu turno' : seat.managed ? 'Jugás vos' : 'Piensa…'}</div>}
      {won && <div className="pseat-status">+{formatMoney(won.amount)}</div>}
    </>
  );
  const holeCards = cards.map(x => <PokerCard key={x.i} card={x.c} size={hero ? 'lg' : 'sm'} mark={markOf(win, x.c)} own={x.own} />);
  return (
    <div className={`pseat ${hero ? 'pseat-hero' : ''} ${turn ? 'pseat-turn' : ''} ${turn && !mine ? 'pseat-thinking' : ''} ${p.folded ? 'pseat-folded' : ''} ${won ? 'pseat-won' : ''}`}
      style={{ ...seatPosition(offset, total), ...(turn && !mine ? seatInward(offset, total) : {}) }} data-testid={`seat-${seat.name}`} data-player={playerId}>
      {hero ? (
        <>
          <div className="pseat-hole" data-testid="my-hand">{holeCards}</div>
          {/* Los avisos van al costado de tu nombre y no debajo: así tu asiento no crece hacia el centro de la mesa. */}
          <div className="pseat-hero-row">
            <div className="pseat-hero-tag">
              {avatar}
              <span className="pseat-hero-info">
                <span className="pseat-name"><span className="ellipsis">{name}</span>{dealer && <span className="dealer" title="Botón">D</span>}</span>
                <span className="pseat-stack num">{formatMoney(p.stack)}</span>
                <SeatScore seat={seat} />
                {handName && <span className="pseat-handname">{handName}</span>}
              </span>
            </div>
            {chips}
          </div>
        </>
      ) : (
        <>
          {/* Las mostradas y las propias, en abanico sobre el avatar: no chocan con otros asientos ni con el centro. */}
          <div className="pseat-cards" {...(mine && cards.length > 0 ? { 'data-testid': 'my-hand' } : {})}>{holeCards}</div>
          {avatar}
          <div className="pseat-tag">
            {/* El botón (D) va aparte del nombre: si el nombre no entra se corta con "…", pero la D siempre se ve. */}
            <span className="pseat-name"><span className="ellipsis">{name}</span>{dealer && <span className="dealer" title="Botón">D</span>}</span>
            <span className="pseat-stack num">{formatMoney(p.stack)}</span>
            <SeatScore seat={seat} />
          </div>
        </>
      )}
      {!hero && chips}
    </div>
  );
}
