import type { BjResult } from './blackjack';

export interface BjHandSummary { playerId: string; result: BjResult | null; delta: number }

export interface BjStats {
  hands: number;
  /** Cómo les fue a quienes jugaron su mano contra el croupier. */
  wins: number;
  pushes: number;
  losses: number;
  blackjacks: number;
  busts: number;
  /** La mayor ganancia y la mayor pérdida de un jugador en una sola mano. */
  best: { playerId: string; delta: number } | null;
  worst: { playerId: string; delta: number } | null;
}

/** Análisis mínimo de una partida de blackjack. Las manos salteadas no cuentan. */
export function analyzeBlackjack(hands: BjHandSummary[]): BjStats {
  const out: BjStats = { hands: 0, wins: 0, pushes: 0, losses: 0, blackjacks: 0, busts: 0, best: null, worst: null };
  for (const h of hands) {
    if (!h.result || h.result === 'skipped') continue;
    out.hands++;
    if (h.result === 'blackjack') { out.wins++; out.blackjacks++; }
    else if (h.result === 'win') out.wins++;
    else if (h.result === 'push') out.pushes++;
    else { out.losses++; if (h.result === 'bust') out.busts++; }
    if (h.delta > 0 && (!out.best || h.delta > out.best.delta)) out.best = { playerId: h.playerId, delta: h.delta };
    if (h.delta < 0 && (!out.worst || h.delta < out.worst.delta)) out.worst = { playerId: h.playerId, delta: h.delta };
  }
  return out;
}
