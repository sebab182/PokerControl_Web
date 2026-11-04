import { describe, expect, it } from 'vitest';
import {
  blindLevel, maxBlindLevel, type Action, applyAction, computePots, describeHand, evaluate, explainWin, HoldemError, type HandState, legalActions, newDeck,
  publicView, revealCards, shownCards, shuffle, startHand, winDetails,
} from './index';

const cards = (s: string) => s.split(' ');
const score = (s: string) => evaluate(cards(s));

/** RNG determinista. */
function rng(seed: number) {
  return (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe('evaluate', () => {
  it('reconoce todas las categorías', () => {
    expect(score('As Ks Qs Js Ts 2d 3c').name).toBe('Escalera real');
    expect(score('9h 8h 7h 6h 5h Ad Kc').name).toBe('Escalera de color');
    expect(score('9h 9d 9s 9c 5h Ad Kc').name).toBe('Póker');
    expect(score('9h 9d 9s 5c 5h Ad Kc').name).toBe('Full house');
    expect(score('2h 9h Ah 5h Kh Ad Kc').name).toBe('Color');
    expect(score('9h 8d 7s 6c 5h Ad Kc').name).toBe('Escalera');
    expect(score('9h 9d 9s 6c 5h Ad Kc').name).toBe('Trío');
    expect(score('9h 9d 5s 5c 2h Ad Kc').name).toBe('Doble par');
    expect(score('9h 9d 4s 6c 2h Ad Kc').name).toBe('Par');
    expect(score('9h 8d 4s 6c 2h Ad Kc').name).toBe('Carta alta');
  });

  it('la rueda A-2-3-4-5 es la escalera más baja', () => {
    const wheel = score('Ah 2d 3s 4c 5h 9d Kc');
    const six = score('2h 3d 4s 5c 6h 9d Kc');
    expect(wheel.name).toBe('Escalera');
    expect(six.score).toBeGreaterThan(wheel.score);
  });

  it('desempata por kicker y por par', () => {
    expect(score('Ah Ad Ks 5c 2h 7d 9c').score).toBeGreaterThan(score('Ah Ad Qs 5c 2h 7d 9c').score);
    expect(score('Kh Kd Ks 5c 5h 7d 9c').score).toBeGreaterThan(score('Qh Qd Qs Ac Ah 7d 9c').score);
    expect(score('Ah Kd Qs Jc 9h 7d 3c').score).toBe(score('As Kc Qd Jh 9d 7c 3h').score);
  });

  it('el board cuenta: la mejor mano usa 5 de 7', () => {
    const r = score('Ah Ad 2s 2c 9h Kd Kc');
    expect(r.name).toBe('Doble par');
    expect(r.best).toHaveLength(5);
  });
});

describe('explicar la jugada', () => {
  it('nombra la jugada con sus rangos', () => {
    expect(describeHand(score('Jh Jd 8s 8c 2h 6d 3c'))).toBe('Doble par de jotas y ochos');
    expect(describeHand(score('9h 8d 7s 6c 5h Ad Kc'))).toBe('Escalera al 9');
    expect(describeHand(score('Ah Kd Qs Jc Th 2d 3c'))).toBe('Escalera al as');
    expect(describeHand(score('Ah 2d 3s 4c 5h 9d Kc'))).toBe('Escalera al 5');
    expect(describeHand(score('9h 9d 9s 5c 5h Ad Kc'))).toBe('Full house de nueves y cincos');
    expect(describeHand(score('2h 9h Kh 5h 7h Ad Qc'))).toBe('Color al rey');
    expect(describeHand(score('Ah 8d 4s 6c 2h Td Kc'))).toBe('Carta alta: as');
    expect(describeHand(score('As Ks Qs Js Ts 2d 3c'))).toBe('Escalera real');
  });

  it('con la misma jugada aclara la carta que desempata', () => {
    // Doble par en la mesa: gana el as en mano.
    const board = 'Jh Jd 8s 8c 2h';
    const ace = score(`${board} Ad 3c`);
    const king = score(`${board} Kc 4d`);
    expect(explainWin(ace, king)).toBe('Doble par de jotas y ochos, con as de kicker');
    // Si la jugada ya es distinta, no hace falta.
    expect(explainWin(score('Kh Kd 8s 8c 2h 6d 3c'), score('Jh Jd 8s 8c 2h 6d 3c'))).toBe('Doble par de reyes y ochos');
    expect(explainWin(score('Kh Kd 8s 8c 2h 6d 3c'), score('Ah 2d 4s 9c 7h'))).toBe('Doble par de reyes y ochos');
    expect(explainWin(score('Ah Qd 9s 6c 3h'), score('Ad Jd 9c 6h 3s'))).toBe('Carta alta: as, desempata con reina');
  });

  it('winDetails explica cada ganador del showdown, o el empate, con las 5 cartas de su jugada', () => {
    const base = { street: 'done', board: cards('Jh Jd 8s 8c 2h'), showdown: [{ playerId: 'a', hole: [], handName: '' }] };
    const players = (b: string) => [
      { id: 'a', hole: cards('Ad 3c'), folded: false },
      { id: 'b', hole: cards(b), folded: false },
      { id: 'c', hole: cards('Ac Kd'), folded: true },
    ];
    const won = winDetails({ ...base, players: players('Kc 4d'), payouts: [{ playerId: 'a', amount: 100 }] } as unknown as HandState);
    expect(won.a.reason).toBe('Doble par de jotas y ochos, con as de kicker');
    expect([...won.a.cards].sort()).toEqual(cards('8c 8s Ad Jd Jh').sort());
    const split = winDetails({ ...base, players: players('As 4d'), payouts: [{ playerId: 'a', amount: 50 }, { playerId: 'b', amount: 50 }] } as unknown as HandState);
    expect([split.a.reason, split.b.reason]).toEqual(['Doble par de jotas y ochos (empate)', 'Doble par de jotas y ochos (empate)']);
    expect(winDetails({ ...base, showdown: [], players: players('Kc 4d'), payouts: [{ playerId: 'a', amount: 100 }] } as unknown as HandState)).toEqual({});
  });
});

describe('computePots', () => {
  it('arma pozo principal y lateral', () => {
    const pots = computePots([
      { id: 'a', totalBet: 50, folded: false },
      { id: 'b', totalBet: 100, folded: false },
      { id: 'c', totalBet: 100, folded: false },
      { id: 'd', totalBet: 30, folded: true },
    ]);
    expect(pots).toEqual([
      { amount: 50 * 3 + 30, eligible: ['a', 'b', 'c'] },
      { amount: 100, eligible: ['b', 'c'] },
    ]);
  });
});

function play(s: HandState, steps: [string, Action][]): HandState {
  for (const [id, a] of steps) s = applyAction(s, id, a);
  return s;
}

describe('mano', () => {
  const seats = (...stacks: number[]) => stacks.map((stack, i) => ({ id: 'abcdefghi'[i], stack }));
  // Mazo armado: reparte desde la ciega chica; luego flop (3), turn, river.
  const stacked = (hole: string[], board: string) => {
    const used = new Set([...hole, ...board.split(' ')]);
    return [...hole, ...board.split(' '), ...newDeck().filter((c) => !used.has(c))];
  };

  it('heads-up: el botón es ciega chica y actúa primero', () => {
    const s = startHand(seats(1000, 1000), { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(1) });
    expect(s.players[0].bet).toBe(10);
    expect(s.players[1].bet).toBe(20);
    expect(s.toAct).toBe(0);
    expect(legalActions(s)).toMatchObject({ toCall: 10, canCheck: false, minRaiseTo: 40 });
  });

  it('fold: el otro gana y se lleva el pozo', () => {
    let s = startHand(seats(1000, 1000), { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(2) });
    s = applyAction(s, 'a', { type: 'fold' });
    expect(s.street).toBe('done');
    expect(s.payouts).toEqual([{ playerId: 'b', amount: 30 }]);
    expect(s.players.map((p) => p.stack)).toEqual([990, 1010]);
  });

  it('check-down hasta showdown: gana la mejor mano', () => {
    // a (SB): AsAh; b (BB): KsKh. Board sin ayuda.
    let s = startHand(seats(1000, 1000), {
      button: 0, smallBlind: 10, bigBlind: 20,
      // reparto 1 a 1 desde la SB: a,b,a,b
      deck: stacked(['As', 'Ks', 'Ah', 'Kh'], '2c 7d 9h 3s Jd'),
    });
    s = play(s, [['a', { type: 'call' }], ['b', { type: 'check' }]]);
    expect(s.street).toBe('flop');
    expect(s.toAct).toBe(1); // heads-up postflop: primero el BB
    for (let i = 0; i < 3; i++) s = play(s, [['b', { type: 'check' }], ['a', { type: 'check' }]]);
    expect(s.street).toBe('done');
    expect(s.showdown.map((e) => e.handName)).toEqual(['Par', 'Par']);
    expect(s.payouts).toEqual([{ playerId: 'a', amount: 40 }]);
  });

  it('empate: se reparte el pozo y la ficha sobrante va a la izquierda del botón', () => {
    let s = startHand(seats(1000, 1000, 1000), {
      button: 0, smallBlind: 5, bigBlind: 10,
      // sb = b, bb = c, button = a. Reparto: b,c,a,b,c,a
      deck: stacked(['2s', '3s', '4s', '2h', '3h', '4h'], 'Ad Kd Qd Jd Td'), // escalera real en el board
    });
    s = play(s, [['a', { type: 'call' }], ['b', { type: 'call' }], ['c', { type: 'check' }]]);
    for (let i = 0; i < 3; i++) s = play(s, [['b', { type: 'check' }], ['c', { type: 'check' }], ['a', { type: 'check' }]]);
    expect(s.street).toBe('done');
    expect(s.payouts.reduce((x, p) => x + p.amount, 0)).toBe(30);
    expect(s.payouts.map((p) => p.amount)).toEqual([10, 10, 10]);
  });

  it('all-in corto genera pozo lateral y devuelve lo no igualado', () => {
    // a (corto) 100, b 500, c 500. Gana a la mano más alta, b segundo.
    let s = startHand(seats(100, 500, 500), {
      button: 0, smallBlind: 5, bigBlind: 10,
      // reparto desde SB=b: b,c,a,b,c,a
      deck: stacked(['Kc', '7c', 'As', 'Kd', '7d', 'Ah'], '2s 3d 9h Jc 4d'),
    });
    s = play(s, [
      ['a', { type: 'allin' }], // 100
      ['b', { type: 'raise', to: 300 }],
      ['c', { type: 'fold' }],
    ]);
    // Falta que b/a... a está all-in, b es el único que puede actuar y ya igualó: se reparte el resto.
    expect(s.street).toBe('done');
    const byId = Object.fromEntries(s.payouts.map((p) => [p.playerId, p.amount]));
    // pozo principal: 100*2 + 10(c, foldeó) = 210 → a (ases). lateral: 200 de b se le devuelve.
    expect(byId.a).toBe(210);
    expect(byId.b).toBe(200);
    expect(s.players.reduce((x, p) => x + p.stack, 0)).toBe(1100);
  });

  it('valida acciones ilegales', () => {
    const s = startHand(seats(1000, 1000), { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(3) });
    expect(() => applyAction(s, 'b', { type: 'call' })).toThrow(HoldemError); // no es su turno
    expect(() => applyAction(s, 'a', { type: 'check' })).toThrow(HoldemError);
    expect(() => applyAction(s, 'a', { type: 'raise', to: 30 })).toThrow(/mínima/);
    expect(() => applyAction(s, 'a', { type: 'raise', to: 5000 })).toThrow(HoldemError);
  });

  it('una subida corta (all-in) no reabre la acción a quien ya actuó', () => {
    let s = startHand(seats(1000, 1000, 125), {
      button: 0, smallBlind: 5, bigBlind: 10, randomInt: rng(4),
    });
    // orden: c es UTG? n=3: sb=b, bb=c, primero a (botón)
    s = applyAction(s, 'a', { type: 'raise', to: 100 }); // sube 90
    s = applyAction(s, 'b', { type: 'call' });
    s = applyAction(s, 'c', { type: 'allin' }); // 125: sube solo 25 (< 90): subida corta
    // a ya había subido; ahora puede igualar pero no resubir
    expect(legalActions(s)).toMatchObject({ playerId: 'a', canCall: true, canRaise: false });
  });

  it('publicView acepta varios jugadores propios', () => {
    const s = startHand(seats(1000, 1000, 1000), { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(6) });
    const v = publicView(s, ['a', 'c']);
    expect(v.players.map((p) => p.hole.includes('??'))).toEqual([false, true, false]);
  });

  it('publicView oculta cartas ajenas y el mazo', () => {
    const s = startHand(seats(1000, 1000), { button: 0, smallBlind: 10, bigBlind: 20, randomInt: rng(5) });
    const v = publicView(s, 'a');
    expect('deck' in v).toBe(false);
    expect(v.players[0].hole).toEqual(s.players[0].hole);
    expect(v.players[1].hole).toEqual(['??', '??']);
  });
});

describe('fuzz: conservación de fichas', () => {
  it('2000 manos aleatorias terminan y conservan las fichas', () => {
    const r = rng(12345);
    for (let g = 0; g < 2000; g++) {
      const n = 2 + r(7);
      const seats = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, stack: 20 + r(500) }));
      const total = seats.reduce((x, p) => x + p.stack, 0);
      let s = startHand(seats, { button: r(n), smallBlind: 5, bigBlind: 10, randomInt: r });
      let guard = 0;
      while (s.street !== 'done') {
        if (++guard > 500) throw new Error('mano infinita');
        const l = legalActions(s)!;
        const pick = r(10);
        let a: Action;
        if (pick < 2) a = { type: 'fold' };
        else if (pick < 3 && l.canRaise) a = { type: 'allin' };
        else if (pick < 6 && l.canRaise) a = { type: 'raise', to: l.minRaiseTo + r(Math.max(1, l.maxRaiseTo - l.minRaiseTo + 1)) };
        else a = l.canCheck ? { type: 'check' } : { type: 'call' };
        s = applyAction(s, l.playerId, a);
      }
      expect(s.players.reduce((x, p) => x + p.stack, 0)).toBe(total);
      expect(s.players.every((p) => p.stack >= 0)).toBe(true);
      expect(s.payouts.reduce((x, p) => x + p.amount, 0)).toBe(s.pots.reduce((x, p) => x + p.amount, 0));
    }
  });

  it('shuffle conserva las 52 cartas', () => {
    const d = shuffle(newDeck(), rng(7));
    expect(new Set(d).size).toBe(52);
  });

  describe('mostrar cartas', () => {
    const start = () => startHand([{ id: 'a', stack: 100 }, { id: 'b', stack: 100 }], { button: 0, smallBlind: 1, bigBlind: 2, randomInt: rng(3) });
    const foldedHand = () => {
      const s = start();
      return applyAction(s, legalActions(s)!.playerId, { type: 'fold' });
    };

    it('el único que queda puede mostrar una carta o las dos', () => {
      const s = foldedHand();
      const winner = s.players.find((p) => !p.folded)!;
      const one = revealCards(s, winner.id, [1]);
      expect(shownCards(one, winner.id)).toEqual([1]);
      const view = publicView(one, null).players.find((p) => p.id === winner.id)!;
      expect(view.hole).toEqual(['??', winner.hole[1]]);
      expect(shownCards(revealCards(one, winner.id), winner.id)).toEqual([0, 1]);
    });

    it('quien se retiró solo puede mostrar las dos, y nadie antes de que termine', () => {
      const s = foldedHand();
      const loser = s.players.find((p) => p.folded)!;
      expect(() => revealCards(s, loser.id, [0])).toThrow(HoldemError);
      expect(shownCards(revealCards(s, loser.id), loser.id)).toEqual([0, 1]);
      expect(() => revealCards(start(), 'a')).toThrow(HoldemError);
    });

    it('en un showdown el ganador muestra; el perdedor elige mostrar o no', () => {
      let s = start();
      while (s.street !== 'done') s = applyAction(s, legalActions(s)!.playerId, legalActions(s)!.canCheck ? { type: 'check' } : { type: 'call' });
      expect(s.showdown).toHaveLength(2);
      const win = s.payouts[0].playerId;
      const lose = s.players.find((p) => p.id !== win)!;
      expect(shownCards(s, win)).toEqual([0, 1]);
      expect(() => revealCards(s, win)).toThrow(HoldemError);
      expect(shownCards(s, lose.id)).toEqual([]);
      const view = publicView(s, win);
      expect(view.players.find((p) => p.id === lose.id)!.hole).toEqual(['??', '??']);
      expect(view.showdown.find((e) => e.playerId === lose.id)).toMatchObject({ hole: ['??', '??'], handName: '' });
      expect(shownCards(revealCards(s, lose.id), lose.id)).toEqual([0, 1]);
    });
  });
});

describe('ciegas por tiempo', () => {
  const base = { smallBlind: 10, bigBlind: 20, buyIn: 1000 };
  const min = (n: number) => n * 60_000;

  it('se duplican cada intervalo, siempre sobre las ciegas base', () => {
    expect(blindLevel({ ...base, minutes: 15, elapsedMs: 0 })).toEqual({ level: 0, small: 10, big: 20, atCap: false, nextAtMs: min(15) });
    expect(blindLevel({ ...base, minutes: 15, elapsedMs: min(14) + 59_000 }).big).toBe(20);
    expect(blindLevel({ ...base, minutes: 15, elapsedMs: min(15) })).toMatchObject({ level: 1, small: 20, big: 40, nextAtMs: min(30) });
    expect(blindLevel({ ...base, minutes: 15, elapsedMs: min(47) })).toMatchObject({ level: 3, small: 80, big: 160 });
  });

  it('la ciega grande no pasa de la mitad de la entrada', () => {
    // 20 → 40 → 80 → 160 → 320; 640 supera 500.
    expect(maxBlindLevel(20, 1000)).toBe(4);
    const capped = blindLevel({ ...base, minutes: 15, elapsedMs: min(15 * 50) });
    expect(capped).toEqual({ level: 4, small: 160, big: 320, atCap: true, nextAtMs: null });
    expect(blindLevel({ ...base, minutes: 15, elapsedMs: min(15 * 4) }).atCap).toBe(true);
    expect(blindLevel({ ...base, minutes: 15, elapsedMs: min(15 * 3) }).atCap).toBe(false);
  });

  it('con 0 minutos nunca se duplican', () => {
    expect(blindLevel({ ...base, minutes: 0, elapsedMs: min(10_000) })).toEqual({ level: 0, small: 10, big: 20, atCap: true, nextAtMs: null });
  });

  it('si la entrada es justa (el doble de la ciega) no hay subidas; un reloj adelantado no baja el nivel', () => {
    expect(maxBlindLevel(500, 1000)).toBe(0);
    expect(blindLevel({ smallBlind: 250, bigBlind: 500, buyIn: 1000, minutes: 15, elapsedMs: min(999) })).toMatchObject({ level: 0, atCap: true });
    expect(blindLevel({ ...base, minutes: 15, elapsedMs: -5000 }).level).toBe(0);
  });
});
