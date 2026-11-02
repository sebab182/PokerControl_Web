/** Cartas de póker. Una carta es un string de 2 caracteres: rango + palo (ej. "As", "Td", "2c"). */
export type Suit = 's' | 'h' | 'd' | 'c';
export type Card = string;

export const RANKS = '23456789TJQKA';
export const SUITS: Suit[] = ['s', 'h', 'd', 'c'];

/** Valor numérico del rango: 2..14 (A = 14). */
export function rankValue(card: Card): number {
  const i = RANKS.indexOf(card[0]);
  if (i < 0) throw new Error(`Carta inválida: ${card}`);
  return i + 2;
}

export function suitOf(card: Card): Suit {
  const s = card[1] as Suit;
  if (!SUITS.includes(s)) throw new Error(`Carta inválida: ${card}`);
  return s;
}

export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

/**
 * Mezcla Fisher-Yates. `randomInt(n)` debe devolver un entero uniforme en [0, n).
 * En el servidor se inyecta un generador criptográfico (node:crypto).
 */
export function shuffle(deck: Card[], randomInt: (n: number) => number): Card[] {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
