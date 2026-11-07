/**
 * Evaluador rápido de 5 a 7 cartas y cálculo de equity (probabilidad de ganar). Se usa para analizar manos ya
 * jugadas, no para jugarlas: el evaluador de `evaluate.ts` sigue siendo el que decide quién gana.
 */

import { newDeck, rankValue, suitOf, type Card } from './cards';

const BASE = 15;
const SUIT_INDEX: Record<string, number> = { s: 0, h: 1, d: 2, c: 3 };

/** Escalera más alta en una máscara de rangos (bit r = hay un rango r, con 2..14); 0 si no hay. */
function straightHigh(mask: number): number {
  // El as también cuenta como 1 para la rueda.
  const m = mask | ((mask >> 14) & 1 ? 2 : 0);
  for (let high = 14; high >= 5; high--) {
    const need = 0b11111 << (high - 4);
    if ((m & need) === need) return high;
  }
  return 0;
}

function pack(category: number, tiebreak: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * BASE + (tiebreak[i] ?? 0);
  return score;
}

/**
 * Puntaje de la mejor mano de 5 a 7 cartas. Es el mismo número que `evaluate(cards).score`, pero sin probar las 21
 * combinaciones: cuenta rangos y palos.
 */
export function score7(cards: Card[]): number {
  const counts = new Array<number>(15).fill(0);
  const suitCount = [0, 0, 0, 0];
  const suitMask = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = rankValue(c);
    const s = SUIT_INDEX[suitOf(c)];
    counts[r]++;
    suitCount[s]++;
    suitMask[s] |= 1 << r;
    mask |= 1 << r;
  }

  // Escalera de color / color.
  const flushSuit = suitCount.findIndex((n) => n >= 5);
  if (flushSuit >= 0) {
    const sf = straightHigh(suitMask[flushSuit]);
    if (sf) return pack(8, [sf]);
  }

  // Rangos agrupados: cuatro, tríos, pares y sueltas, de mayor a menor.
  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  const singles: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quads.push(r);
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
    else if (counts[r] === 1) singles.push(r);
  }
  const kickers = (exclude: number[], n: number): number[] => {
    const out: number[] = [];
    for (let r = 14; r >= 2 && out.length < n; r--) if (counts[r] > 0 && !exclude.includes(r)) out.push(r);
    return out;
  };

  if (quads.length) return pack(7, [quads[0], ...kickers([quads[0]], 1)]);
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const pair = trips.length > 1 ? Math.max(trips[1], pairs[0] ?? 0) : pairs[0];
    return pack(6, [trips[0], pair]);
  }
  if (flushSuit >= 0) {
    const top: number[] = [];
    for (let r = 14; r >= 2 && top.length < 5; r--) if (suitMask[flushSuit] & (1 << r)) top.push(r);
    return pack(5, top);
  }
  const st = straightHigh(mask);
  if (st) return pack(4, [st]);
  if (trips.length) return pack(3, [trips[0], ...kickers([trips[0]], 2)]);
  if (pairs.length >= 2) return pack(2, [pairs[0], pairs[1], ...kickers([pairs[0], pairs[1]], 1)]);
  if (pairs.length === 1) return pack(1, [pairs[0], ...kickers([pairs[0]], 3)]);
  return pack(0, singles.slice(0, 5));
}

export interface EquityInput {
  /** Cartas de cada jugador que sigue en disputa. */
  holes: Card[][];
  /** Cartas del board ya repartidas (0 a 5). */
  board: Card[];
  /** Entero uniforme en [0, n); solo hace falta si hay que muestrear. Sin él se usa un generador fijo (determinista). */
  randomInt?: (n: number) => number;
  /** Corridas por muestreo cuando faltan muchas cartas (preflop). */
  samples?: number;
  /** Hasta cuántas combinaciones se enumeran exactamente antes de pasar a muestrear. */
  maxExact?: number;
}

/** Generador determinista simple (mulberry32) para que el análisis dé siempre el mismo resultado. */
function seeded(seed = 20240607): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/**
 * Probabilidad de ganar de cada jugador (los empates reparten). Enumera todas las cartas que pueden salir si son pocas
 * (flop, turn, river) y muestrea si son muchas (preflop). Devuelve valores entre 0 y 1 que suman 1.
 */
export function equity(input: EquityInput): number[] {
  const { holes, board } = input;
  const n = holes.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  const missing = 5 - board.length;
  const known = new Set<Card>([...board, ...holes.flat()]);
  const rest = newDeck().filter((c) => !known.has(c));
  const shares = new Array<number>(n).fill(0);

  const settle = (extra: Card[]): void => {
    const full = board.concat(extra);
    let best = -1;
    let winners: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = score7(holes[i].concat(full));
      if (s > best) { best = s; winners = [i]; } else if (s === best) winners.push(i);
    }
    for (const w of winners) shares[w] += 1 / winners.length;
  };

  if (missing <= 0) {
    settle([]);
    return shares;
  }

  // Cantidad de combinaciones: C(rest, missing).
  let combos = 1;
  for (let k = 0; k < missing; k++) combos = (combos * (rest.length - k)) / (k + 1);
  const maxExact = input.maxExact ?? 3000;

  if (combos <= maxExact) {
    const pick: Card[] = [];
    let total = 0;
    const walk = (start: number): void => {
      if (pick.length === missing) { settle(pick); total++; return; }
      for (let i = start; i <= rest.length - (missing - pick.length); i++) {
        pick.push(rest[i]);
        walk(i + 1);
        pick.pop();
      }
    };
    walk(0);
    return shares.map((s) => s / total);
  }

  const samples = input.samples ?? 4000;
  const rnd = input.randomInt ?? seeded();
  const pool = rest.slice();
  for (let t = 0; t < samples; t++) {
    // Fisher-Yates parcial: las primeras `missing` posiciones quedan sorteadas.
    for (let k = 0; k < missing; k++) {
      const j = k + rnd(pool.length - k);
      [pool[k], pool[j]] = [pool[j], pool[k]];
    }
    settle(pool.slice(0, missing));
  }
  return shares.map((s) => s / samples);
}
