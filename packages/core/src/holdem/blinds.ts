/**
 * Ciegas que se duplican con el tiempo. Puro: solo calcula el nivel a partir de cuánto pasó.
 * El servidor lo evalúa al repartir cada mano, así que las ciegas nunca cambian en medio de una.
 *
 * Al llegar al límite (la ciega grande no pasa de la mitad de la entrada) y cumplirse otro período, las ciegas vuelven
 * a la más baja y empiezan a subir de nuevo. La chica y la grande suben juntas: siempre se duplican a la par.
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
  /** Nivel de las ciegas (0 = las más bajas). */
  level: number;
  small: number;
  big: number;
  /** Es el nivel más alto: en el próximo período las ciegas vuelven a las más bajas. Sin subidas ni vueltas, siempre true. */
  atCap: boolean;
  /** Milisegundos desde el inicio en que cambian las ciegas; null si no cambian nunca. */
  nextAtMs: number | null;
  /** Períodos que pasaron desde el inicio (crece siempre, aunque el nivel vuelva a 0): cuenta cada cambio de ciegas. */
  step: number;
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
  const max = maxBlindLevel(bigBlind, buyIn);
  // Sin subidas (0 minutos, o la entrada no deja subir nada): las ciegas no cambian nunca.
  if (!(minutes > 0) || max === 0) return { level: 0, small: smallBlind, big: bigBlind, atCap: true, nextAtMs: null, step: 0 };
  const intervalMs = minutes * 60_000;
  const step = Math.max(0, Math.floor(elapsedMs / intervalMs));
  // Después del nivel más alto se vuelve al más bajo.
  const level = step % (max + 1);
  return {
    level,
    small: smallBlind * 2 ** level,
    big: bigBlind * 2 ** level,
    atCap: level >= max,
    nextAtMs: (step + 1) * intervalMs,
    step,
  };
}
