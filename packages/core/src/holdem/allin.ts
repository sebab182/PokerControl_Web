/** Suerte en los all-in: cuánto se esperaba ganar según las cartas, frente a lo que se ganó. */

import { equity } from './equity';
import type { HandState } from './hand';
import type { StreetName } from './analysis';

const BOARD_AT: Record<StreetName, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

export interface AllInSpot {
  /** Probabilidad de ganar cada jugador del showdown cuando se cerró la apuesta (con el board de esa calle). */
  equity: Record<string, number>;
  /** Neto esperado de cada jugador del showdown: lo que le correspondía de cada pozo según su equity, menos lo aportado. */
  evNet: Record<string, number>;
}

/**
 * Calcula la equity y el neto esperado de una mano terminada con showdown, tomando el board de la calle en que quedó
 * todo el dinero adentro. Los pozos laterales se reparten entre quienes pueden cobrarlos. Devuelve null si no hubo
 * showdown de al menos dos jugadores.
 */
export function allInSpot(final: HandState, street: StreetName): AllInSpot | null {
  const ids = final.showdown.map((e) => e.playerId);
  if (ids.length < 2) return null;
  const n = BOARD_AT[street];
  if (final.board.length < n) return null;
  const board = final.board.slice(0, n);
  const hole = (id: string) => final.showdown.find((e) => e.playerId === id)!.hole;

  const eq = equity({ holes: ids.map(hole), board });
  const equityById: Record<string, number> = {};
  ids.forEach((id, i) => { equityById[id] = eq[i]; });

  const evWon: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const pot of final.pots) {
    const who = pot.eligible.filter((id) => ids.includes(id));
    if (who.length === 0) continue;
    const e = who.length === ids.length ? who.map((id) => equityById[id]) : equity({ holes: who.map(hole), board });
    who.forEach((id, i) => { evWon[id] += pot.amount * e[i]; });
  }
  const evNet: Record<string, number> = {};
  for (const id of ids) {
    const invested = final.players.find((p) => p.id === id)?.totalBet ?? 0;
    evNet[id] = Math.round((evWon[id] - invested) * 100) / 100;
  }
  return { equity: equityById, evNet };
}
