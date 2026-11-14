import { describe, expect, it } from 'vitest';
import {
  BlackjackError, act, canBet, handValue, isBlackjack, legalBjActions, maxBet, newRound, placeBet, publicBjView, skipRound, type BjState,
} from './index';

/** Mazo armado: jugador, croupier, jugador, croupier y después lo que se pida. */
const deck = (s: string) => s.split(' ');
const rivals = (...stacks: number[]) => stacks.map((stack, i) => ({ id: `r${i + 1}`, stack }));
const round = (cards: string, o: { stack?: number; rivals?: number[]; minBet?: number } = {}): BjState =>
  newRound({ playerId: 'p', playerStack: o.stack ?? 1000, rivals: rivals(...(o.rivals ?? [1000, 1000])), minBet: o.minBet ?? 10, deck: deck(cards) });
const sum = (s: BjState) => Object.values(s.deltas).reduce((a, b) => a + b, 0);

describe('handValue', () => {
  it('cuenta ases como 11 o 1 según convenga', () => {
    expect(handValue(['As', 'Kd'])).toEqual({ total: 21, soft: true });
    expect(handValue(['As', 'Ad'])).toEqual({ total: 12, soft: true });
    expect(handValue(['As', '6d'])).toEqual({ total: 17, soft: true });
    expect(handValue(['As', '6d', 'Th'])).toEqual({ total: 17, soft: false });
    expect(handValue(['Ts', 'Kd', '5h'])).toEqual({ total: 25, soft: false });
    expect(handValue(['As', 'Ad', 'Ah', '8c'])).toEqual({ total: 21, soft: true });
  });
  it('blackjack es 21 con dos cartas', () => {
    expect(isBlackjack(['As', 'Kd'])).toBe(true);
    expect(isBlackjack(['7s', '7d', '7h'])).toBe(false);
  });
});

describe('maxBet', () => {
  it('cubre doblar: el jugador contra cada rival y el rival con menos fichas', () => {
    expect(maxBet(1000, [1000, 1000])).toBe(250); // 1000 / (2·2)
    expect(maxBet(1000, [1000, 100])).toBe(50); // el rival con 100 aguanta 2×50
    expect(maxBet(100, [1000, 1000, 1000, 1000])).toBe(12); // 100 / 8 = 12,5
    expect(maxBet(1000, [])).toBe(0);
    expect(maxBet(1, [1000])).toBe(0);
  });
});

describe('apuesta', () => {
  it('rechaza una apuesta bajo el mínimo o sobre el tope', () => {
    const s = round('5s 5d 6s 6d');
    expect(() => placeBet(s, 5)).toThrow(BlackjackError);
    expect(() => placeBet(s, s.maxBet + 1)).toThrow(/máxima/);
    expect(() => placeBet(s, 20.5)).toThrow(BlackjackError);
    expect(placeBet(s, s.maxBet).phase).toBe('player');
  });
  it('con el tope por debajo del mínimo no se puede apostar y la mano se saltea', () => {
    const s = round('5s 5d 6s 6d', { stack: 30, minBet: 10 }); // 30 / 4 = 7
    expect(s.maxBet).toBe(7);
    expect(canBet(s)).toBe(false);
    const skipped = skipRound(s);
    expect(skipped.result).toBe('skipped');
    expect(skipped.deltas).toEqual({});
  });
  it('el interludio puede apostar bajo el mínimo de la mesa', () => {
    const s = round('5s 5d 6s 6d', { stack: 30, minBet: 10 });
    expect(placeBet(s, 7, { minBet: 1 }).bet).toBe(7);
  });
  it('reparte jugador, croupier, jugador, croupier', () => {
    const s = placeBet(round('2s 3s 4s 5s 6s'), 10);
    expect(s.player).toEqual(['2s', '4s']);
    expect(s.dealer).toEqual(['3s', '5s']);
    expect(s.phase).toBe('player');
  });
});

describe('juego', () => {
  it('gana 1× por cada rival y los rivales pierden 1×', () => {
    // Jugador 10+9 = 19 y se planta; croupier 10+7 = 17.
    const s = act(placeBet(round('Ts Td 9s 7d'), 50), 'p', 'stand');
    expect(s.result).toBe('win');
    expect(s.deltas).toEqual({ p: 100, r1: -50, r2: -50 });
    expect(sum(s)).toBe(0);
  });
  it('pierde: le paga a cada rival', () => {
    const s = act(placeBet(round('Ts Td 7s 9d'), 50), 'p', 'stand');
    expect(s.result).toBe('lose');
    expect(s.deltas).toEqual({ p: -100, r1: 50, r2: 50 });
    expect(sum(s)).toBe(0);
  });
  it('empate no mueve fichas', () => {
    const s = act(placeBet(round('Ts Td 8s 8d'), 50), 'p', 'stand');
    expect(s.result).toBe('push');
    expect(s.deltas).toEqual({ p: 0, r1: 0, r2: 0 });
  });
  it('pasarse pierde sin que el croupier juegue', () => {
    const s = act(placeBet(round('Ts 6d 6s 7d Kh'), 50), 'p', 'hit');
    expect(s.result).toBe('bust');
    expect(s.phase).toBe('done');
    expect(s.dealer).toEqual(['6d', '7d']); // no pidió
    expect(sum(s)).toBe(0);
  });
  it('el croupier pide hasta 17 y se planta en 17 blando', () => {
    // Croupier 6+A = 17 blando: se planta; jugador 10+8 = 18 gana.
    expect(act(placeBet(round('Ts 6d 8s Ad'), 10), 'p', 'stand').dealer).toEqual(['6d', 'Ad']);
    // Croupier 5+6 = 11 pide un 9 → 20.
    const s = act(placeBet(round('Ts 5d 8s 6d 9h'), 10), 'p', 'stand');
    expect(s.dealer).toEqual(['5d', '6d', '9h']);
    expect(s.result).toBe('lose');
  });
  it('si el croupier se pasa, gana el jugador', () => {
    const s = act(placeBet(round('Ts 6d 2s Td 9h'), 10), 'p', 'stand'); // croupier 16 + 9 = 25
    expect(s.result).toBe('win');
  });
  it('doblar duplica la apuesta y da una sola carta', () => {
    // Jugador 5+6 = 11, dobla y recibe un 10 → 21; croupier 10+7 = 17.
    const placed = placeBet(round('5s Td 6s 7d Th'), 50);
    expect(legalBjActions(placed)).toEqual(['hit', 'stand', 'double']);
    const s = act(placed, 'p', 'double');
    expect(s.bet).toBe(100);
    expect(s.player).toHaveLength(3);
    expect(s.result).toBe('win');
    expect(s.deltas).toEqual({ p: 200, r1: -100, r2: -100 });
  });
  it('doblar solo con las dos primeras cartas', () => {
    const s = act(placeBet(round('2s Td 3s 7d 2h 2c'), 50), 'p', 'hit');
    expect(legalBjActions(s)).toEqual(['hit', 'stand']);
    expect(() => act(s, 'p', 'double')).toThrow(BlackjackError);
  });
  it('no deja jugar a otro ni fuera de turno', () => {
    const s = placeBet(round('2s Td 3s 7d'), 50);
    expect(() => act(s, 'r1', 'hit')).toThrow(/turno/);
    expect(() => act(round('2s Td 3s 7d'), 'p', 'hit')).toThrow(BlackjackError);
  });
  it('con 21 la mano sigue sola', () => {
    // 7+7 = 14, pide un 7 → 21; croupier 10+9 = 19.
    const s = act(placeBet(round('7s Td 7d 9d 7h'), 10), 'p', 'hit');
    expect(s.phase).toBe('done');
    expect(s.result).toBe('win');
  });
});

describe('blackjack', () => {
  it('natural paga 3 a 2 redondeado hacia abajo', () => {
    const s = placeBet(round('As 9d Kd 7h'), 25);
    expect(s.result).toBe('blackjack');
    expect(s.deltas).toEqual({ p: 2 * 37, r1: -37, r2: -37 }); // floor(25 · 1,5) = 37
    expect(sum(s)).toBe(0);
  });
  it('el croupier con blackjack gana sin que se pueda doblar', () => {
    const s = placeBet(round('9s As 8d Kd'), 50);
    expect(s.result).toBe('lose');
    expect(s.phase).toBe('done');
    expect(s.dealerRevealed).toBe(true);
  });
  it('blackjack contra blackjack es empate', () => {
    const s = placeBet(round('As Kd Ks Ad'), 50);
    expect(s.result).toBe('push');
    expect(sum(s)).toBe(0);
  });
});

describe('vista pública', () => {
  it('oculta el mazo y la carta tapada del croupier', () => {
    const s = placeBet(round('2s Td 3s 7d 2h'), 10);
    const v = publicBjView(s);
    expect('deck' in v).toBe(false);
    expect(v.dealer).toEqual(['Td', '??']);
    expect(s.dealer).toEqual(['Td', '7d']); // el estado original no se toca
  });
  it('al terminar muestra todo', () => {
    const s = act(placeBet(round('Ts Td 9s 7d'), 10), 'p', 'stand');
    expect(publicBjView(s).dealer).toEqual(['Td', '7d']);
  });
});

describe('suma cero en muchas manos', () => {
  it('con mazos al azar, los cambios siempre suman 0 y nadie baja de cero', () => {
    let seed = 7;
    const rng = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 400; i++) {
      const stacks = [rng(900) + 100, rng(900) + 100, rng(900) + 100];
      let s = newRound({ playerId: 'p', playerStack: rng(900) + 100, rivals: rivals(...stacks), minBet: 1, randomInt: rng });
      if (s.maxBet < 1) continue;
      s = placeBet(s, 1 + rng(s.maxBet));
      while (s.phase === 'player') s = act(s, 'p', legalBjActions(s)[rng(legalBjActions(s).length)]);
      expect(sum(s)).toBe(0);
      for (const r of s.rivals) expect(r.stack + s.deltas[r.id]).toBeGreaterThanOrEqual(0);
      expect(s.playerStack + s.deltas.p).toBeGreaterThanOrEqual(0);
    }
  });
});
