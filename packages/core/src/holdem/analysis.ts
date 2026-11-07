/**
 * Historial de manos para analizar cómo juega cada uno. Todo es puro: el servidor llama a estas funciones al jugar
 * cada acción (describeAction) y al terminar la mano (summarizeHand), y al reconstruir manos viejas.
 */

import type { Card } from './cards';
import { legalActions, type Action, type HandState } from './hand';

export type StreetName = 'preflop' | 'flop' | 'turn' | 'river';

/** Tipo de jugada para analizar: un all-in cuenta como subida si subía la apuesta y como igualar si no. */
export type ActionKind = 'fold' | 'check' | 'call' | 'raise';

/** La situación en que se jugó una acción, tomada del estado justo antes de aplicarla. */
export interface ActionSpot {
  street: StreetName;
  kind: ActionKind;
  /** call: lo igualado; raise: el total al que subió; fold/check: null. */
  amount: number | null;
  /** Pozo antes de la jugada (lo apostado por todos hasta ahí). */
  potBefore: number;
  /** Lo que había que igualar. */
  toCall: number;
  /** Fichas del jugador antes de la jugada. */
  stackBefore: number;
  /** Jugadores que seguían en la mano (sin retirarse, con fichas o all-in; sin contar a los pendientes de recompra). */
  playersLeft: number;
}

/** Una jugada ya registrada, con lo que hace falta para resumir la mano. */
export interface RecordedAction {
  playerId: string;
  street: StreetName;
  kind: ActionKind;
  amount: number | null;
  /** La jugó el servidor por tiempo agotado. */
  auto: boolean;
}

const pot = (s: HandState): number => s.players.reduce((sum, p) => sum + p.totalBet, 0);

/** Describe la acción que está por aplicarse al jugador al que le toca. `state` es el estado antes de aplicarla. */
export function describeAction(state: HandState, action: Action): ActionSpot | null {
  const legal = legalActions(state);
  if (!legal || state.street === 'done') return null;
  const p = state.players[state.toAct];
  let kind: ActionKind;
  let amount: number | null = null;
  switch (action.type) {
    case 'fold': kind = 'fold'; break;
    case 'check': kind = 'check'; break;
    case 'call': kind = 'call'; amount = legal.callAmount; break;
    case 'raise': kind = 'raise'; amount = action.to; break;
    case 'allin':
      // Todo el stack: sube si estaba habilitado a subir; si no, solo iguala (o pasa si no había nada que igualar).
      if (legal.canRaise) { kind = 'raise'; amount = legal.maxRaiseTo; }
      else if (legal.canCall) { kind = 'call'; amount = legal.callAmount; }
      else kind = 'check';
      break;
  }
  return {
    street: state.street,
    kind,
    amount,
    potBefore: pot(state),
    toCall: legal.toCall,
    stackBefore: p.stack,
    playersLeft: state.players.filter((x) => !x.folded && !x.pending).length,
  };
}

/**
 * Posición de cada jugador respecto del botón, calculada con el estado al repartir. El botón y las ciegas se reparten
 * entre quienes tienen fichas; los pendientes de recompra no tienen posición. Con dos jugadores el botón es la ciega chica.
 * `index`: 0 = botón, 1 = ciega chica, 2 = ciega grande, 3 en adelante = primeros en hablar.
 */
export function handPositions(state: HandState): Record<string, { position: string; index: number }> {
  const funded = state.players.map((p, i) => (p.pending ? -1 : i)).filter((i) => i >= 0);
  const m = funded.length;
  const out: Record<string, { position: string; index: number }> = {};
  if (m === 0) return out;
  const start = Math.max(0, funded.indexOf(state.button));
  for (let k = 0; k < m; k++) {
    const player = state.players[funded[(start + k) % m]];
    let position: string;
    if (m === 2) position = k === 0 ? 'BTN/SB' : 'BB';
    else if (k === 0) position = 'BTN';
    else if (k === 1) position = 'SB';
    else if (k === 2) position = 'BB';
    else {
      const later = m - 3; // jugadores después de la ciega grande
      const j = k - 3;
      position = j === later - 1 && later >= 2 ? 'CO' : j === 0 ? 'UTG' : `UTG+${j}`;
    }
    out[player.id] = { position, index: k };
  }
  return out;
}

export interface PlayerHandSummary {
  playerId: string;
  /** Total aportado al pozo en la mano. */
  invested: number;
  /** Total cobrado del pozo. */
  won: number;
  /** won − invested: lo ganado o perdido en la mano, sin contar fichas compradas. */
  net: number;
  /** Calle en la que se retiró; null si no se retiró. */
  foldedStreet: StreetName | null;
  /** Vio el flop: no se retiró antes y no estaba pendiente de recompra. */
  sawFlop: boolean;
  /** Puso fichas voluntariamente antes del flop (igualó o subió; las ciegas no cuentan). */
  vpip: boolean;
  /** Subió antes del flop. */
  pfr: boolean;
  raises: number;
  calls: number;
  checks: number;
  folds: number;
  /** Jugadas que hizo el servidor por tiempo agotado. */
  autoActions: number;
  allIn: boolean;
  /** Llegó al showdown. */
  showdown: boolean;
  wonShowdown: boolean;
}

export interface HandSummary {
  pot: number;
  board: Card[];
  /** Calle en la que terminó la mano (por las cartas del board). */
  endedOn: StreetName;
  wentToShowdown: boolean;
  players: PlayerHandSummary[];
}

const STREET_BY_BOARD: Record<number, StreetName> = { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' };

/** Resume una mano terminada a partir de su estado final y de las jugadas registradas (en orden). */
export function summarizeHand(final: HandState, actions: RecordedAction[]): HandSummary {
  const showdownIds = new Set(final.showdown.map((e) => e.playerId));
  const players = final.players.map((p): PlayerHandSummary => {
    const mine = actions.filter((a) => a.playerId === p.id);
    const preflop = mine.filter((a) => a.street === 'preflop');
    const won = final.payouts.filter((w) => w.playerId === p.id).reduce((sum, w) => sum + w.amount, 0);
    const foldedStreet = mine.find((a) => a.kind === 'fold')?.street ?? null;
    return {
      playerId: p.id,
      invested: p.totalBet,
      won,
      net: won - p.totalBet,
      foldedStreet,
      // El pendiente que nunca recompró (sigue pendiente al final) tiene cartas pero no jugó: no vio nada.
      sawFlop: final.board.length >= 3 && foldedStreet !== 'preflop' && !p.pending,
      vpip: preflop.some((a) => a.kind === 'call' || a.kind === 'raise'),
      pfr: preflop.some((a) => a.kind === 'raise'),
      raises: mine.filter((a) => a.kind === 'raise').length,
      calls: mine.filter((a) => a.kind === 'call').length,
      checks: mine.filter((a) => a.kind === 'check').length,
      folds: mine.filter((a) => a.kind === 'fold').length,
      autoActions: mine.filter((a) => a.auto).length,
      allIn: p.allIn,
      showdown: showdownIds.has(p.id),
      wonShowdown: showdownIds.has(p.id) && won > 0,
    };
  });
  return {
    pot: pot(final),
    board: final.board,
    endedOn: STREET_BY_BOARD[final.board.length] ?? 'river',
    wentToShowdown: final.showdown.length > 0,
    players,
  };
}
