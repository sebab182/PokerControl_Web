import { describe, expect, it } from 'vitest';
import { newDeck, shuffle } from './cards';
import { equity, score7 } from './equity';
import { evaluate } from './evaluate';

describe('score7', () => {
  it('da el mismo puntaje que evaluate en manos al azar', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 4000; i++) {
      const len = 5 + (i % 3);
      const cards = shuffle(newDeck(), rnd).slice(0, len);
      expect(score7(cards)).toBe(evaluate(cards).score);
    }
  });
  it('reconoce la rueda, el color y la escalera de color', () => {
    expect(score7(['Ah', '2d', '3c', '4s', '5h', 'Kd', '9c'])).toBe(evaluate(['Ah', '2d', '3c', '4s', '5h', 'Kd', '9c']).score);
    expect(score7(['Ah', '2h', '3h', '4h', '5h', 'Kd', '9c'])).toBe(evaluate(['Ah', '2h', '3h', '4h', '5h', 'Kd', '9c']).score);
    expect(score7(['9h', 'Th', 'Jh', 'Qh', 'Kh', 'Kd', 'Kc'])).toBe(evaluate(['9h', 'Th', 'Jh', 'Qh', 'Kh', 'Kd', 'Kc']).score);
  });
});

describe('equity', () => {
  it('AA contra KK preflop ronda el 82 %', () => {
    const [a, k] = equity({ holes: [['As', 'Ah'], ['Ks', 'Kh']], board: [] });
    expect(a).toBeGreaterThan(0.8);
    expect(a).toBeLessThan(0.84);
    expect(a + k).toBeCloseTo(1, 9);
  });
  it('AKs contra QQ preflop ronda el 46 %', () => {
    const [ak] = equity({ holes: [['As', 'Ks'], ['Qh', 'Qd']], board: [] });
    expect(ak).toBeGreaterThan(0.43);
    expect(ak).toBeLessThan(0.49);
  });
  it('es exacta en el flop y suma 1 con tres jugadores', () => {
    const e = equity({ holes: [['As', 'Ah'], ['Ks', 'Kh'], ['7c', '7d']], board: ['2d', '9s', 'Tc'] });
    expect(e.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    expect(e[0]).toBeGreaterThan(e[1]);
  });
  it('con el board completo reparte los empates', () => {
    const e = equity({ holes: [['2c', '3d'], ['2h', '3s']], board: ['As', 'Ah', 'Kd', 'Kc', 'Qs'] });
    expect(e).toEqual([0.5, 0.5]);
  });
  it('es determinista', () => {
    const a = equity({ holes: [['As', 'Kd'], ['Jh', 'Jc']], board: [] });
    const b = equity({ holes: [['As', 'Kd'], ['Jh', 'Jc']], board: [] });
    expect(a).toEqual(b);
  });
});
