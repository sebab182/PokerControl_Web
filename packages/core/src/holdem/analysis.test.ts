import { describe, expect, it } from 'vitest';
import {
  applyAction, buyInHand, describeAction, handPositions, legalActions, newDeck, startHand, summarizeHand,
  type Action, type HandState, type RecordedAction,
} from './index';

/** RNG determinista. */
function rng(seed: number) {
  return (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const seat = (id: string, stack: number, pending = false) => ({ id, stack, ...(pending ? { pending: true } : {}) });
const deckFor = (hole: string[], board: string) => {
  const used = new Set([...hole, ...board.split(' ')]);
  return [...hole, ...board.split(' '), ...newDeck().filter((c) => !used.has(c))];
};

/** Juega las acciones y las registra como lo hace el servidor. */
function play(state: HandState, steps: [string, Action][]): { state: HandState; log: RecordedAction[] } {
  const log: RecordedAction[] = [];
  for (const [id, action] of steps) {
    const spot = describeAction(state, action)!;
    log.push({ playerId: id, street: spot.street, kind: spot.kind, amount: spot.amount, auto: false });
    state = applyAction(state, id, action);
  }
  return { state, log };
}

describe('handPositions', () => {
  const state = (ids: string[], button: number, pending: string[] = []) => startHand(
    ids.map((id) => seat(id, pending.includes(id) ? 0 : 1000, pending.includes(id))), { button, smallBlind: 10, bigBlind: 20, randomInt: rng(1) },
  );
  const labels = (s: HandState) => Object.fromEntries(Object.entries(handPositions(s)).map(([id, v]) => [id, v.position]));

  it('con dos jugadores el botón es la ciega chica', () => {
    expect(labels(state(['a', 'b'], 0))).toEqual({ a: 'BTN/SB', b: 'BB' });
    expect(labels(state(['a', 'b'], 1))).toEqual({ a: 'BB', b: 'BTN/SB' });
  });

  it('con tres, botón, ciega chica y grande; con más, los primeros en hablar y el cutoff', () => {
    expect(labels(state(['a', 'b', 'c'], 1))).toEqual({ b: 'BTN', c: 'SB', a: 'BB' });
    expect(labels(state(['a', 'b', 'c', 'd'], 0))).toEqual({ a: 'BTN', b: 'SB', c: 'BB', d: 'UTG' });
    expect(labels(state(['a', 'b', 'c', 'd', 'e'], 0))).toEqual({ a: 'BTN', b: 'SB', c: 'BB', d: 'UTG', e: 'CO' });
    expect(labels(state(['a', 'b', 'c', 'd', 'e', 'f'], 0))).toEqual({ a: 'BTN', b: 'SB', c: 'BB', d: 'UTG', e: 'UTG+1', f: 'CO' });
    expect(Object.values(handPositions(state(['a', 'b', 'c', 'd', 'e', 'f'], 3))).map((v) => v.index).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('el pendiente de recompra no tiene posición y no cambia la de los demás', () => {
    const s = state(['p', 'a', 'b', 'c'], 1, ['p']);
    expect(labels(s)).toEqual({ a: 'BTN', b: 'SB', c: 'BB' });
    expect(handPositions(s).p).toBeUndefined();
  });
});

describe('describeAction', () => {
  it('toma el estado antes de la jugada y clasifica el all-in según si subía', () => {
    const s = startHand([seat('a', 1000), seat('b', 50)], { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(2) });
    // a (ciega chica) debe 10 más; todavía no jugó.
    expect(describeAction(s, { type: 'call' })).toEqual({
      street: 'preflop', kind: 'call', amount: 10, potBefore: 30, toCall: 10, stackBefore: 990, playersLeft: 2,
    });
    expect(describeAction(s, { type: 'raise', to: 60 })).toMatchObject({ kind: 'raise', amount: 60 });
    expect(describeAction(s, { type: 'allin' })).toMatchObject({ kind: 'raise', amount: 1000 });
    const raised = applyAction(s, 'a', { type: 'raise', to: 100 });
    // b tiene 30 de stack: no puede subir, solo igualar todo.
    expect(describeAction(raised, { type: 'allin' })).toMatchObject({ kind: 'call', amount: 30 });
    expect(describeAction(raised, { type: 'fold' })).toMatchObject({ kind: 'fold', amount: null, toCall: 80 });
    expect(describeAction({ ...s, street: 'done', toAct: -1 }, { type: 'check' })).toBeNull();
  });
});

describe('summarizeHand', () => {
  const byId = (h: ReturnType<typeof summarizeHand>) => Object.fromEntries(h.players.map((p) => [p.playerId, p]));

  it('se retira antes del flop: pierde la ciega, no ve el flop, la mano termina en preflop', () => {
    const start = startHand([seat('a', 1000), seat('b', 1000)], { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(3) });
    const { state, log } = play(start, [['a', { type: 'fold' }]]);
    const h = summarizeHand(state, log);
    expect(h).toMatchObject({ pot: 30, endedOn: 'preflop', wentToShowdown: false, board: [] });
    expect(byId(h).a).toMatchObject({ invested: 10, won: 0, net: -10, foldedStreet: 'preflop', sawFlop: false, vpip: false, pfr: false, folds: 1, showdown: false });
    expect(byId(h).b).toMatchObject({ invested: 20, won: 30, net: 10, foldedStreet: null, sawFlop: false });
  });

  it('showdown: cuenta jugadas por tipo, vpip y pfr, quién llegó y quién ganó', () => {
    // a: ases; b: reyes. Reparto desde la ciega chica (a): a, b, a, b.
    const deck = deckFor(['As', 'Ks', 'Ah', 'Kh'], '2c 7d 9h 3s Jd');
    const start = startHand([seat('a', 1000), seat('b', 1000)], { button: 0, smallBlind: 10, bigBlind: 20, deck });
    const { state, log } = play(start, [
      ['a', { type: 'raise', to: 60 }], // pfr + vpip
      ['b', { type: 'call' }],          // vpip
      ['b', { type: 'check' }], ['a', { type: 'raise', to: 40 }], ['b', { type: 'call' }], // flop
      ['b', { type: 'check' }], ['a', { type: 'check' }], // turn
      ['b', { type: 'check' }], ['a', { type: 'check' }], // river
    ]);
    expect(state.street).toBe('done');
    const h = summarizeHand(state, log);
    expect(h).toMatchObject({ pot: 200, endedOn: 'river', wentToShowdown: true });
    expect(h.board).toHaveLength(5);
    expect(byId(h).a).toMatchObject({ invested: 100, won: 200, net: 100, vpip: true, pfr: true, sawFlop: true, raises: 2, calls: 0, checks: 2, showdown: true, wonShowdown: true });
    expect(byId(h).b).toMatchObject({ invested: 100, won: 0, net: -100, vpip: true, pfr: false, sawFlop: true, raises: 0, calls: 2, checks: 3, showdown: true, wonShowdown: false });
    expect(h.players.reduce((x, p) => x + p.net, 0)).toBe(0);
  });

  it('la ciega grande que pasa no es vpip; el all-in corto cuenta como igualar', () => {
    const start = startHand([seat('a', 1000), seat('b', 50)], { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(4) });
    const { state, log } = play(start, [['a', { type: 'raise', to: 100 }], ['b', { type: 'allin' }]]);
    const h = summarizeHand(state, log);
    // b no pudo subir: su all-in fue igualar lo que le quedaba.
    expect(byId(h).b).toMatchObject({ calls: 1, raises: 0, vpip: true, pfr: false, allIn: true });
    const quiet = play(
      startHand([seat('a', 1000), seat('b', 1000)], { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(5) }),
      [['a', { type: 'call' }], ['b', { type: 'check' }]],
    );
    expect(byId(summarizeHand(quiet.state, quiet.log)).b).toMatchObject({ vpip: false, checks: 1 });
    expect(byId(summarizeHand(quiet.state, quiet.log)).a).toMatchObject({ vpip: true, calls: 1 });
  });

  it('el pendiente que no recompra no ve nada y no cobra; el que recompra juega como cualquiera', () => {
    const start = startHand([seat('a', 1000), seat('b', 1000), seat('p', 0, true), seat('q', 0, true)], { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(6) });
    let { state, log } = play(start, [['a', { type: 'call' }], ['b', { type: 'check' }]]);
    // p se retira sin pagar; q recompra y juega.
    ({ state, log } = (() => { const r = play(state, [['p', { type: 'fold' }]]); return { state: r.state, log: [...log, ...r.log] }; })());
    state = buyInHand(state, 'q', 300);
    const r = play(state, [['q', { type: 'call' }]]);
    state = r.state; log = [...log, ...r.log];
    // El resto se juega con checks hasta el final.
    for (let i = 0; state.street !== 'done' && i < 40; i++) {
      const l = legalActions(state)!;
      const spot = describeAction(state, { type: 'check' })!;
      log.push({ playerId: l.playerId, street: spot.street, kind: spot.kind, amount: spot.amount, auto: false });
      state = applyAction(state, l.playerId, { type: 'check' });
    }
    const h = summarizeHand(state, log);
    expect(byId(h).p).toMatchObject({ invested: 0, won: 0, net: 0, sawFlop: false, foldedStreet: 'preflop', folds: 1 });
    expect(byId(h).q).toMatchObject({ invested: 20, sawFlop: true, vpip: true });
    expect(h.players.reduce((x, p) => x + p.net, 0)).toBe(0);
  });

  it('cuenta las jugadas del servidor por tiempo agotado', () => {
    const start = startHand([seat('a', 1000), seat('b', 1000)], { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(7) });
    const { state, log } = play(start, [['a', { type: 'fold' }]]);
    const h = summarizeHand(state, log.map((x) => ({ ...x, auto: true })));
    expect(byId(h).a.autoActions).toBe(1);
    expect(byId(h).b.autoActions).toBe(0);
  });
});

describe('fuzz: el resumen cuadra con la mano', () => {
  it('invertido = pozo, cobrado = pozo y los netos suman cero', () => {
    const r = rng(2024);
    for (let g = 0; g < 1500; g++) {
      const n = 2 + r(6);
      const pend = r(3) === 0 ? 1 : 0;
      const seats = Array.from({ length: n + pend }, (_, i) => seat(`p${i}`, i < n ? 20 + r(500) : 0, i >= n));
      const funded = seats.filter((x) => !x.pending);
      const buttonId = funded[r(funded.length)].id;
      let s = startHand(seats, { button: seats.findIndex((x) => x.id === buttonId), smallBlind: 5, bigBlind: 10, randomInt: r });
      const positions = handPositions(s);
      expect(Object.keys(positions).length).toBe(n);
      const log: RecordedAction[] = [];
      for (let i = 0; s.street !== 'done'; i++) {
        if (i > 500) throw new Error('mano infinita');
        const l = legalActions(s)!;
        const pick = r(10);
        let a: Action;
        if (l.mustBuy) a = { type: 'fold' };
        else if (pick < 2) a = { type: 'fold' };
        else if (pick < 3 && l.canRaise) a = { type: 'allin' };
        else if (pick < 6 && l.canRaise) a = { type: 'raise', to: l.minRaiseTo + r(Math.max(1, l.maxRaiseTo - l.minRaiseTo + 1)) };
        else a = l.canCheck ? { type: 'check' } : { type: 'call' };
        const spot = describeAction(s, a)!;
        expect(spot.stackBefore).toBeGreaterThanOrEqual(0);
        log.push({ playerId: l.playerId, street: spot.street, kind: spot.kind, amount: spot.amount, auto: false });
        s = applyAction(s, l.playerId, a);
      }
      const h = summarizeHand(s, log);
      expect(h.players.reduce((x, p) => x + p.invested, 0)).toBe(h.pot);
      expect(h.players.reduce((x, p) => x + p.won, 0)).toBe(h.pot);
      expect(h.players.reduce((x, p) => x + p.net, 0)).toBe(0);
      for (const p of h.players) {
        expect(p.raises + p.calls + p.checks + p.folds).toBe(log.filter((x) => x.playerId === p.playerId).length);
        if (p.pfr) expect(p.vpip).toBe(true);
        if (p.sawFlop) expect(h.board.length).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
