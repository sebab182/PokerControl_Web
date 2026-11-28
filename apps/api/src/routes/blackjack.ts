/**
 * Blackjack «contra todos» sobre la mesa online: un jugador juega su mano contra un croupier automático y todos los demás
 * cubren su apuesta por cabeza (ver packages/core/src/blackjack).
 *
 * No hay compra inicial: se juega con saldo que arranca en 0 y puede quedar en negativo. El saldo de cada uno es lo que
 * ganó menos lo que perdió en las manos de su partida de blackjack (que es siempre una partida propia, aparte de la de
 * póker); al cerrarla ese saldo es su resultado y se generan las deudas. Participa todo el grupo, esté o no conectado;
 * solo juegan turno los conectados.
 *
 * Dos usos: como juego de la mesa (`game = 'blackjack'`: una mano por jugador, en rotación) y como interludio del póker
 * (cada vez que cambian las ciegas, una mano por jugador con apuesta fija = ciega grande; el reloj de las ciegas se frena).
 *
 * Este módulo no importa nada de table.ts: table.ts lo llama (reparto, vencimientos, vista).
 */

import { randomInt, randomUUID } from 'node:crypto';
import {
  BlackjackError, act, analyzeBlackjack, canBet, handValue, legalBjActions, newRound, placeBet, skipRound,
  type BjAction, type BjResult, type BjState,
} from '@pokercontrol/core';
import type { ApiBjView } from '@pokercontrol/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { ApiError } from '../errors';
import type { Conn, Tx } from '../repo';
import { finalizeNets, gameNets, groupPlayers, playerNames, plays } from './game-nets';
import { closeSessionTx, defaultSessionName } from './sessions';

type TableRow = typeof schema.pokerTables.$inferSelect;
type SeatRow = typeof schema.pokerSeats.$inferSelect;
export type BjRow = typeof schema.blackjackHands.$inferSelect;

const bump = sql`${schema.pokerTables.version} + 1`;

// ─── Carga ───────────────────────────────────────────────────────────────────

export async function latestBj(db: Conn, tableId: string): Promise<BjRow | null> {
  const [row] = await db.select().from(schema.blackjackHands).where(eq(schema.blackjackHands.tableId, tableId))
    .orderBy(desc(schema.blackjackHands.id)).limit(1);
  return row ?? null;
}

export async function activeBj(db: Conn, tableId: string): Promise<BjRow | null> {
  const row = await latestBj(db, tableId);
  return row?.status === 'active' ? row : null;
}

async function seatRows(db: Conn, tableId: string): Promise<SeatRow[]> {
  return db.select().from(schema.pokerSeats).where(eq(schema.pokerSeats.tableId, tableId))
    .orderBy(asc(schema.pokerSeats.joinedAt), asc(schema.pokerSeats.playerId));
}

const deadlineFor = (table: Pick<TableRow, 'turnSeconds'>): Date | null =>
  table.turnSeconds > 0 ? new Date(Date.now() + table.turnSeconds * 1000) : null;

// ─── Saldos y partida de blackjack ───────────────────────────────────────────

/** Abre la partida de blackjack del interludio: una partida propia, con todo el grupo y sin compra inicial. */
async function openInterludeSession(tx: Tx, table: TableRow, bigBlind: number): Promise<string> {
  const [poker] = await tx.select({ seasonId: schema.sessions.seasonId }).from(schema.sessions)
    .where(eq(schema.sessions.id, table.sessionId as string));
  const [group] = await tx.select({ timezone: schema.groups.timezone }).from(schema.groups).where(eq(schema.groups.id, table.groupId));
  const now = new Date();
  const id = randomUUID();
  await tx.insert(schema.sessions).values({
    id, groupId: table.groupId, seasonId: poker.seasonId,
    name: `${defaultSessionName(now, group?.timezone ?? 'UTC').replace('Party', 'Blackjack')} · ciegas $${bigBlind}`,
    status: 'active', createdAt: now, game: 'blackjack',
  });
  // Todos los jugadores del grupo, conectados o no: así el historial muestra lo que ganó o perdió cada uno.
  for (const p of await groupPlayers(tx, table.groupId)) {
    await tx.insert(schema.sessionParticipants).values({ groupId: table.groupId, sessionId: id, playerId: p.id });
  }
  return id;
}

/**
 * Cierra la partida de blackjack del interludio (al terminar la vuelta): el resultado de cada uno es su saldo y se
 * generan sus deudas, aparte de las del póker. Si nadie llegó a jugar una mano, no se registra nada.
 */
export async function closeInterlude(tx: Tx, table: TableRow): Promise<void> {
  // Se lee de la base: la mesa que llega puede estar desactualizada y la partida ya cerrarse (no se cierra dos veces).
  const [current] = await tx.select({ sid: schema.pokerTables.bjSessionId }).from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
  const sid = current?.sid;
  if (!sid) return;
  const hands = await tx.select({ state: schema.blackjackHands.state }).from(schema.blackjackHands)
    .where(eq(schema.blackjackHands.sessionId, sid));
  if (hands.every(h => h.state.result === 'skipped')) {
    await tx.delete(schema.sessions).where(eq(schema.sessions.id, sid));
  } else {
    await finalizeNets(tx, sid);
    await closeSessionTx(tx, table.groupId, sid);
  }
  await tx.update(schema.pokerTables).set({ bjSessionId: null }).where(eq(schema.pokerTables.id, table.id));
}

// ─── Reparto ─────────────────────────────────────────────────────────────────

/**
 * Arma y guarda la mano de `playerId`. En el interludio la apuesta es fija: la ciega grande. En el blackjack contra todos
 * queda esperando la apuesta, entre el mínimo y el máximo de la mesa. La banca son todos los participantes de la partida.
 */
async function startHand(
  tx: Tx, table: TableRow, playerId: string, kind: 'solo' | 'interlude', step: number, bigBlind: number,
): Promise<BjState | null> {
  const sessionId = (kind === 'interlude' ? table.bjSessionId : table.sessionId) as string;
  const bank = [...(await gameNets(tx, sessionId))].map(([id, stack]) => ({ id, stack }));
  const me = bank.find(s => s.id === playerId);
  const rivals = bank.filter(s => s.id !== playerId);
  if (!me || rivals.length === 0) return null;
  const [minBet, maxBet] = kind === 'interlude' ? [bigBlind, bigBlind] : [table.bjMinBet, table.bjMaxBet];
  let state = newRound({ playerId, playerStack: me.stack, rivals, minBet, maxBet, randomInt });
  if (!canBet(state)) state = skipRound(state);
  else if (kind === 'interlude') state = placeBet(state, bigBlind);
  const done = state.phase === 'done';
  await tx.insert(schema.blackjackHands).values({
    tableId: table.id, sessionId, kind, playerId, level: step, state,
    status: done ? 'done' : 'active', finishedAt: done ? new Date() : null,
  });
  await tx.update(schema.pokerTables).set({
    version: bump, turnDeadline: done ? null : deadlineFor(table), ...(kind === 'solo' ? { bjLast: playerId } : {}),
  }).where(eq(schema.pokerTables.id, table.id));
  // Última mano del interludio resuelta de entrada (blackjack natural, o saltea): termina la vuelta.
  if (done && kind === 'interlude' && table.bjQueue.length === 0) await closeInterlude(tx, table);
  return state;
}

/** Blackjack contra todos: le toca al conectado que sigue (en orden de asiento) al último que jugó. */
async function dealSolo(tx: Tx, table: TableRow): Promise<void> {
  const ids = (await seatRows(tx, table.id)).filter(s => plays(s)).map(s => s.playerId);
  if (ids.length < 1) throw new ApiError(422, 'not_enough_players', 'Hace falta al menos un jugador conectado.');
  let from = table.bjLast ? ids.indexOf(table.bjLast) : -1;
  for (let k = 1; k <= ids.length; k++) {
    const id = ids[(from + k + ids.length) % ids.length];
    const state = await startHand(tx, table, id, 'solo', 0, 0);
    if (state && state.result !== 'skipped') return;
    if (!state) throw new ApiError(422, 'not_enough_players', 'No hay con quién jugar: hacen falta otros jugadores en el grupo.');
    from = ids.indexOf(id);
    table = { ...table, bjLast: id };
  }
  throw new ApiError(422, 'bet_too_low', 'La apuesta máxima quedó por debajo de la mínima.');
}

/**
 * Reparte lo que sigue. Devuelve 'holdem' cuando toca una mano de póker (la reparte quien llama) y 'dealt' si se repartió
 * una mano de blackjack. En el póker, cada vez que cambian las ciegas se arma el interludio: una mano por cada conectado,
 * en orden de asiento, contra todo el grupo.
 */
export async function dealNext(tx: Tx, table: TableRow, blinds: { step: number; big: number }): Promise<'holdem' | 'dealt'> {
  if (table.game === 'blackjack') { await dealSolo(tx, table); return 'dealt'; }
  let queue = table.bjQueue;
  if (queue.length === 0 && table.bjInterlude && blinds.step > table.bjLevel) {
    queue = (await seatRows(tx, table.id)).filter(s => plays(s)).map(s => s.playerId);
    // Una partida de blackjack propia, aparte de la de póker (no toca sus fichas ni sus estadísticas).
    const bjSessionId = queue.length >= 1 ? await openInterludeSession(tx, table, blinds.big) : null;
    if (!bjSessionId) queue = [];
    table = { ...table, bjLevel: blinds.step, bjStartedAt: bjSessionId ? table.bjStartedAt ?? new Date() : table.bjStartedAt, bjSessionId };
    await tx.update(schema.pokerTables).set({ bjLevel: table.bjLevel, bjStartedAt: table.bjStartedAt, bjSessionId }).where(eq(schema.pokerTables.id, table.id));
  }
  while (queue.length > 0) {
    const [next, ...rest] = queue;
    queue = rest;
    await tx.update(schema.pokerTables).set({ bjQueue: queue }).where(eq(schema.pokerTables.id, table.id));
    const state = await startHand(tx, { ...table, bjQueue: queue }, next, 'interlude', blinds.step, blinds.big);
    // Una mano salteada no se muestra: se sigue con el que viene.
    if (state && state.result !== 'skipped') return 'dealt';
  }
  // Terminó la vuelta (por ejemplo, las últimas manos se salteaban): se cierra la partida de blackjack.
  await closeInterlude(tx, table);
  if (table.bjStartedAt) {
    // Termina el interludio: el reloj de las ciegas retoma desde donde estaba al empezar.
    const frozen = Date.now() - table.bjStartedAt.getTime();
    await tx.update(schema.pokerTables).set({
      bjStartedAt: null,
      ...(table.blindsStartedAt ? { blindsStartedAt: new Date(table.blindsStartedAt.getTime() + frozen) } : {}),
    }).where(eq(schema.pokerTables.id, table.id));
  }
  return 'holdem';
}

// ─── Jugadas ─────────────────────────────────────────────────────────────────

async function save(tx: Tx, table: TableRow, row: BjRow, playerId: string, next: BjState, auto: boolean): Promise<void> {
  const done = next.phase === 'done';
  await tx.update(schema.blackjackHands).set({ state: next, ...(done ? { status: 'done', finishedAt: new Date() } : {}) })
    .where(eq(schema.blackjackHands.id, row.id));
  const seat = and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId));
  if (auto) {
    // Dos turnos seguidos sin responder: queda afuera de las próximas manos (vuelve con "Volver a sentarme").
    await tx.update(schema.pokerSeats)
      .set({ timeouts: sql`${schema.pokerSeats.timeouts} + 1`, status: sql`case when ${schema.pokerSeats.timeouts} + 1 >= 2 then 'out' else ${schema.pokerSeats.status} end` })
      .where(seat);
  } else {
    await tx.update(schema.pokerSeats).set({ timeouts: 0 }).where(seat);
  }
  await tx.update(schema.pokerTables).set({ version: bump, turnDeadline: done ? null : deadlineFor(table) })
    .where(eq(schema.pokerTables.id, table.id));
  // Última mano del interludio: al terminar la vuelta se cierra su partida de blackjack, con sus deudas aparte.
  if (done && row.kind === 'interlude' && table.bjQueue.length === 0) await closeInterlude(tx, table);
}

function check(row: BjRow | null, playerId: string): BjState {
  if (!row) throw new ApiError(409, 'no_hand', 'No hay una mano de blackjack en juego.');
  const state = row.state;
  if (state.playerId !== playerId) throw new ApiError(409, 'not_your_turn', 'No es tu turno.');
  return state;
}

export async function bjBet(tx: Tx, table: TableRow, row: BjRow | null, playerId: string, amount: number, auto = false): Promise<void> {
  const state = check(row, playerId);
  try {
    await save(tx, table, row as BjRow, playerId, placeBet(state, amount), auto);
  } catch (e) {
    if (e instanceof BlackjackError) throw new ApiError(422, 'illegal_bet', e.message);
    throw e;
  }
}

export async function bjAct(tx: Tx, table: TableRow, row: BjRow | null, playerId: string, action: BjAction, auto = false): Promise<void> {
  const state = check(row, playerId);
  try {
    await save(tx, table, row as BjRow, playerId, act(state, playerId, action), auto);
  } catch (e) {
    if (e instanceof BlackjackError) throw new ApiError(422, 'illegal_action', e.message);
    throw e;
  }
}

/** Sin tiempo: apuesta la mínima (que el tope permita) o, ya en juego, se planta. Lo corre el barrido de turnos. */
export async function bjTimeout(tx: Tx, table: TableRow, row: BjRow): Promise<void> {
  const state = row.state;
  if (state.phase === 'betting') await bjBet(tx, table, row, state.playerId, state.minBet, true);
  else await bjAct(tx, table, row, state.playerId, 'stand', true);
}

// ─── Vista ───────────────────────────────────────────────────────────────────

const visibleTotal = (cards: string[]): number | null => {
  const shown = cards.filter(c => c !== '??');
  return shown.length ? handValue(shown).total : null;
};

/** Lo que ve cada uno de la mano de blackjack (sin el mazo; la carta tapada del croupier va como "??"). */
export async function bjView(
  db: Conn, table: TableRow, row: BjRow | null, me: { myId: string | null; managed: Set<string> },
): Promise<ApiBjView | null> {
  if (!row) return null;
  const s = row.state;
  const dealerHidden = !s.dealerRevealed && s.dealer.length > 1;
  const dealer = dealerHidden ? [s.dealer[0], '??'] : s.dealer;
  let position: ApiBjView['position'] = null;
  if (row.kind === 'interlude') {
    const rows = (await db.select({ id: schema.blackjackHands.id, state: schema.blackjackHands.state }).from(schema.blackjackHands).where(and(
      eq(schema.blackjackHands.tableId, table.id), eq(schema.blackjackHands.kind, 'interlude'), eq(schema.blackjackHands.level, row.level),
      eq(schema.blackjackHands.sessionId, row.sessionId),
    ))).filter(r => r.state.result !== 'skipped'); // las manos salteadas no cuentan
    const index = rows.filter(r => r.id <= row.id).length;
    const total = rows.length + (table.bjLevel === row.level ? table.bjQueue.length : 0);
    position = { index, total: Math.max(total, index), level: row.level };
  }
  let sessionClosed = false;
  if (row.kind === 'interlude') {
    const [sess] = await db.select({ status: schema.sessions.status }).from(schema.sessions).where(eq(schema.sessions.id, row.sessionId));
    sessionClosed = sess?.status === 'closed';
  }
  const acting = row.status === 'active' && (s.playerId === me.myId || me.managed.has(s.playerId)) ? s.playerId : null;
  return {
    handId: row.id,
    kind: row.kind,
    position,
    playerId: s.playerId,
    playerStack: s.playerStack,
    sessionId: row.sessionId,
    sessionClosed,
    phase: s.phase,
    bet: s.bet,
    minBet: s.minBet,
    maxBet: s.maxBet,
    player: s.player,
    dealer,
    playerTotal: s.player.length ? handValue(s.player).total : 0,
    dealerTotal: s.dealerRevealed ? (s.dealer.length ? handValue(s.dealer).total : null) : visibleTotal(dealer),
    result: s.result,
    canDouble: row.status === 'active' && legalBjActions(s).includes('double'),
    actingPlayerId: acting,
    rivals: s.rivals.map(r => ({ playerId: r.id, stack: r.stack })),
    deltas: Object.entries(s.deltas).map(([playerId, delta]) => ({ playerId, delta })),
    stats: await bjStatsOf(db, row.sessionId),
  };
}

/** Análisis de la partida: sale de las manos ya terminadas (sin traer los mazos, que no hacen falta). */
async function bjStatsOf(db: Conn, sessionId: string): Promise<ApiBjView['stats']> {
  const st = schema.blackjackHands.state;
  const rows = await db.select({
    playerId: sql<string>`${st}->>'playerId'`,
    result: sql<BjResult | null>`${st}->>'result'`,
    deltas: sql<Record<string, number>>`${st}->'deltas'`,
  }).from(schema.blackjackHands).where(and(eq(schema.blackjackHands.sessionId, sessionId), eq(schema.blackjackHands.status, 'done')));
  const raw = analyzeBlackjack(rows.map(r => ({ playerId: r.playerId, result: r.result, delta: r.deltas?.[r.playerId] ?? 0 })));
  const names = await playerNames(db, [raw.best?.playerId, raw.worst?.playerId].filter((x): x is string => !!x));
  const named = (x: { playerId: string; delta: number } | null) => (x ? { ...x, name: names.get(x.playerId) ?? 'Un jugador' } : null);
  return { ...raw, best: named(raw.best), worst: named(raw.worst) };
}
