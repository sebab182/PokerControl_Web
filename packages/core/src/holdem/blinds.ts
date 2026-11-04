/**
 * Ciegas que se duplican con el tiempo. Puro: solo calcula el nivel a partir de cuánto pasó.
 * El servidor lo evalúa al repartir cada mano, así que las ciegas nunca cambian en medio de una.
 */

export interface BlindLevelInput {
  /** Ciegas base (nivel 0). */
  smallBlind: number;
  bigBlind: number;
  /** Entrada por jugador: la ciega grande no pasa de la mitad. */
  buyIn: number;
  /** Cada cuántos minutos se duplican; 0 = nunca. */
  minutes: number;
  /** Tiempo transcurrido desde que empezó la partida. */
  elapsedMs: number;
}

export interface BlindLevel {
  level: number;
  small: number;
  big: number;
  /** Se llegó al tope (o no se duplican): no habrá más subidas. */
  atCap: boolean;
  /** Milisegundos desde el inicio en que empieza el próximo nivel; null si no hay más. */
  nextAtMs: number | null;
}

/** Nivel más alto cuya ciega grande no pasa de la mitad de la entrada (siempre al menos el 0). */
export function maxBlindLevel(bigBlind: number, buyIn: number): number {
  const cap = Math.floor(buyIn / 2);
  let level = 0;
  while (bigBlind * 2 ** (level + 1) <= cap) level++;
  return level;
}

export function blindLevel(input: BlindLevelInput): BlindLevel {
  const { smallBlind, bigBlind, buyIn, minutes, elapsedMs } = input;
  if (!(minutes > 0)) return { level: 0, small: smallBlind, big: bigBlind, atCap: true, nextAtMs: null };
  const intervalMs = minutes * 60_000;
  const max = maxBlindLevel(bigBlind, buyIn);
  const level = Math.min(max, Math.max(0, Math.floor(elapsedMs / intervalMs)));
  const atCap = level >= max;
  return {
    level,
    small: smallBlind * 2 ** level,
    big: bigBlind * 2 ** level,
    atCap,
    nextAtMs: atCap ? null : (level + 1) * intervalMs,
  };
}
