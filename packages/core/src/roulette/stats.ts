import { betNet, colorOf, type Bet } from './roulette';

export interface RouletteRound { result: number; bets: Record<string, Bet[]> }

export interface RouletteStats {
  rounds: number;
  red: number;
  black: number;
  zero: number;
  /** Los números que más salieron (al menos 2 veces), de más a menos. */
  hot: { n: number; count: number }[];
  /** Cuántas rondas seguidas, hasta la última, salió el mismo color (el cero cuenta como verde). */
  streak: { color: 'red' | 'black' | 'green'; count: number } | null;
  /** Total apostado por todos en la partida. */
  wagered: number;
  /** La mayor ganancia y la mayor pérdida de un jugador en una sola ronda (con sus apuestas, sin el reparto). */
  best: { playerId: string; net: number } | null;
  worst: { playerId: string; net: number } | null;
}

/** Análisis mínimo de una partida de ruleta. Recibe las rondas jugadas, de la más nueva a la más vieja. */
export function analyzeRoulette(rounds: RouletteRound[]): RouletteStats {
  const counts = new Map<number, number>();
  let red = 0, black = 0, zero = 0, wagered = 0;
  let best: RouletteStats['best'] = null;
  let worst: RouletteStats['worst'] = null;
  for (const r of rounds) {
    counts.set(r.result, (counts.get(r.result) ?? 0) + 1);
    const color = colorOf(r.result);
    if (color === 'red') red++; else if (color === 'black') black++; else zero++;
    for (const [playerId, bets] of Object.entries(r.bets)) {
      wagered += bets.reduce((t, b) => t + b.amount, 0);
      const net = bets.reduce((t, b) => t + betNet(b, r.result), 0);
      if (net > 0 && (!best || net > best.net)) best = { playerId, net };
      if (net < 0 && (!worst || net < worst.net)) worst = { playerId, net };
    }
  }
  const hot = [...counts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3)
    .map(([n, count]) => ({ n, count }));
  let streak: RouletteStats['streak'] = null;
  if (rounds.length > 0) {
    const color = colorOf(rounds[0].result);
    let count = 0;
    for (const r of rounds) { if (colorOf(r.result) !== color) break; count++; }
    streak = { color, count };
  }
  return { rounds: rounds.length, red, black, zero, hot, streak, wagered, best, worst };
}
