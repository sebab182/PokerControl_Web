import { type Card, newDeck, shuffle } from './cards';
import { evaluate } from './evaluate';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'done';

export interface HandPlayer {
  id: string;
  /** Fichas disponibles (sin contar lo apostado en la mano). */
  stack: number;
  /** Apuesta en la ronda actual. */
  bet: number;
  /** Total aportado al pozo en la mano. */
  totalBet: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  canRaise: boolean;
  hole: Card[];
}

export interface Pot {
  amount: number;
  eligible: string[];
}

export interface Payout {
  playerId: string;
  amount: number;
}

export interface ShowdownEntry {
  playerId: string;
  hole: Card[];
  handName: string;
}

export interface HandState {
  players: HandPlayer[];
  button: number;
  smallBlind: number;
  bigBlind: number;
  street: Street;
  board: Card[];
  deck: Card[];
  /** Índice del jugador al que le toca, o -1 si la mano terminó. */
  toAct: number;
  currentBet: number;
  minRaise: number;
  pots: Pot[];
  payouts: Payout[];
  showdown: ShowdownEntry[];
}

export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'raise'; to: number }
  | { type: 'allin' };

export interface LegalActions {
  playerId: string;
  toCall: number;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export class HoldemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldemError';
  }
}

export interface StartOptions {
  button: number;
  smallBlind: number;
  bigBlind: number;
  /** Entero uniforme en [0, n). Obligatorio salvo que se pase `deck`. */
  randomInt?: (n: number) => number;
  /** Mazo ya ordenado (tests). Se reparte desde el principio. */
  deck?: Card[];
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function able(p: HandPlayer): boolean {
  return !p.folded && !p.allIn;
}

function needsAction(s: HandState, p: HandPlayer): boolean {
  return able(p) && (!p.acted || p.bet < s.currentBet);
}

function nextIndex(s: HandState, from: number, pred: (p: HandPlayer) => boolean): number {
  const n = s.players.length;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (pred(s.players[i])) return i;
  }
  return -1;
}

function postBlind(p: HandPlayer, amount: number): void {
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.bet += a;
  p.totalBet += a;
  if (p.stack === 0) p.allIn = true;
}

/** Inicia una mano. `seats` en orden de asiento; solo jugadores con fichas. */
export function startHand(seats: { id: string; stack: number }[], opts: StartOptions): HandState {
  const n = seats.length;
  if (n < 2) throw new HoldemError('Se necesitan al menos 2 jugadores');
  if (seats.some((p) => !(p.stack > 0))) throw new HoldemError('Todos los jugadores deben tener fichas');
  if (new Set(seats.map((p) => p.id)).size !== n) throw new HoldemError('Jugadores duplicados');
  if (!(opts.bigBlind > 0) || !(opts.smallBlind > 0) || opts.smallBlind > opts.bigBlind) {
    throw new HoldemError('Ciegas inválidas');
  }
  const deck = opts.deck ? opts.deck.slice() : shuffle(newDeck(), opts.randomInt ?? failRandom);
  const players: HandPlayer[] = seats.map((p) => ({
    id: p.id, stack: p.stack, bet: 0, totalBet: 0, folded: false, allIn: false, acted: false, canRaise: true, hole: [],
  }));
  const button = ((opts.button % n) + n) % n;
  const sb = n === 2 ? button : (button + 1) % n;
  const bb = (sb + 1) % n;

  const s: HandState = {
    players, button, smallBlind: opts.smallBlind, bigBlind: opts.bigBlind, street: 'preflop',
    board: [], deck, toAct: -1, currentBet: 0, minRaise: opts.bigBlind, pots: [], payouts: [], showdown: [],
  };
  postBlind(players[sb], opts.smallBlind);
  postBlind(players[bb], opts.bigBlind);
  s.currentBet = Math.max(players[sb].bet, players[bb].bet);

  for (let round = 0; round < 2; round++) {
    for (let k = 0; k < n; k++) players[(sb + k) % n].hole.push(s.deck.shift()!);
  }

  s.toAct = nextIndex(s, n === 2 ? sb : (bb + 1) % n, (p) => needsAction(s, p));
  settle(s);
  return s;
}

function failRandom(): number {
  throw new HoldemError('Falta randomInt o deck');
}

/** Acciones permitidas para el jugador al que le toca (null si la mano terminó). */
export function legalActions(s: HandState): LegalActions | null {
  if (s.street === 'done' || s.toAct < 0) return null;
  const p = s.players[s.toAct];
  const toCall = Math.max(0, s.currentBet - p.bet);
  const maxRaiseTo = p.bet + p.stack;
  const minRaiseTo = Math.min(s.currentBet + s.minRaise, maxRaiseTo);
  return {
    playerId: p.id,
    toCall,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount: Math.min(toCall, p.stack),
    canRaise: p.canRaise && p.stack > toCall,
    minRaiseTo,
    maxRaiseTo,
  };
}

/** Aplica una acción del jugador al que le toca. Devuelve un estado nuevo (no muta). */
export function applyAction(prev: HandState, playerId: string, action: Action): HandState {
  const legal = legalActions(prev);
  if (!legal) throw new HoldemError('La mano ya terminó');
  if (legal.playerId !== playerId) throw new HoldemError('No es tu turno');
  const s = clone(prev);
  const p = s.players[s.toAct];

  let act = action;
  if (act.type === 'allin') {
    act = legal.canRaise ? { type: 'raise', to: legal.maxRaiseTo } : legal.canCall ? { type: 'call' } : { type: 'check' };
  }

  switch (act.type) {
    case 'fold':
      p.folded = true;
      break;
    case 'check':
      if (!legal.canCheck) throw new HoldemError('No podés pasar: hay una apuesta');
      break;
    case 'call': {
      if (!legal.canCall) throw new HoldemError('No hay nada para igualar');
      p.stack -= legal.callAmount;
      p.bet += legal.callAmount;
      p.totalBet += legal.callAmount;
      if (p.stack === 0) p.allIn = true;
      break;
    }
    case 'raise': {
      const to = act.to;
      if (!Number.isInteger(to)) throw new HoldemError('Monto inválido');
      if (!legal.canRaise) throw new HoldemError('No podés subir');
      if (to <= s.currentBet) throw new HoldemError('La subida debe superar la apuesta actual');
      if (to > legal.maxRaiseTo) throw new HoldemError('No tenés fichas suficientes');
      if (to < legal.minRaiseTo) throw new HoldemError(`La subida mínima es a ${legal.minRaiseTo}`);
      const add = to - p.bet;
      const size = to - s.currentBet;
      p.stack -= add;
      p.bet = to;
      p.totalBet += add;
      if (p.stack === 0) p.allIn = true;
      if (size >= s.minRaise) {
        s.minRaise = size;
        for (const o of s.players) if (o !== p && able(o)) { o.acted = false; o.canRaise = true; }
      }
      s.currentBet = to;
      break;
    }
    default:
      throw new HoldemError('Acción inválida');
  }
  p.acted = true;
  p.canRaise = false;
  s.toAct = nextIndex(s, (s.toAct + 1) % s.players.length, (q) => needsAction(s, q));
  settle(s);
  return s;
}

/** Avanza calles / cierra la mano cuando corresponde. */
function settle(s: HandState): void {
  for (;;) {
    const live = s.players.filter((p) => !p.folded);
    if (live.length === 1) return finish(s, false);
    if (s.toAct >= 0) {
      // Un único jugador con fichas que ya igualó la apuesta máxima: no hay nada más que decidir.
      const ableNow = s.players.filter(able);
      if (!(ableNow.length === 1 && ableNow[0].bet >= s.currentBet)) return; // sigue la ronda
      s.toAct = -1;
    }
    if (s.street === 'river') return finish(s, true);
    // Cierra la ronda: nueva calle.
    for (const p of s.players) { p.bet = 0; p.acted = false; p.canRaise = true; }
    s.currentBet = 0;
    s.minRaise = s.bigBlind;
    if (s.street === 'preflop') { s.board.push(...s.deck.splice(0, 3)); s.street = 'flop'; }
    else if (s.street === 'flop') { s.board.push(s.deck.shift()!); s.street = 'turn'; }
    else { s.board.push(s.deck.shift()!); s.street = 'river'; }
    // Si a lo sumo uno puede actuar, no hay más apuestas: se reparte hasta el final.
    s.toAct = s.players.filter(able).length >= 2 ? nextIndex(s, (s.button + 1) % s.players.length, (p) => needsAction(s, p)) : -1;
  }
}

/** Calcula pozos principal y laterales a partir de lo aportado por cada jugador. */
export function computePots(players: Pick<HandPlayer, 'id' | 'totalBet' | 'folded'>[]): Pot[] {
  const levels = [...new Set(players.filter((p) => p.totalBet > 0).map((p) => p.totalBet))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    const contributors = players.filter((p) => p.totalBet > prev);
    const amount = contributors.reduce((sum, p) => sum + Math.min(p.totalBet, level) - prev, 0);
    const eligible = players.filter((p) => !p.folded && p.totalBet >= level).map((p) => p.id);
    const last = pots[pots.length - 1];
    // Se fusiona con el pozo anterior si no cambia quién puede ganarlo (p. ej. un nivel creado por un fold).
    if (last && (eligible.length === 0 || last.eligible.join() === eligible.join())) last.amount += amount;
    else pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

function finish(s: HandState, showdown: boolean): void {
  const live = s.players.filter((p) => !p.folded);
  s.pots = computePots(s.players);
  const won = new Map<string, number>();
  const n = s.players.length;

  if (showdown && live.length > 1) {
    const scores = new Map(live.map((p) => [p.id, evaluate([...p.hole, ...s.board])]));
    s.showdown = live.map((p) => ({ playerId: p.id, hole: p.hole, handName: scores.get(p.id)!.name }));
    for (const pot of s.pots) {
      const top = Math.max(...pot.eligible.map((id) => scores.get(id)!.score));
      const winners = pot.eligible.filter((id) => scores.get(id)!.score === top);
      // Orden de desempate de fichas sobrantes: desde la izquierda del botón.
      winners.sort((a, b) => seatDistance(s, a) - seatDistance(s, b));
      const share = Math.floor(pot.amount / winners.length);
      let rest = pot.amount - share * winners.length;
      for (const id of winners) {
        const extra = rest > 0 ? 1 : 0;
        rest -= extra;
        won.set(id, (won.get(id) ?? 0) + share + extra);
      }
    }
  } else {
    // Todos menos uno se retiraron: se lleva todo (incluye apuestas no igualadas).
    won.set(live[0].id, s.pots.reduce((sum, p) => sum + p.amount, 0));
  }

  for (const p of s.players) p.stack += won.get(p.id) ?? 0;
  s.payouts = [...won.entries()].filter(([, a]) => a > 0).map(([playerId, amount]) => ({ playerId, amount }));
  s.street = 'done';
  s.toAct = -1;
  void n;
}

function seatDistance(s: HandState, id: string): number {
  const n = s.players.length;
  const i = s.players.findIndex((p) => p.id === id);
  return (i - s.button - 1 + n * 2) % n;
}

/**
 * Vista segura para un jugador: oculta cartas ajenas (salvo las mostradas en el showdown)
 * y el mazo. Es lo único que debe salir del servidor hacia los clientes.
 */
export function publicView(s: HandState, viewerId: string | null): Omit<HandState, 'deck'> {
  const shown = new Set(s.showdown.map((e) => e.playerId));
  const { deck: _deck, ...rest } = clone(s);
  void _deck;
  return {
    ...rest,
    players: rest.players.map((p) => (p.id === viewerId || shown.has(p.id) ? p : { ...p, hole: p.hole.map(() => '??') })),
  };
}
