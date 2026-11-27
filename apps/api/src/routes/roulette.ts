/**
 * Ruleta «contra todos» sobre la mesa online (ver packages/core/src/roulette): mesa abierta, todos los conectados apuestan en
 * la misma ronda y gira una sola bola. Cada apostador juega contra la casa y lo que la casa gana o pierde se reparte en
 * partes iguales entre todo el grupo, esté o no conectado. No hay compra inicial (ver game-nets.ts).
 *
 * La ronda se abre con la primera apuesta y arranca la cuenta regresiva (`turn_deadline` de la mesa). Gira cuando vence el
 * tiempo (lo corre el barrido de turnos), cuando todos los conectados están listos o cuando quien puede repartir la gira ya.
 *
 * Este módulo no importa nada de table.ts: table.ts lo llama (apuestas, giro, vencimiento, vista).
 */

import { randomInt } from 'node:crypto';
import { RouletteError, settleRound, validateBets, type Bet } from '@pokercontrol/core';
import type { ApiRouletteView } from '@pokercontrol/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { ApiError } from '../errors';
import type { Conn, Tx } from '../repo';
import { gameNets, plays } from './game-nets';

type TableRow = typeof schema.pokerTables.$inferSelect;
type SeatRow = typeof schema.pokerSeats.$inferSelect;
export type RoundRow = typeof schema.rouletteRounds.$inferSelect;

const bump = sql`${schema.pokerTables.version} + 1`;
const HISTORY = 15;

let draw: () => number = () => randomInt(37);
/** Solo para los tests: fija el número que sale. Sin argumento vuelve al sorteo real (criptográfico). */
export function setRouletteDraw(fn?: () => number): void {
  draw = fn ?? (() => randomInt(37));
}

// ─── Carga ───────────────────────────────────────────────────────────────────

export async function latestRound(db: Conn, tableId: string): Promise<RoundRow | null> {
  const [row] = await db.select().from(schema.rouletteRounds).where(eq(schema.rouletteRounds.tableId, tableId))
    .orderBy(desc(schema.rouletteRounds.id)).limit(1);
  return row ?? null;
}

/** La ronda abierta (se está apostando), si hay. */
export async function activeRound(db: Conn, tableId: string): Promise<RoundRow | null> {
  const row = await latestRound(db, tableId);
  return row?.status === 'betting' ? row : null;
}

async function seatRows(db: Conn, tableId: string): Promise<SeatRow[]> {
  return db.select().from(schema.pokerSeats).where(eq(schema.pokerSeats.tableId, tableId))
    .orderBy(asc(schema.pokerSeats.joinedAt), asc(schema.pokerSeats.playerId));
}

const total = (bets: Bet[]): number => bets.reduce((n, b) => n + b.amount, 0);

/** ¿Tiene apuestas en la ronda abierta? Entonces no puede levantarse hasta que gire. */
export async function hasOpenBets(db: Conn, tableId: string, playerId: string): Promise<boolean> {
  const round = await activeRound(db, tableId);
  return !!round && (round.bets[playerId]?.length ?? 0) > 0;
}

// ─── Giro ────────────────────────────────────────────────────────────────────

/**
 * Gira la bola: sortea el número, liquida con la banca compartida y deja la ronda terminada. Una ronda sin apuestas no
 * se juega: se descarta. Corre con la mesa bloqueada.
 */
export async function spinRound(tx: Tx, table: TableRow, round: RoundRow): Promise<void> {
  if (Object.keys(round.bets).length === 0) {
    await tx.delete(schema.rouletteRounds).where(eq(schema.rouletteRounds.id, round.id));
    await tx.update(schema.pokerTables).set({ turnDeadline: null, version: bump }).where(eq(schema.pokerTables.id, table.id));
    return;
  }
  const result = draw();
  const members = [...(await gameNets(tx, round.sessionId)).keys()];
  const { deltas } = settleRound({ bets: round.bets, result, members, round: round.roundNo });
  await tx.update(schema.rouletteRounds).set({ status: 'done', result, deltas, finishedAt: new Date() })
    .where(eq(schema.rouletteRounds.id, round.id));
  await tx.update(schema.pokerTables).set({ turnDeadline: null, version: bump }).where(eq(schema.pokerTables.id, table.id));
}

/** Gira la ronda abierta ya (quien puede repartir) o por vencimiento del tiempo. */
export async function spinActive(tx: Tx, table: TableRow): Promise<void> {
  const round = await activeRound(tx, table.id);
  if (!round) throw new ApiError(409, 'no_round', 'No hay una ronda abierta: se abre con la primera apuesta.');
  await spinRound(tx, table, round);
}

/** Lo corre el barrido de turnos al vencer el tiempo para apostar. */
export async function rouletteTimeout(tx: Tx, table: TableRow): Promise<boolean> {
  const round = await activeRound(tx, table.id);
  if (!round) return false;
  await spinRound(tx, table, round);
  return true;
}

// ─── Apuestas ────────────────────────────────────────────────────────────────

/**
 * Guarda las apuestas de un jugador en la ronda abierta (reemplazan a las anteriores) y si está listo. Abre la ronda si no
 * hay: la primera apuesta arranca la cuenta regresiva. Si ya están listos todos los conectados, gira.
 */
export async function placeBets(tx: Tx, table: TableRow, playerId: string, bets: Bet[], ready: boolean): Promise<void> {
  if (table.game !== 'roulette' || table.status !== 'playing') throw new ApiError(409, 'not_playing', 'No hay una partida de ruleta en juego.');
  const seats = await seatRows(tx, table.id);
  const mine = seats.find(s => s.playerId === playerId);
  if (!mine || !plays(mine)) throw new ApiError(409, 'not_seated', 'Sentate en la mesa para apostar.');
  try {
    validateBets(bets, { minBet: table.rouMinBet, maxBet: table.rouMaxBet });
  } catch (e) {
    if (e instanceof RouletteError) throw new ApiError(422, 'illegal_bet', e.message);
    throw e;
  }
  let round = await activeRound(tx, table.id);
  if (!round) {
    const last = await latestRound(tx, table.id);
    [round] = await tx.insert(schema.rouletteRounds)
      .values({ tableId: table.id, sessionId: table.sessionId as string, roundNo: (last?.roundNo ?? 0) + 1 }).returning();
  }
  const nextBets = { ...round.bets };
  if (bets.length > 0) nextBets[playerId] = bets; else delete nextBets[playerId];
  const nextReady = new Set(round.ready);
  if (ready) nextReady.add(playerId); else nextReady.delete(playerId);
  const open = Object.keys(nextBets).length > 0;
  const current = { ...round, bets: nextBets, ready: [...nextReady] };
  await tx.update(schema.rouletteRounds).set({ bets: current.bets, ready: current.ready }).where(eq(schema.rouletteRounds.id, round.id));
  // La cuenta regresiva arranca con la primera apuesta y se apaga si se retiran todas.
  const deadline = open ? table.turnDeadline ?? new Date(Date.now() + table.rouBetSeconds * 1000) : null;
  await tx.update(schema.pokerTables).set({ turnDeadline: deadline, version: bump }).where(eq(schema.pokerTables.id, table.id));
  // Si ya están listos todos los conectados, gira (o, sin apuestas, la ronda se descarta).
  const present = seats.filter(s => plays(s)).map(s => s.playerId);
  if (present.length > 0 && present.every(id => nextReady.has(id))) await spinRound(tx, { ...table, turnDeadline: deadline }, current);
}

/** Cierra la mesa: una ronda abierta sin apuestas se descarta; con apuestas hay que esperar a que gire. */
export async function settleOpenRound(tx: Tx, table: TableRow): Promise<'open' | 'ok'> {
  const round = await activeRound(tx, table.id);
  if (!round) return 'ok';
  if (Object.keys(round.bets).length > 0) return 'open';
  await tx.delete(schema.rouletteRounds).where(eq(schema.rouletteRounds.id, round.id));
  return 'ok';
}

// ─── Vista ───────────────────────────────────────────────────────────────────

/** La ronda como la ve cada uno: el detalle de las apuestas de los demás se muestra recién cuando gira. */
export async function rouletteView(
  db: Conn, table: TableRow, row: RoundRow | null, me: { myId: string | null; managed: Set<string> },
): Promise<ApiRouletteView> {
  const seats = await seatRows(db, table.id);
  // Quién puede apostar ahora entre vos y los jugadores sin usuario que manejás: los que están sentados y presentes.
  const ids = [...(me.myId ? [me.myId] : []), ...me.managed];
  const acting = ids.find(id => { const s = seats.find(x => x.playerId === id); return !!s && plays(s); }) ?? null;
  const history = (await db.select({ result: schema.rouletteRounds.result }).from(schema.rouletteRounds)
    .where(and(eq(schema.rouletteRounds.sessionId, table.sessionId as string), eq(schema.rouletteRounds.status, 'done')))
    .orderBy(desc(schema.rouletteRounds.id)).limit(HISTORY)).map(r => r.result as number);
  const base = { actingPlayerId: acting, history, minBet: table.rouMinBet, maxBet: table.rouMaxBet };
  if (!row) {
    return { ...base, roundNo: 0, status: 'done', deadline: null, mine: [], totals: [], bets: [], result: null, nets: [], house: null, deltas: [] };
  }
  const done = row.status === 'done';
  const who = acting ?? me.myId;
  const players = [...new Set([...Object.keys(row.bets), ...row.ready])];
  let nets: { playerId: string; net: number }[] = [];
  let house: number | null = null;
  if (done && row.result !== null) {
    const s = settleRound({ bets: row.bets, result: row.result, members: Object.keys(row.deltas), round: row.roundNo });
    nets = Object.entries(s.nets).map(([playerId, net]) => ({ playerId, net }));
    house = s.house;
  }
  return {
    ...base,
    roundNo: row.roundNo,
    status: row.status,
    deadline: !done && table.turnDeadline ? table.turnDeadline.toISOString() : null,
    mine: who ? row.bets[who] ?? [] : [],
    totals: players.map(playerId => ({ playerId, total: total(row.bets[playerId] ?? []), ready: row.ready.includes(playerId) })),
    bets: done ? Object.entries(row.bets).map(([playerId, bets]) => ({ playerId, bets })) : [],
    result: row.result,
    nets,
    house,
    deltas: done ? Object.entries(row.deltas).map(([playerId, delta]) => ({ playerId, delta })) : [],
  };
}
