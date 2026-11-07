/**
 * Indicadores de una partida a partir del historial de manos: los habituales del póker (VPIP, PFR, 3-bet, agresión,
 * WTSD…), series para gráficos y el análisis "qué hubiese pasado". Todo es puro: recibe filas ya leídas.
 */

import { rankValue, suitOf, type Card } from './cards';
import { score7 } from './equity';
import type { ActionKind, StreetName } from './analysis';

export interface InsightAction {
  seq: number;
  playerId: string;
  street: StreetName | null;
  kind: ActionKind | null;
  amount: number | null;
  potBefore: number | null;
  toCall: number | null;
  stackBefore: number | null;
  auto: boolean;
  allIn: boolean;
  /** Milisegundos que tardó en decidir; null si no se sabe. */
  thinkMs: number | null;
}

export interface InsightPlayer {
  playerId: string;
  position: string | null;
  startStack: number;
  pending: boolean;
  hole: Card[];
  invested: number;
  won: number;
  net: number;
  foldedStreet: StreetName | null;
  sawFlop: boolean;
  vpip: boolean;
  pfr: boolean;
  allIn: boolean;
  showdown: boolean;
  wonShowdown: boolean;
  cardScore: number | null;
  handClass: string | null;
  allInEquity: number | null;
  evNet: number | null;
  hasStreetData: boolean;
}

export interface InsightHand {
  id: number;
  handNo: number;
  smallBlind: number;
  bigBlind: number;
  pot: number;
  board: Card[];
  /** Board completo, con las cartas que no llegaron a salir; null en manos anteriores a ese dato. */
  fullBoard: Card[] | null;
  endedOn: StreetName;
  wentToShowdown: boolean;
  players: InsightPlayer[];
  actions: InsightAction[];
}

/** Un porcentaje con su base: n de d oportunidades (d = 0 → sin datos). */
export interface Rate { n: number; d: number }

export interface PositionNet { position: string; hands: number; net: number; netBB: number }

export interface PlayerInsights {
  playerId: string;
  /** Manos en que recibió cartas y jugó (sin contar las de pendiente de recompra). */
  hands: number;
  net: number;
  /** Ganancia en ciegas grandes cada 100 manos. */
  bb100: number;
  vpip: Rate;
  pfr: Rate;
  threeBet: Rate;
  foldToThreeBet: Rate;
  cbet: Rate;
  foldToCbet: Rate;
  steal: Rate;
  bbDefend: Rate;
  /** Subidas sobre igualadas después del flop. */
  aggression: { raises: number; calls: number };
  /** (subidas) / (subidas + igualadas + retiradas) después del flop. */
  aggressionFreq: Rate;
  wtsd: Rate;
  wsd: Rate;
  wwsf: Rate;
  avgPot: number;
  avgThinkMs: number | null;
  avgCardScore: number | null;
  byPosition: PositionNet[];
  /** Neto en las manos con all-in (real y esperado). */
  allIn: { hands: number; net: number; evNet: number };
}

export interface HandRow {
  id: number;
  handNo: number;
  pot: number;
  board: Card[];
  endedOn: StreetName;
  wentToShowdown: boolean;
  bigBlind: number;
  players: { playerId: string; position: string | null; hole: Card[]; net: number; foldedStreet: StreetName | null; showdown: boolean; pending: boolean }[];
  actions: { playerId: string; street: StreetName | null; kind: ActionKind | null; amount: number | null; auto: boolean; allIn: boolean }[];
}

export interface SeriesPoint { handNo: number; values: Record<string, number> }

export interface WhatIfFold {
  handNo: number;
  playerId: string;
  street: StreetName;
  toCall: number;
  hole: Card[];
  board: Card[];
  result: 'win' | 'tie' | 'lose';
  /** Fichas de diferencia estimadas frente a lo que pasó: positivo = habrías ganado más; negativo = te ahorraste esa plata. */
  delta: number;
  auto: boolean;
}

export interface WhatIfCall {
  handNo: number;
  playerId: string;
  street: StreetName;
  toCall: number;
  /** Fichas que puso desde esa jugada hasta el final de la mano. */
  committed: number;
  net: number;
  won: boolean;
}

export interface AllInEvent {
  handNo: number;
  playerId: string;
  equity: number;
  net: number;
  evNet: number;
  hole: Card[];
  board: Card[];
}

export interface PlayerLuck {
  playerId: string;
  allInHands: number;
  net: number;
  evNet: number;
  /** net − evNet de los all-in: positivo = tuvo suerte. */
  luck: number;
  avgCardScore: number | null;
  /** Diferencia con el promedio de la mesa: positivo = recibió mejores cartas que el resto. */
  cardScoreVsTable: number | null;
  vpipRate: number | null;
}

export interface SessionInsights {
  hands: number;
  /** Manos con el dato de las cartas que faltaban, necesario para "y si no foldeabas". */
  handsWithRunout: number;
  players: PlayerInsights[];
  handRows: HandRow[];
  series: {
    /** Neto acumulado real por jugador, mano a mano. */
    net: SeriesPoint[];
    /** Neto acumulado esperado (los all-in valen su equity). */
    evNet: SeriesPoint[];
    pot: { handNo: number; pot: number; endedOn: StreetName; showdown: boolean }[];
    endedOn: Record<StreetName, number>;
  };
  whatIf: {
    allIns: AllInEvent[];
    folds: WhatIfFold[];
    calls: WhatIfCall[];
    luck: PlayerLuck[];
  };
}

const POSTFLOP: StreetName[] = ['flop', 'turn', 'river'];
const rate = (n: number, d: number): Rate => ({ n, d });
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Clase de una mano inicial: "AKs", "QTo", "88". */
export function handClass(hole: Card[]): string | null {
  if (hole.length < 2) return null;
  const [a, b] = [...hole.slice(0, 2)].sort((x, y) => rankValue(y) - rankValue(x));
  if (a[0] === b[0]) return a[0] + b[0];
  return a[0] + b[0] + (suitOf(a) === suitOf(b) ? 's' : 'o');
}

/**
 * Fuerza de las dos cartas iniciales, de 0 a 1, con la fórmula de Chen normalizada (AA = 1, 7-2 sin color ≈ 0).
 */
export function cardScore(hole: Card[]): number | null {
  if (hole.length < 2) return null;
  const [a, b] = [...hole.slice(0, 2)].sort((x, y) => rankValue(y) - rankValue(x));
  const hi = rankValue(a);
  const lo = rankValue(b);
  const top = (r: number): number => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let s = top(hi);
  if (hi === lo) s = Math.max(5, s * 2);
  else {
    if (suitOf(a) === suitOf(b)) s += 2;
    const gap = hi - lo - 1;
    s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && hi < 12) s += 1;
  }
  return round2(Math.min(1, Math.max(0, (Math.ceil(s) + 1) / 21)));
}

const FIRST_STEAL = new Set(['BTN', 'CO', 'SB', 'BTN/SB']);

/** Cartas del jugador contra las de sus rivales con el board completo: 1 gana, 0 empata, −1 pierde. */
function versus(hole: Card[], rivals: Card[][], board: Card[]): number {
  const mine = score7(hole.concat(board));
  const best = Math.max(...rivals.map((r) => score7(r.concat(board))));
  return mine > best ? 1 : mine === best ? 0 : -1;
}

interface Acc {
  hands: number; net: number; bbSum: number; potSum: number;
  vpip: Rate; pfr: Rate; threeBet: Rate; foldTo3: Rate; cbet: Rate; foldCbet: Rate; steal: Rate; bbDef: Rate;
  raises: number; calls: number; folds: number;
  sawFlop: number; showdown: number; wonSd: number; wonSaw: number;
  think: number[]; scores: number[];
  pos: Map<string, { hands: number; net: number; netBB: number }>;
  allIn: { hands: number; net: number; evNet: number };
}

const blank = (): Acc => ({
  hands: 0, net: 0, bbSum: 0, potSum: 0,
  vpip: rate(0, 0), pfr: rate(0, 0), threeBet: rate(0, 0), foldTo3: rate(0, 0), cbet: rate(0, 0), foldCbet: rate(0, 0),
  steal: rate(0, 0), bbDef: rate(0, 0),
  raises: 0, calls: 0, folds: 0, sawFlop: 0, showdown: 0, wonSd: 0, wonSaw: 0, think: [], scores: [],
  pos: new Map(), allIn: { hands: 0, net: 0, evNet: 0 },
});

const bump = (r: Rate, hit: boolean): void => { r.d++; if (hit) r.n++; };

/** Indicadores de la partida a partir de sus manos (en orden). */
export function analyzeSession(hands: InsightHand[]): SessionInsights {
  const acc = new Map<string, Acc>();
  const get = (id: string): Acc => { let a = acc.get(id); if (!a) { a = blank(); acc.set(id, a); } return a; };

  const netSeries: SeriesPoint[] = [];
  const evSeries: SeriesPoint[] = [];
  const cumNet: Record<string, number> = {};
  const cumEv: Record<string, number> = {};
  const allIns: AllInEvent[] = [];
  const folds: WhatIfFold[] = [];
  const calls: WhatIfCall[] = [];
  const endedOn: Record<StreetName, number> = { preflop: 0, flop: 0, turn: 0, river: 0 };
  const handRows: HandRow[] = [];

  for (const h of hands) {
    const actions = [...h.actions].sort((a, b) => a.seq - b.seq);
    const playing = h.players.filter((p) => !p.pending);
    endedOn[h.endedOn]++;

    for (const p of playing) {
      const a = get(p.playerId);
      a.hands++;
      a.net += p.net;
      a.bbSum += h.bigBlind > 0 ? p.net / h.bigBlind : 0;
      a.potSum += h.pot;
      if (p.cardScore !== null) a.scores.push(p.cardScore);
      if (p.hasStreetData) {
        bump(a.vpip, p.vpip);
        bump(a.pfr, p.pfr);
      }
      if (p.sawFlop) {
        a.sawFlop++;
        if (p.won > 0) a.wonSaw++;
        if (p.showdown) { a.showdown++; if (p.wonShowdown) a.wonSd++; }
      }
      const pos = p.position ?? '—';
      const row = a.pos.get(pos) ?? { hands: 0, net: 0, netBB: 0 };
      row.hands++;
      row.net += p.net;
      row.netBB += h.bigBlind > 0 ? p.net / h.bigBlind : 0;
      a.pos.set(pos, row);
      if (p.evNet !== null) {
        a.allIn.hands++;
        a.allIn.net += p.net;
        a.allIn.evNet += p.evNet;
      }
    }

    // Series acumuladas (el esperado reemplaza el neto solo en las manos con all-in calculado).
    for (const p of playing) {
      cumNet[p.playerId] = (cumNet[p.playerId] ?? 0) + p.net;
      cumEv[p.playerId] = (cumEv[p.playerId] ?? 0) + (p.evNet ?? p.net);
    }
    netSeries.push({ handNo: h.handNo, values: { ...cumNet } });
    evSeries.push({ handNo: h.handNo, values: { ...cumEv } });

    if (playing.length > 0 && playing.every((p) => p.hasStreetData)) {
      analyzeActions(h, actions, playing, get);
    }
    for (const p of playing) {
      for (const x of actions) if (x.playerId === p.playerId && x.thinkMs !== null && !x.auto) get(p.playerId).think.push(x.thinkMs);
    }

    // Qué hubiese pasado.
    for (const p of playing) {
      if (p.evNet !== null && p.allInEquity !== null) {
        allIns.push({ handNo: h.handNo, playerId: p.playerId, equity: p.allInEquity, net: p.net, evNet: p.evNet, hole: p.hole, board: h.board });
      }
    }
    if (h.fullBoard && h.fullBoard.length === 5) whatIfFolds(h, actions, playing, folds);
    whatIfCalls(h, actions, playing, calls);

    handRows.push({
      id: h.id, handNo: h.handNo, pot: h.pot, board: h.board, endedOn: h.endedOn, wentToShowdown: h.wentToShowdown, bigBlind: h.bigBlind,
      players: h.players.map((p) => ({ playerId: p.playerId, position: p.position, hole: p.hole, net: p.net, foldedStreet: p.foldedStreet, showdown: p.showdown, pending: p.pending })),
      actions: actions.map((x) => ({ playerId: x.playerId, street: x.street, kind: x.kind, amount: x.amount, auto: x.auto, allIn: x.allIn })),
    });
  }

  const players: PlayerInsights[] = [...acc.entries()].map(([playerId, a]) => ({
    playerId,
    hands: a.hands,
    net: a.net,
    bb100: a.hands ? round2((a.bbSum / a.hands) * 100) : 0,
    vpip: a.vpip, pfr: a.pfr, threeBet: a.threeBet, foldToThreeBet: a.foldTo3, cbet: a.cbet, foldToCbet: a.foldCbet,
    steal: a.steal, bbDefend: a.bbDef,
    aggression: { raises: a.raises, calls: a.calls },
    aggressionFreq: rate(a.raises, a.raises + a.calls + a.folds),
    wtsd: rate(a.showdown, a.sawFlop),
    wsd: rate(a.wonSd, a.showdown),
    wwsf: rate(a.wonSaw, a.sawFlop),
    avgPot: a.hands ? Math.round(a.potSum / a.hands) : 0,
    avgThinkMs: a.think.length ? Math.round(sum(a.think) / a.think.length) : null,
    avgCardScore: a.scores.length ? round2(sum(a.scores) / a.scores.length) : null,
    byPosition: [...a.pos.entries()].map(([position, r]) => ({ position, hands: r.hands, net: r.net, netBB: round2(r.netBB) })),
    allIn: { hands: a.allIn.hands, net: a.allIn.net, evNet: round2(a.allIn.evNet) },
  })).sort((x, y) => y.net - x.net);

  const tableAvg = (() => {
    const all = players.map((p) => p.avgCardScore).filter((x): x is number => x !== null);
    return all.length ? sum(all) / all.length : null;
  })();
  const luck: PlayerLuck[] = players.map((p) => ({
    playerId: p.playerId,
    allInHands: p.allIn.hands,
    net: p.allIn.net,
    evNet: p.allIn.evNet,
    luck: round2(p.allIn.net - p.allIn.evNet),
    avgCardScore: p.avgCardScore,
    cardScoreVsTable: p.avgCardScore !== null && tableAvg !== null ? round2(p.avgCardScore - tableAvg) : null,
    vpipRate: p.vpip.d ? round2(p.vpip.n / p.vpip.d) : null,
  }));

  return {
    hands: hands.length,
    handsWithRunout: hands.filter((h) => h.fullBoard && h.fullBoard.length === 5).length,
    players,
    handRows,
    series: {
      net: netSeries,
      evNet: evSeries,
      pot: hands.map((h) => ({ handNo: h.handNo, pot: h.pot, endedOn: h.endedOn, showdown: h.wentToShowdown })),
      endedOn,
    },
    whatIf: { allIns, folds, calls, luck },
  };
}

/** 3-bet, c-bet, robo de ciegas y demás indicadores que dependen del orden de las jugadas. */
function analyzeActions(h: InsightHand, actions: InsightAction[], playing: InsightPlayer[], get: (id: string) => Acc): void {
  const posOf = new Map(playing.map((p) => [p.playerId, p.position]));
  const valid = actions.filter((x) => x.street && x.kind);

  // Preflop.
  let raises = 0;
  let anyVoluntary = false;
  const seenPre = new Set<string>();
  const openers = new Map<string, number>(); // jugador que abrió → subidas que había cuando abrió
  const answered = new Set<string>();
  let lastRaiser: string | null = null;
  for (const x of valid.filter((v) => v.street === 'preflop')) {
    const a = get(x.playerId);
    const pos = posOf.get(x.playerId) ?? null;
    if (!seenPre.has(x.playerId)) {
      seenPre.add(x.playerId);
      if (raises === 1) bump(a.threeBet, x.kind === 'raise');
      if (!anyVoluntary && pos && FIRST_STEAL.has(pos)) bump(a.steal, x.kind === 'raise');
      if (pos === 'BB' && raises >= 1) bump(a.bbDef, x.kind === 'call' || x.kind === 'raise');
    }
    // Quien abrió y recibe una subida de otro.
    const opened = openers.get(x.playerId);
    if (opened !== undefined && raises > opened && !answered.has(x.playerId)) {
      answered.add(x.playerId);
      bump(a.foldTo3, x.kind === 'fold');
    }
    if (x.kind === 'raise') {
      if (raises === 0) openers.set(x.playerId, 1);
      raises++;
      lastRaiser = x.playerId;
    }
    if (x.kind === 'call' || x.kind === 'raise') anyVoluntary = true;
  }

  // Flop: c-bet del agresor preflop y respuesta de los demás.
  const flop = valid.filter((v) => v.street === 'flop');
  let bet = false;
  let cbetter: string | null = null;
  const seenFlop = new Set<string>();
  for (const x of flop) {
    const a = get(x.playerId);
    if (!seenFlop.has(x.playerId)) {
      seenFlop.add(x.playerId);
      if (!bet && x.playerId === lastRaiser) {
        bump(a.cbet, x.kind === 'raise');
        if (x.kind === 'raise') cbetter = x.playerId;
      } else if (cbetter && x.playerId !== cbetter && bet) {
        bump(a.foldCbet, x.kind === 'fold');
      }
    }
    if (x.kind === 'raise') bet = true;
  }

  // Agresión después del flop.
  for (const x of valid) {
    if (!POSTFLOP.includes(x.street!)) continue;
    const a = get(x.playerId);
    if (x.kind === 'raise') a.raises++;
    else if (x.kind === 'call') a.calls++;
    else if (x.kind === 'fold') a.folds++;
  }
}

/** Para cada retirada ante una apuesta, qué habría pasado de llegar al final con las cartas que salieron. */
function whatIfFolds(h: InsightHand, actions: InsightAction[], playing: InsightPlayer[], out: WhatIfFold[]): void {
  const board = h.fullBoard!;
  const byId = new Map(playing.map((p) => [p.playerId, p]));
  // Rivales: los que llegaron al showdown o, si no hubo, los que cobraron.
  const rivalsOf = (id: string): InsightPlayer[] => playing.filter((p) => p.playerId !== id && (h.wentToShowdown ? p.showdown : p.won > 0));
  for (const x of actions) {
    if (x.kind !== 'fold' || x.street === null || (x.toCall ?? 0) <= 0) continue;
    const me = byId.get(x.playerId);
    if (!me || me.hole.length < 2) continue;
    const rivals = rivalsOf(x.playerId).filter((r) => r.hole.length >= 2);
    if (rivals.length === 0) continue;
    const v = versus(me.hole, rivals.map((r) => r.hole), board);
    const toCall = x.toCall ?? 0;
    // Si hubiera igualado y ganado cobra el pozo final; si perdía, ponía además lo que le pedían.
    const delta = v > 0 ? h.pot : v === 0 ? Math.round(h.pot / 2) : -toCall;
    out.push({
      handNo: h.handNo, playerId: x.playerId, street: x.street, toCall, hole: me.hole, board,
      result: v > 0 ? 'win' : v === 0 ? 'tie' : 'lose', delta, auto: x.auto,
    });
  }
}

/** Igualadas que terminaron mal (y las que terminaron bien), con lo que se comprometió desde esa jugada. */
function whatIfCalls(h: InsightHand, actions: InsightAction[], playing: InsightPlayer[], out: WhatIfCall[]): void {
  const byId = new Map(playing.map((p) => [p.playerId, p]));
  const done = new Set<string>();
  for (const x of actions) {
    if (x.kind !== 'call' || x.street === null || done.has(x.playerId)) continue;
    const me = byId.get(x.playerId);
    if (!me || x.stackBefore === null) continue;
    done.add(x.playerId);
    const before = me.startStack - x.stackBefore;
    out.push({
      handNo: h.handNo, playerId: x.playerId, street: x.street, toCall: x.toCall ?? x.amount ?? 0,
      committed: Math.max(0, me.invested - before), net: me.net, won: me.net > 0,
    });
  }
}
