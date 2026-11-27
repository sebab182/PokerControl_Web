/**
 * Ruleta europea «contra todos»: todos los conectados apuestan a la vez y gira una sola bola. Cada apostador juega contra
 * la casa; lo que la casa gana o pierde en total se reparte en partes iguales entre todos los del grupo (incluidos los que
 * apostaron). No hay compra inicial: se juega con saldo que arranca en 0 y puede quedar en negativo. Puro: sin base de
 * datos ni reloj; el servidor sortea el número y guarda las rondas.
 */

export type BetType = 'straight' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high' | 'dozen' | 'column';

export interface Bet {
  type: BetType;
  /** Pleno: el número (0 a 36). Docena y columna: 1, 2 o 3. Las demás no lo usan. */
  n?: number;
  /** Fichas apostadas (múltiplo de la ficha mínima). */
  amount: number;
}

export class RouletteError extends Error {
  constructor(message: string) { super(message); this.name = 'RouletteError'; }
}

/** Números rojos de la rueda europea; el resto (salvo el 0) son negros. */
export const RED_NUMBERS: readonly number[] = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

/** Orden de los casilleros en la rueda europea, para dibujarla. */
export const WHEEL_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

export type Color = 'green' | 'red' | 'black';

export const colorOf = (n: number): Color => (n === 0 ? 'green' : RED_NUMBERS.includes(n) ? 'red' : 'black');

/** Pagos: ganancia por ficha apostada (sin contar la ficha que vuelve). */
const MULTIPLIER: Record<BetType, number> = { straight: 35, dozen: 2, column: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1 };

/** Máximo de apuestas por jugador y por ronda. */
export const MAX_BETS = 20;

/** ¿Gana esta apuesta con este número? El 0 pierde todas las externas. */
export function betWins(bet: Bet, result: number): boolean {
  switch (bet.type) {
    case 'straight': return bet.n === result;
    case 'red': return colorOf(result) === 'red';
    case 'black': return colorOf(result) === 'black';
    case 'odd': return result > 0 && result % 2 === 1;
    case 'even': return result > 0 && result % 2 === 0;
    case 'low': return result >= 1 && result <= 18;
    case 'high': return result >= 19 && result <= 36;
    case 'dozen': return result >= 1 && Math.ceil(result / 12) === bet.n;
    case 'column': return result >= 1 && (result % 3 === 0 ? 3 : result % 3) === bet.n;
  }
}

/** Resultado neto de la apuesta: lo que gana (ficha × pago) o lo que pierde (la ficha). */
export const betNet = (bet: Bet, result: number): number => (betWins(bet, result) ? bet.amount * MULTIPLIER[bet.type] : -bet.amount);

export interface BetLimits { minBet: number; maxBet: number }

/** Valida las apuestas de un jugador en una ronda; lanza `RouletteError` con el motivo. */
export function validateBets(bets: Bet[], limits: BetLimits): void {
  if (bets.length > MAX_BETS) throw new RouletteError(`Hasta ${MAX_BETS} apuestas por ronda.`);
  let total = 0;
  for (const b of bets) {
    if (!(b.type in MULTIPLIER)) throw new RouletteError('Apuesta inválida.');
    if (b.type === 'straight' && !(Number.isInteger(b.n) && (b.n as number) >= 0 && (b.n as number) <= 36)) throw new RouletteError('El número va de 0 a 36.');
    if ((b.type === 'dozen' || b.type === 'column') && ![1, 2, 3].includes(b.n as number)) throw new RouletteError('Va de 1 a 3.');
    if (!Number.isInteger(b.amount) || b.amount < limits.minBet || b.amount % limits.minBet !== 0) {
      throw new RouletteError(`Cada apuesta es un múltiplo de ${limits.minBet}.`);
    }
    total += b.amount;
  }
  if (total > limits.maxBet) throw new RouletteError(`Podés apostar hasta ${limits.maxBet} por ronda.`);
}

export interface Settlement {
  /** Lo que ganó o perdió cada apostador con sus apuestas (sin el reparto de la casa). */
  nets: Record<string, number>;
  /** Lo que ganó la casa (negativo si perdió): es lo opuesto a la suma de lo de los apostadores. */
  house: number;
  /** Parte de la casa que le toca a cada miembro del grupo. */
  share: Record<string, number>;
  /** Cambio de saldo final de cada miembro: lo suyo más su parte de la casa. Suma 0. */
  deltas: Record<string, number>;
}

/**
 * Liquida una ronda. El resultado de la casa se reparte en partes iguales entre todos los miembros; como los saldos son
 * enteros, el resto se da de a uno en un orden fijo (por id) que rota con el número de ronda, así nadie lo cobra siempre.
 */
export function settleRound(input: { bets: Record<string, Bet[]>; result: number; members: string[]; round: number }): Settlement {
  const { bets, result, round } = input;
  const nets: Record<string, number> = {};
  for (const [id, list] of Object.entries(bets)) nets[id] = list.reduce((sum, b) => sum + betNet(b, result), 0);
  const members = [...new Set([...input.members, ...Object.keys(bets)])].sort();
  if (members.length === 0) throw new RouletteError('Hacen falta miembros.');
  // Se resta (no se niega la suma) para no dejar un -0 cuando la casa no gana ni pierde.
  const house = Object.values(nets).reduce((a, b) => a - b, 0);
  const n = members.length;
  const base = Math.floor(house / n);
  const rest = house - base * n; // 0 a n−1
  const share: Record<string, number> = {};
  const start = ((round % n) + n) % n;
  members.forEach((id, i) => { share[id] = base + ((i - start + n) % n < rest ? 1 : 0); });
  const deltas: Record<string, number> = {};
  for (const id of members) deltas[id] = (nets[id] ?? 0) + share[id];
  return { nets, house, share, deltas };
}
