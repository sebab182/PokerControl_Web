import { describe, expect, it } from 'vitest';
import {
  MAX_BETS, RED_NUMBERS, RouletteError, WHEEL_ORDER, betNet, betWins, colorOf, settleRound, validateBets, type Bet,
} from './index';

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const limits = { minBet: 10, maxBet: 100 };

describe('la rueda', () => {
  it('tiene 37 casilleros, 18 rojos, 18 negros y el cero verde', () => {
    expect([...WHEEL_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
    expect(RED_NUMBERS).toHaveLength(18);
    const colors = WHEEL_ORDER.map(colorOf);
    expect([colors.filter(c => c === 'red').length, colors.filter(c => c === 'black').length, colors.filter(c => c === 'green').length]).toEqual([18, 18, 1]);
    expect([colorOf(0), colorOf(1), colorOf(2), colorOf(36), colorOf(35)]).toEqual(['green', 'red', 'black', 'red', 'black']);
  });
  it('los rojos y negros alternan como en la rueda europea', () => {
    for (let i = 1; i < WHEEL_ORDER.length - 1; i++) expect(colorOf(WHEEL_ORDER[i])).not.toBe(colorOf(WHEEL_ORDER[i + 1]));
  });
});

describe('pagos', () => {
  const bet = (type: Bet['type'], n?: number, amount = 10): Bet => ({ type, n, amount });
  it('pleno paga 35 a 1; el resto, según lo que cubre', () => {
    expect(betNet(bet('straight', 17), 17)).toBe(350);
    expect(betNet(bet('straight', 17), 18)).toBe(-10);
    expect(betNet(bet('red'), 1)).toBe(10);
    expect(betNet(bet('black'), 1)).toBe(-10);
    expect(betNet(bet('dozen', 2), 13)).toBe(20);
    expect(betNet(bet('column', 3), 36)).toBe(20);
  });
  it('el 0 pierde todas las apuestas externas y solo gana el pleno al 0', () => {
    for (const t of ['red', 'black', 'odd', 'even', 'low', 'high'] as const) expect(betWins(bet(t), 0)).toBe(false);
    expect([1, 2, 3].map(n => betWins(bet('dozen', n), 0))).toEqual([false, false, false]);
    expect([1, 2, 3].map(n => betWins(bet('column', n), 0))).toEqual([false, false, false]);
    expect(betWins(bet('straight', 0), 0)).toBe(true);
  });
  it('par, impar, bajo y alto', () => {
    expect([betWins(bet('even'), 2), betWins(bet('even'), 3), betWins(bet('odd'), 3), betWins(bet('odd'), 36)]).toEqual([true, false, true, false]);
    expect([betWins(bet('low'), 18), betWins(bet('low'), 19), betWins(bet('high'), 19), betWins(bet('high'), 36)]).toEqual([true, false, true, true]);
  });
  it('cada número está en una sola docena y una sola columna', () => {
    for (let n = 1; n <= 36; n++) {
      expect([1, 2, 3].filter(d => betWins(bet('dozen', d), n))).toHaveLength(1);
      expect([1, 2, 3].filter(c => betWins(bet('column', c), n))).toHaveLength(1);
    }
    expect([betWins(bet('dozen', 1), 12), betWins(bet('dozen', 2), 12), betWins(bet('dozen', 3), 25)]).toEqual([true, false, true]);
    expect([betWins(bet('column', 1), 34), betWins(bet('column', 2), 35), betWins(bet('column', 3), 36)]).toEqual([true, true, true]);
  });
  it('en la ronda completa, el valor esperado de cualquier apuesta es −1/37 de lo apostado', () => {
    // Sumando los 37 resultados posibles de una apuesta de 37, el neto total es −37 (la ventaja del cero, 2,7 %).
    for (const b of [bet('straight', 7, 37), bet('red', undefined, 37), bet('dozen', 1, 37), bet('column', 2, 37), bet('odd', undefined, 37)]) {
      expect(Array.from({ length: 37 }, (_, n) => betNet(b, n)).reduce((a, c) => a + c, 0)).toBe(-37);
    }
  });
});

describe('validación', () => {
  it('acepta apuestas dentro de los límites', () => {
    expect(() => validateBets([{ type: 'red', amount: 50 }, { type: 'straight', n: 0, amount: 50 }], limits)).not.toThrow();
  });
  it('rechaza lo que no es múltiplo de la ficha, el total sobre el máximo y las apuestas mal armadas', () => {
    expect(() => validateBets([{ type: 'red', amount: 15 }], limits)).toThrow(RouletteError);
    expect(() => validateBets([{ type: 'red', amount: 0 }], limits)).toThrow(RouletteError);
    expect(() => validateBets([{ type: 'red', amount: 60 }, { type: 'black', amount: 50 }], limits)).toThrow(/hasta 100/);
    expect(() => validateBets([{ type: 'straight', n: 37, amount: 10 }], limits)).toThrow(/0 a 36/);
    expect(() => validateBets([{ type: 'dozen', n: 4, amount: 10 }], limits)).toThrow(RouletteError);
    expect(() => validateBets([{ type: 'caballo' as never, amount: 10 }], limits)).toThrow(RouletteError);
    expect(() => validateBets(Array.from({ length: MAX_BETS + 1 }, () => ({ type: 'red' as const, amount: 10 })), { minBet: 10, maxBet: 10_000 })).toThrow(/Hasta 20/);
  });
});

describe('liquidación contra los demás, sin contar al que apostó', () => {
  const members = ['a', 'b', 'c', 'd', 'e', 'f'];
  it('gana uno: cobra su apuesta de los otros cinco, que pagan en partes iguales', () => {
    const r = settleRound({ bets: { a: [{ type: 'red', amount: 10 }] }, result: 1, members, round: 0 });
    expect(r.nets).toEqual({ a: 10 });
    expect(r.house).toBe(-10);
    // −10 entre 5: cada uno paga 2. El que apostó no paga nada.
    expect(r.share).toEqual({ a: 0, b: -2, c: -2, d: -2, e: -2, f: -2 });
    expect(r.deltas).toEqual({ a: 10, b: -2, c: -2, d: -2, e: -2, f: -2 });
    expect(sum(r.deltas)).toBe(0);
  });
  it('pierde uno: lo que perdió se reparte entre los otros cinco, sin que cobre el que apostó', () => {
    const r = settleRound({ bets: { a: [{ type: 'red', amount: 10 }] }, result: 2, members, round: 0 });
    expect(r.house).toBe(10);
    expect(r.share.a).toBe(0);
    expect(r.deltas.a).toBe(-10);
    expect(['b', 'c', 'd', 'e', 'f'].map(m => r.deltas[m])).toEqual([2, 2, 2, 2, 2]);
    expect(sum(r.deltas)).toBe(0);
  });
  it('un pleno que paga 35 se reparte entre los otros cinco y el resto rota', () => {
    const r = settleRound({ bets: { a: [{ type: 'straight', n: 5, amount: 100 }] }, result: 5, members, round: 3 });
    expect(r.nets.a).toBe(3500);
    expect(r.deltas.a).toBe(3500);
    // 3500 / 5 = 700 exacto.
    expect(['b', 'c', 'd', 'e', 'f'].map(m => r.deltas[m])).toEqual([-700, -700, -700, -700, -700]);
    const odd = settleRound({ bets: { a: [{ type: 'red', amount: 10 }] }, result: 2, members: ['a', 'b', 'c', 'd'], round: 0 });
    // 10 entre 3: 4, 3 y 3 (el resto de uno).
    expect(['b', 'c', 'd'].map(m => odd.deltas[m]).sort()).toEqual([3, 3, 4]);
    expect(sum(odd.deltas)).toBe(0);
  });
  it('con varios apostadores, cada uno se reparte entre los demás y los saldos suman 0', () => {
    const r = settleRound({
      bets: { a: [{ type: 'red', amount: 50 }], b: [{ type: 'black', amount: 50 }] }, result: 1, members, round: 1,
    });
    expect(r.nets).toEqual({ a: 50, b: -50 });
    expect(r.house).toBe(0);
    // a gana 50: lo pagan b, c, d, e y f (10 cada uno). b pierde 50: lo cobran a, c, d, e y f (10 cada uno).
    expect(r.deltas).toEqual({ a: 50 + 10, b: -50 - 10, c: 0, d: 0, e: 0, f: 0 });
    expect(sum(r.deltas)).toBe(0);
  });
  it('el resto de la división rota con la ronda y los saldos suman 0 siempre', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const who = (round: number) => {
      const r = settleRound({ bets: { a: [{ type: 'red', amount: 10 }] }, result: 2, members: ids, round });
      expect(sum(r.deltas)).toBe(0);
      expect(r.deltas.a).toBe(-10);
      return ids.filter(m => r.deltas[m] === 4).join('');
    };
    const seen = new Set(Array.from({ length: 3 }, (_, i) => who(i)));
    expect(seen.size).toBe(3); // cada ronda le toca el resto a otro
  });
  it('un apostador que no figura entre los miembros igual participa', () => {
    const r = settleRound({ bets: { z: [{ type: 'red', amount: 10 }] }, result: 2, members: ['a', 'b'], round: 0 });
    expect(Object.keys(r.deltas).sort()).toEqual(['a', 'b', 'z']);
    expect(sum(r.deltas)).toBe(0);
  });
  it('en un grupo de uno no hay con quién repartir: el saldo no cambia', () => {
    const r = settleRound({ bets: { a: [{ type: 'red', amount: 10 }] }, result: 2, members: ['a'], round: 0 });
    expect(r.deltas).toEqual({ a: 0 });
  });
  it('con muchas rondas al azar los saldos suman 0', () => {
    let seed = 11;
    const rng = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const totals: Record<string, number> = Object.fromEntries(members.map(m => [m, 0]));
    for (let round = 0; round < 600; round++) {
      const bets: Record<string, Bet[]> = {};
      for (const m of members.slice(0, 1 + rng(4))) bets[m] = [{ type: 'straight', n: rng(37), amount: 10 }, { type: 'red', amount: 20 }];
      const r = settleRound({ bets, result: rng(37), members, round });
      expect(sum(r.deltas)).toBe(0);
      for (const m of members) totals[m] += r.deltas[m];
    }
    expect(sum(totals)).toBe(0);
  });
});
