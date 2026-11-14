/**
 * Blackjack «contra todos»: un jugador juega su mano contra un croupier automático y la apuesta la cubren, por cabeza,
 * todos los demás. Si gana, cobra la apuesta de cada rival; si pierde, se la paga a cada uno. La suma de los cambios de
 * saldo siempre da 0. No hay compra inicial: se juega con saldo que arranca en 0 y puede quedar en negativo. Puro: sin
 * base de datos ni reloj; el servidor guarda el estado y reparte los turnos.
 *
 * Reglas: el croupier se planta en 17 (también en 17 blando) y mira su carta tapada con as o figura/10 a la vista (si hace
 * blackjack la mano termina ahí). Blackjack natural paga 3 a 2 (redondeado hacia abajo); se puede doblar con las dos
 * primeras cartas. Sin dividir ni seguro.
 */

import { type Card, newDeck, shuffle } from '../holdem/cards';

export type BjAction = 'hit' | 'stand' | 'double';
export type BjPhase = 'betting' | 'player' | 'done';
export type BjResult = 'blackjack' | 'win' | 'push' | 'lose' | 'bust' | 'skipped';

/** `stack` es el saldo de la partida de blackjack (lo ganado menos lo perdido): arranca en 0 y puede ser negativo. */
export interface BjRival { id: string; stack: number }

export interface BjState {
  playerId: string;
  /** Saldo del jugador al empezar la mano (puede ser negativo). */
  playerStack: number;
  rivals: BjRival[];
  /** Apuesta por cabeza: cada rival arriesga esto contra el jugador (ya duplicada si dobló). */
  bet: number;
  minBet: number;
  /** Tope de la apuesta (se configura al iniciar la partida). */
  maxBet: number;
  phase: BjPhase;
  player: Card[];
  dealer: Card[];
  deck: Card[];
  doubled: boolean;
  /** El croupier ya mostró su carta tapada. */
  dealerRevealed: boolean;
  result: BjResult | null;
  /** Cambio de fichas de cada uno (jugador y rivales) al terminar la mano. */
  deltas: Record<string, number>;
}

export class BlackjackError extends Error {
  constructor(message: string) { super(message); this.name = 'BlackjackError'; }
}

// ─── Valores ─────────────────────────────────────────────────────────────────

function points(card: Card): number {
  const r = card[0];
  if (r === 'A') return 11;
  if ('TJQK'.includes(r)) return 10;
  const n = Number(r);
  if (!(n >= 2 && n <= 9)) throw new BlackjackError(`Carta inválida: ${card}`);
  return n;
}

/** Total de la mano: los ases valen 11 mientras no se pase de 21 (`soft`: hay un as contando 11). */
export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += points(c);
    if (c[0] === 'A') aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}

export const isBlackjack = (cards: Card[]): boolean => cards.length === 2 && handValue(cards).total === 21;

// ─── Mano ────────────────────────────────────────────────────────────────────

export interface NewRoundOptions {
  playerId: string;
  /** Saldo del jugador en la partida de blackjack (puede ser negativo). */
  playerStack: number;
  /** Todos los demás de la banca, con su saldo: cada uno cubre la apuesta, tengan o no saldo a favor. */
  rivals: BjRival[];
  minBet: number;
  /** Apuesta máxima: no depende del saldo de nadie. */
  maxBet: number;
  /** Entero uniforme en [0, n); obligatorio salvo que se pase `deck`. */
  randomInt?: (n: number) => number;
  deck?: Card[];
}

/** Arma la mano en fase de apuesta: todavía no se reparten cartas. */
export function newRound(opts: NewRoundOptions): BjState {
  if (opts.rivals.length === 0) throw new BlackjackError('Hacen falta rivales con fichas.');
  if (!opts.deck && !opts.randomInt) throw new BlackjackError('Falta randomInt o deck');
  return {
    playerId: opts.playerId, playerStack: opts.playerStack, rivals: opts.rivals.map(r => ({ ...r })),
    bet: 0, minBet: opts.minBet, maxBet: opts.maxBet,
    phase: 'betting', player: [], dealer: [],
    deck: opts.deck ? opts.deck.slice() : shuffle(newDeck(), opts.randomInt as (n: number) => number),
    doubled: false, dealerRevealed: false, result: null, deltas: {},
  };
}

const clone = (s: BjState): BjState => structuredClone(s);

/** ¿Puede apostar el jugador? Si el tope quedó por debajo de la apuesta mínima esa mano se saltea. */
export const canBet = (s: BjState): boolean => s.phase === 'betting' && s.maxBet >= s.minBet;

/** Apuesta y reparte: jugador, croupier, jugador, croupier (la segunda del croupier va tapada). */
export function placeBet(state: BjState, amount: number): BjState {
  if (state.phase !== 'betting') throw new BlackjackError('Ya se apostó en esta mano.');
  const min = Math.max(1, state.minBet);
  if (!Number.isInteger(amount) || amount < min) throw new BlackjackError(`La apuesta mínima es ${min}.`);
  if (amount > state.maxBet) throw new BlackjackError(`La apuesta máxima es ${state.maxBet}.`);
  const s = clone(state);
  s.bet = amount;
  s.phase = 'player';
  s.player.push(s.deck.shift() as Card);
  s.dealer.push(s.deck.shift() as Card);
  s.player.push(s.deck.shift() as Card);
  s.dealer.push(s.deck.shift() as Card);
  // El croupier mira su carta con as o 10 a la vista; solo con esas puede tener blackjack.
  if (isBlackjack(s.dealer)) return finish(s, isBlackjack(s.player) ? 'push' : 'lose');
  if (isBlackjack(s.player)) return finish(s, 'blackjack');
  return s;
}

/** La mano se saltea (nadie arriesga nada): el tope no deja ninguna apuesta posible. */
export function skipRound(state: BjState): BjState {
  if (state.phase !== 'betting') throw new BlackjackError('La mano ya empezó.');
  const s = clone(state);
  s.phase = 'done';
  s.result = 'skipped';
  s.deltas = {};
  return s;
}

export function legalBjActions(state: BjState): BjAction[] {
  if (state.phase !== 'player') return [];
  return state.player.length === 2 && !state.doubled ? ['hit', 'stand', 'double'] : ['hit', 'stand'];
}

export function act(state: BjState, playerId: string, action: BjAction): BjState {
  if (state.phase !== 'player') throw new BlackjackError('No es momento de jugar.');
  if (playerId !== state.playerId) throw new BlackjackError('No es tu turno.');
  if (!legalBjActions(state).includes(action)) throw new BlackjackError('Esa jugada no está permitida.');
  const s = clone(state);
  if (action === 'stand') return dealerPlay(s);
  if (action === 'double') { s.bet *= 2; s.doubled = true; }
  s.player.push(s.deck.shift() as Card);
  if (handValue(s.player).total > 21) return finish(s, 'bust');
  // Doblar es una sola carta; con 21 no hay nada más que pedir.
  if (action === 'double' || handValue(s.player).total === 21) return dealerPlay(s);
  return s;
}

/** El croupier muestra su carta y pide hasta llegar a 17 (se planta en 17 blando). */
function dealerPlay(s: BjState): BjState {
  s.dealerRevealed = true;
  while (handValue(s.dealer).total < 17) s.dealer.push(s.deck.shift() as Card);
  const p = handValue(s.player).total;
  const d = handValue(s.dealer).total;
  return finish(s, d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose');
}

/** Cierra la mano y calcula cuánto gana o pierde cada uno. */
function finish(s: BjState, result: BjResult): BjState {
  s.phase = 'done';
  s.result = result;
  s.dealerRevealed = true;
  const per = result === 'blackjack' ? Math.floor((s.bet * 3) / 2) : result === 'win' ? s.bet : result === 'push' ? 0 : -s.bet;
  s.deltas = {};
  for (const r of s.rivals) s.deltas[r.id] = per === 0 ? 0 : -per; // evita el -0 del empate
  s.deltas[s.playerId] = per * s.rivals.length;
  s.deck = [];
  return s;
}

/** Lo que ve cualquiera: sin el mazo y con la carta tapada del croupier mientras no la muestre. */
export function publicBjView(s: BjState): Omit<BjState, 'deck'> {
  const { deck: _deck, ...rest } = clone(s);
  void _deck;
  if (!rest.dealerRevealed && rest.dealer.length > 1) rest.dealer = [rest.dealer[0], '??', ...rest.dealer.slice(2).map(() => '??')];
  return rest;
}
