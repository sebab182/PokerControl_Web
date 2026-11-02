import { type Card, rankValue, suitOf } from './cards';

export const HAND_NAMES = [
  'Carta alta', 'Par', 'Doble par', 'Trío', 'Escalera', 'Color', 'Full house', 'Póker', 'Escalera de color',
] as const;

export interface HandScore {
  /** Puntaje comparable: mayor gana. */
  score: number;
  /** 0 = carta alta ... 8 = escalera de color. */
  category: number;
  name: string;
  /** Las 5 cartas que forman la mejor mano. */
  best: Card[];
}

const BASE = 15;

function score5(cards: Card[]): { score: number; category: number } {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Orden: más repetidas primero, luego rango mayor.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let tiebreak = groups.map(([r]) => r);

  const distinct = counts.size === 5;
  let straightHigh = 0;
  if (distinct) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) straightHigh = 5; // rueda A-2-3-4-5
  }

  let category: number;
  if (straightHigh && flush) { category = 8; tiebreak = [straightHigh]; }
  else if (groups[0][1] === 4) category = 7;
  else if (groups[0][1] === 3 && groups[1]?.[1] === 2) category = 6;
  else if (flush) category = 5;
  else if (straightHigh) { category = 4; tiebreak = [straightHigh]; }
  else if (groups[0][1] === 3) category = 3;
  else if (groups[0][1] === 2 && groups[1]?.[1] === 2) category = 2;
  else if (groups[0][1] === 2) category = 1;
  else category = 0;

  let score = category;
  for (let i = 0; i < 5; i++) score = score * BASE + (tiebreak[i] ?? 0);
  return { score, category };
}

function* combinations(cards: Card[], k: number, start = 0, acc: Card[] = []): Generator<Card[]> {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= cards.length - (k - acc.length); i++) {
    acc.push(cards[i]);
    yield* combinations(cards, k, i + 1, acc);
    acc.pop();
  }
}

/** Mejor mano de 5 cartas entre 5 a 7 cartas. */
export function evaluate(cards: Card[]): HandScore {
  if (cards.length < 5 || cards.length > 7) throw new Error('Se necesitan entre 5 y 7 cartas');
  let best: HandScore | null = null;
  for (const combo of combinations(cards, 5)) {
    const { score, category } = score5(combo);
    if (!best || score > best.score) best = { score, category, name: HAND_NAMES[category], best: combo };
  }
  const b = best!;
  // Escalera real: escalera de color con as alto.
  if (b.category === 8 && b.best.some((c) => c[0] === 'A') && b.best.some((c) => c[0] === 'K')) b.name = 'Escalera real';
  return b;
}

export function compareHands(a: Card[], b: Card[]): number {
  return evaluate(a).score - evaluate(b).score;
}
