import { describe, expect, it } from 'vitest';
import {
  allInSpot, analyzeSession, applyAction, cardScore, describeAction, handClass, handPositions, legalActions, startHand,
  summarizeHand, type Action, type HandState, type InsightHand, type RecordedAction,
} from './index';

function rng(seed: number) {
  return (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** Juega una mano con decisiones al azar y la deja como la leería el análisis. */
function randomHand(handNo: number, seed: number, ids: string[]): InsightHand {
  const r = rng(seed);
  let s: HandState = startHand(ids.map((id) => ({ id, stack: 200 + r(800) })), { button: handNo % ids.length, smallBlind: 10, bigBlind: 20, randomInt: r });
  const positions = handPositions(s);
  const holes = Object.fromEntries(s.players.map((p) => [p.id, p.hole.slice()]));
  const starts = Object.fromEntries(s.players.map((p) => [p.id, p.stack + p.totalBet]));
  const log: (RecordedAction & { seq: number; potBefore: number; toCall: number; stackBefore: number; allIn: boolean })[] = [];
  let guard = 0;
  while (s.street !== 'done' && guard++ < 200) {
    const legal = legalActions(s)!;
    const p = s.players[s.toAct];
    const roll = r(10);
    const a: Action = roll < 3 && !legal.canCheck ? { type: 'fold' }
      : roll < 5 && legal.canRaise ? { type: 'raise', to: legal.minRaiseTo } : roll === 9 ? { type: 'allin' }
      : legal.canCheck ? { type: 'check' } : { type: 'call' };
    const spot = describeAction(s, a)!;
    const next = applyAction(s, p.id, a);
    log.push({ seq: log.length, playerId: p.id, street: spot.street, kind: spot.kind, amount: spot.amount, auto: false, potBefore: spot.potBefore, toCall: spot.toCall, stackBefore: spot.stackBefore, allIn: next.players[s.toAct].allIn && !p.allIn });
    s = next;
  }
  const full = [...s.board, ...s.deck.slice(0, 5 - s.board.length)];
  const sum = summarizeHand(s, log);
  const lastAllIn = [...log].reverse().find((x) => x.allIn);
  const spot = lastAllIn ? allInSpot(s, lastAllIn.street) : null;
  return {
    id: handNo, handNo, smallBlind: 10, bigBlind: 20, pot: sum.pot, board: sum.board, fullBoard: full, endedOn: sum.endedOn,
    wentToShowdown: sum.wentToShowdown,
    players: sum.players.map((p) => ({
      playerId: p.playerId, position: positions[p.playerId]?.position ?? null, startStack: starts[p.playerId], pending: false,
      hole: holes[p.playerId], invested: p.invested, won: p.won, net: p.net, foldedStreet: p.foldedStreet, sawFlop: p.sawFlop,
      vpip: p.vpip, pfr: p.pfr, allIn: p.allIn, showdown: p.showdown, wonShowdown: p.wonShowdown,
      cardScore: cardScore(holes[p.playerId]), handClass: handClass(holes[p.playerId]),
      allInEquity: spot?.equity[p.playerId] ?? null, evNet: spot?.evNet[p.playerId] ?? null, hasStreetData: true,
    })),
    actions: log.map((x) => ({ ...x, thinkMs: 1000 })),
  };
}

describe('handClass y cardScore', () => {
  it('nombra la mano inicial', () => {
    expect(handClass(['Ks', 'As'])).toBe('AKs');
    expect(handClass(['Qh', 'Td'])).toBe('QTo');
    expect(handClass(['8c', '8d'])).toBe('88');
  });
  it('ordena las manos por fuerza', () => {
    expect(cardScore(['As', 'Ah'])).toBe(1);
    expect(cardScore(['As', 'Ks'])!).toBeGreaterThan(cardScore(['As', 'Kd'])!);
    expect(cardScore(['Kh', 'Qh'])!).toBeGreaterThan(cardScore(['9c', '2d'])!);
    expect(cardScore(['7c', '2d'])!).toBeLessThan(0.15);
  });
});

describe('allInSpot', () => {
  it('conserva las fichas: el neto esperado de todos suma cero', () => {
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const h = randomHand(seed, seed * 17, ['a', 'b', 'c', 'd']);
      const withEv = h.players.filter((p) => p.evNet !== null);
      if (withEv.length === 0) continue;
      checked++;
      const total = withEv.reduce((s, p) => s + p.evNet!, 0) + h.players.filter((p) => p.evNet === null).reduce((s, p) => s + p.net, 0);
      expect(Math.abs(total)).toBeLessThan(0.5);
      for (const p of withEv) expect(p.allInEquity!).toBeGreaterThanOrEqual(0);
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('analyzeSession', () => {
  const hands = Array.from({ length: 60 }, (_, i) => randomHand(i + 1, 1000 + i * 31, ['a', 'b', 'c', 'd']));
  const out = analyzeSession(hands);

  it('el neto de todos suma cero y coincide con la serie acumulada', () => {
    expect(out.players.reduce((s, p) => s + p.net, 0)).toBe(0);
    const last = out.series.net[out.series.net.length - 1].values;
    for (const p of out.players) expect(last[p.playerId]).toBe(p.net);
  });
  it('las tasas son coherentes: n ≤ d y VPIP ≥ PFR', () => {
    for (const p of out.players) {
      for (const r of [p.vpip, p.pfr, p.threeBet, p.foldToThreeBet, p.cbet, p.foldToCbet, p.steal, p.bbDefend, p.wtsd, p.wsd, p.wwsf]) {
        expect(r.n).toBeLessThanOrEqual(r.d);
      }
      expect(p.vpip.n).toBeGreaterThanOrEqual(p.pfr.n);
      expect(p.hands).toBe(60);
    }
  });
  it('lo esperado acumulado también suma cero', () => {
    const last = out.series.evNet[out.series.evNet.length - 1].values;
    expect(Math.abs(Object.values(last).reduce((s, x) => s + x, 0))).toBeLessThan(2);
  });
  it('cada retirada evaluada declara un resultado y un delta consistente', () => {
    expect(out.handsWithRunout).toBe(60);
    for (const f of out.whatIf.folds) {
      expect(['win', 'tie', 'lose']).toContain(f.result);
      if (f.result === 'lose') expect(f.delta).toBeLessThan(0);
      if (f.result === 'win') expect(f.delta).toBeGreaterThan(0);
    }
    expect(out.whatIf.folds.length).toBeGreaterThan(0);
  });
  it('la suerte es neto − esperado', () => {
    for (const l of out.whatIf.luck) expect(l.luck).toBeCloseTo(l.net - l.evNet, 1);
  });
});

describe('indicadores con manos armadas', () => {
  it('cuenta 3-bet y c-bet', () => {
    const base = (): InsightHand => ({
      id: 1, handNo: 1, smallBlind: 10, bigBlind: 20, pot: 100, board: ['2c', '7d', 'Ks'], fullBoard: null, endedOn: 'flop', wentToShowdown: false,
      players: ['a', 'b', 'c'].map((id, i) => ({
        playerId: id, position: ['BTN', 'SB', 'BB'][i], startStack: 1000, pending: false, hole: ['As', 'Kd'], invested: 0, won: 0, net: 0,
        foldedStreet: null, sawFlop: true, vpip: false, pfr: false, allIn: false, showdown: false, wonShowdown: false,
        cardScore: 0.5, handClass: 'AKo', allInEquity: null, evNet: null, hasStreetData: true,
      })),
      actions: [],
    });
    const h = base();
    const act = (seq: number, playerId: string, street: 'preflop' | 'flop', kind: 'raise' | 'call' | 'fold' | 'check') =>
      ({ seq, playerId, street, kind, amount: kind === 'raise' ? 60 : null, potBefore: 30, toCall: 20, stackBefore: 1000, auto: false, allIn: false, thinkMs: null });
    h.actions = [
      act(0, 'a', 'preflop', 'raise'), // abre
      act(1, 'b', 'preflop', 'raise'), // 3-bet
      act(2, 'c', 'preflop', 'fold'),
      act(3, 'a', 'preflop', 'call'),
      act(4, 'b', 'flop', 'raise'), // c-bet del último que subió
      act(5, 'a', 'flop', 'fold'),
    ];
    const out = analyzeSession([h]);
    const by = (id: string) => out.players.find((p) => p.playerId === id)!;
    expect(by('b').threeBet).toEqual({ n: 1, d: 1 });
    expect(by('a').threeBet).toEqual({ n: 0, d: 0 });
    expect(by('a').foldToThreeBet).toEqual({ n: 0, d: 1 });
    expect(by('b').cbet).toEqual({ n: 1, d: 1 });
    expect(by('a').foldToCbet).toEqual({ n: 1, d: 1 });
    expect(by('a').steal).toEqual({ n: 1, d: 1 });
  });
});
