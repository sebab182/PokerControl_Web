/**
 * Mesa online de Texas Hold'em: una por grupo. Cualquier miembro con jugador puede sentarse,
 * iniciar la partida (se crea una Session normal) y jugar. Al cerrar, los stacks son los
 * resultados finales y se reutiliza el cierre de partidas (deudas y ranking).
 *
 * Servidor autoritativo: el mazo y las cartas ajenas nunca salen de acá (ver publicView).
 */

import { randomInt, randomUUID } from 'node:crypto';
import {
  CloseTableResponse, ErrorResponse, GroupParams, RebuyBody, RevealBody, SeatParams, StartTableBody, TableActionBody, TableView,
  type ApiTableView,
} from '@pokercontrol/contracts';
import {
  HoldemError, applyAction, legalActions, publicView, revealCards, shownCards, startHand, winDetails, type Action, type HandState,
} from '@pokercontrol/core';
import { type Static } from '@sinclair/typebox';
import { and, asc, desc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import type { LoggedAction } from '../db/schema';
import { ApiError, notFound } from '../errors';
import { idempotent } from '../idempotency';
import type { Conn, Tx } from '../repo';
import type { Role } from './auth';
import { isEditor, requireEditor } from './groups';
import { closeSessionTx, defaultSessionName } from './sessions';

const ONLINE_MS = 45_000;

type TableRow = typeof schema.pokerTables.$inferSelect;
type SeatRow = typeof schema.pokerSeats.$inferSelect;
type HandRow = typeof schema.pokerHands.$inferSelect;
type G = { Params: Static<typeof GroupParams> };

// ─── Carga ───────────────────────────────────────────────────────────────────

async function ensureTable(db: Conn, groupId: string, lock: boolean): Promise<TableRow> {
  await db.insert(schema.pokerTables).values({ id: randomUUID(), groupId }).onConflictDoNothing();
  const q = db.select().from(schema.pokerTables).where(eq(schema.pokerTables.groupId, groupId));
  const [table] = await (lock ? q.for('update') : q);
  return table;
}

async function loadSeats(db: Conn, tableId: string) {
  return db.select({ seat: schema.pokerSeats, name: schema.players.name }).from(schema.pokerSeats)
    .innerJoin(schema.players, and(
      eq(schema.players.groupId, schema.pokerSeats.groupId), eq(schema.players.id, schema.pokerSeats.playerId),
    ))
    .where(eq(schema.pokerSeats.tableId, tableId))
    .orderBy(asc(schema.pokerSeats.joinedAt), asc(schema.pokerSeats.playerId));
}

async function latestHand(db: Conn, tableId: string): Promise<HandRow | null> {
  const [hand] = await db.select().from(schema.pokerHands).where(eq(schema.pokerHands.tableId, tableId))
    .orderBy(desc(schema.pokerHands.handNo)).limit(1);
  return hand ?? null;
}

async function myPlayer(db: Conn, groupId: string, userId: string) {
  const [p] = await db.select({ id: schema.players.id, archivedAt: schema.players.archivedAt }).from(schema.players)
    .where(and(eq(schema.players.groupId, groupId), eq(schema.players.userId, userId)));
  return p ?? null;
}

async function requirePlayer(db: Conn, groupId: string, userId: string): Promise<string> {
  const p = await myPlayer(db, groupId, userId);
  if (!p) throw new ApiError(409, 'no_player', 'Elegí tu nick en el grupo antes de jugar.');
  if (p.archivedAt) throw new ApiError(409, 'player_archived', 'Tu jugador está archivado.');
  return p.id;
}

// ─── Vista ───────────────────────────────────────────────────────────────────

/** Quién mira: su usuario y si es administrador (puede jugar por los jugadores sin usuario). */
interface Viewer { userId: string; canManage: boolean }
const viewerOf = (req: { user: { sub: string }; role: Role }): Viewer => ({ userId: req.user.sub, canManage: isEditor(req.role) });

/** ¿Está presente? Conectado hace poco, o sentado por un administrador (no hay pantalla que lo renueve). */
const isPresent = (seat: SeatRow, now = Date.now()) =>
  seat.addedBy !== null || seat.userId === null || now - seat.lastSeenAt.getTime() < ONLINE_MS;

/** Tope de una recompra: la mitad de las fichas de quien más tiene en la mesa (lo apostado en la mano cuenta). */
function maxRebuy(seats: SeatRow[], live: HandState | undefined): number {
  const richest = Math.max(0, ...seats.map(seat => {
    const p = live?.players.find(x => x.id === seat.playerId);
    return p ? p.stack + p.totalBet : seat.stack;
  }));
  return Math.floor(richest / 2);
}

/**
 * Reparte la próxima mano y cierra la partida un administrador o quien la inició. Si esa persona se
 * levantó o no tuvo la mesa abierta en los últimos ONLINE_MS (esté sentada o no), cualquiera que esté
 * sentado, para que la partida no quede trabada.
 */
function mayHost(table: TableRow, seats: SeatRow[], viewer: Viewer, myId: string | null, now = Date.now()): boolean {
  if (table.status !== 'playing') return false;
  if (viewer.canManage || table.startedBy === viewer.userId) return true;
  const mine = seats.find(s => s.playerId === myId);
  if (!mine || mine.status !== 'sitting') return false;
  if (!table.startedBy) return true;
  if (seats.find(s => s.userId === table.startedBy)?.status === 'out') return true;
  return !table.hostSeenAt || now - table.hostSeenAt.getTime() >= ONLINE_MS;
}

/** Latido de quien inició la partida. No cambia nada visible para los demás, así que no avisa. */
async function hostBeat(tx: Tx, table: TableRow, userId: string): Promise<void> {
  if (table.status === 'playing' && table.startedBy === userId) {
    await tx.update(schema.pokerTables).set({ hostSeenAt: new Date() }).where(eq(schema.pokerTables.id, table.id));
  }
}

/** Nombre de quien inició la partida: su jugador en la mesa o, si no se sentó (administrador), su usuario. */
async function hostName(db: Conn, table: TableRow, seats: { seat: SeatRow; name: string }[]): Promise<string | null> {
  if (table.status !== 'playing' || !table.startedBy) return null;
  const seated = seats.find(({ seat }) => seat.userId === table.startedBy);
  if (seated) return seated.name;
  const [user] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, table.startedBy));
  return user?.name ?? null;
}

async function buildView(db: Conn, table: TableRow, viewer: Viewer): Promise<ApiTableView> {
  const me = await myPlayer(db, table.groupId, viewer.userId);
  const myId = me?.id ?? null;
  const seats = await loadSeats(db, table.id);
  const row = await latestHand(db, table.id);
  const state = row?.state as HandState | undefined;
  const live = row?.status === 'active' ? state : undefined;
  const now = Date.now();
  // Jugadores sin usuario que este administrador maneja: ve sus cartas y juega sus turnos.
  const managedIds = new Set(viewer.canManage ? seats.filter(({ seat }) => seat.userId === null).map(({ seat }) => seat.playerId) : []);
  const [last] = row
    ? await db.select().from(schema.pokerActions).where(eq(schema.pokerActions.handId, row.id))
      .orderBy(desc(schema.pokerActions.seq)).limit(1)
    : [];

  let hand: ApiTableView['hand'] = null;
  if (row && state) {
    const v = publicView(state, [...(myId ? [myId] : []), ...managedIds]);
    const actor = live && state.toAct >= 0 ? state.players[state.toAct].id : null;
    const actingFor = actor && (actor === myId || managedIds.has(actor)) ? actor : null;
    const legal = actingFor ? legalActions(state) : null;
    const wins = winDetails(state);
    hand = {
      handNo: row.handNo,
      street: v.street,
      board: v.board,
      pot: v.players.reduce((sum, p) => sum + p.totalBet, 0),
      currentBet: v.currentBet,
      minRaise: v.minRaise,
      button: v.button,
      toActPlayerId: v.toAct >= 0 ? v.players[v.toAct].id : null,
      players: v.players.map(p => ({
        playerId: p.id, stack: p.stack, bet: p.bet, totalBet: p.totalBet, folded: p.folded, allIn: p.allIn, hole: p.hole,
        shown: shownCards(state, p.id),
      })),
      actingPlayerId: legal ? actingFor : null,
      legal: legal
        ? {
          toCall: legal.toCall, canCheck: legal.canCheck, canCall: legal.canCall, callAmount: legal.callAmount,
          canRaise: legal.canRaise, minRaiseTo: legal.minRaiseTo, maxRaiseTo: legal.maxRaiseTo,
        }
        : null,
      lastAction: last
        ? {
          playerId: last.playerId, type: last.action.type,
          ...(last.action.amount !== undefined ? { amount: last.action.amount } : {}),
          ...(last.action.auto ? { auto: true } : {}),
        }
        : null,
      payouts: v.payouts.map(w => ({ ...w, ...wins[w.playerId] })),
      showdown: v.showdown,
    };
  }

  return {
    id: table.id,
    status: table.status,
    sessionId: table.sessionId,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    buyIn: table.buyIn,
    version: table.version,
    turnSeconds: table.turnSeconds,
    turnDeadline: live && table.turnDeadline ? table.turnDeadline.toISOString() : null,
    serverTime: new Date(now).toISOString(),
    maxRebuy: maxRebuy(seats.map(x => x.seat), live),
    myPlayerId: myId,
    host: await hostName(db, table, seats),
    canHost: mayHost(table, seats.map(x => x.seat), viewer, myId, now),
    isHost: table.status === 'playing' && table.startedBy === viewer.userId,
    hand,
    seats: seats.map(({ seat, name }) => ({
      playerId: seat.playerId,
      name,
      // Durante una mano, el stack real de quien juega está en el estado de la mano.
      stack: live?.players.find(p => p.id === seat.playerId)?.stack ?? seat.stack,
      status: seat.status,
      online: isPresent(seat, now),
      isYou: seat.playerId === myId,
      managed: managedIds.has(seat.playerId),
    })),
  };
}

// ─── Reparto ─────────────────────────────────────────────────────────────────

/** Siguiente botón: el próximo asiento (en orden) después del botón anterior que participe de la mano. */
function pickButton(order: string[], eligible: string[], prevButton: string | null): number {
  const start = prevButton ? order.indexOf(prevButton) : -1;
  for (let k = 1; k <= order.length; k++) {
    const id = order[(start + k + order.length) % order.length];
    const idx = eligible.indexOf(id);
    if (idx >= 0) return idx;
  }
  return 0;
}

async function dealHand(tx: Tx, table: TableRow): Promise<void> {
  const seats = (await loadSeats(tx, table.id)).map(s => s.seat);
  const eligible = seats.filter(s => s.status === 'sitting' && s.stack > 0);
  if (eligible.length < 2) throw new ApiError(422, 'not_enough_players', 'Hacen falta al menos 2 jugadores con fichas.');
  const prev = await latestHand(tx, table.id);
  const prevState = prev?.state as HandState | undefined;
  const prevButton = prevState ? prevState.players[prevState.button]?.id ?? null : null;
  const button = pickButton(seats.map(s => s.playerId), eligible.map(s => s.playerId), prevButton);

  const state = startHand(eligible.map(s => ({ id: s.playerId, stack: s.stack })), {
    button, smallBlind: table.smallBlind, bigBlind: table.bigBlind, randomInt,
  });
  const handNo = table.handCount + 1;
  const [row] = await tx.insert(schema.pokerHands).values({ tableId: table.id, handNo, state }).returning();
  await tx.update(schema.pokerTables)
    .set({ handCount: handNo, button, version: bump, turnDeadline: deadlineFor(table, state) })
    .where(eq(schema.pokerTables.id, table.id));
  // Si todos quedaron all-in por las ciegas, la mano ya puede estar terminada.
  if (state.street === 'done') await finishHand(tx, row.id, state);
}

/** Cierra la mano: devuelve los stacks a los asientos y borra el mazo guardado. */
async function finishHand(tx: Tx, handId: number, state: HandState): Promise<void> {
  const [hand] = await tx.select({ tableId: schema.pokerHands.tableId }).from(schema.pokerHands)
    .where(eq(schema.pokerHands.id, handId));
  for (const p of state.players) {
    await tx.update(schema.pokerSeats).set({ stack: p.stack })
      .where(and(eq(schema.pokerSeats.tableId, hand.tableId), eq(schema.pokerSeats.playerId, p.id)));
  }
  await tx.update(schema.pokerHands)
    .set({ status: 'done', finishedAt: new Date(), state: { ...state, deck: [] } })
    .where(eq(schema.pokerHands.id, handId));
}

const bump = sql`${schema.pokerTables.version} + 1`;

/**
 * El asiento guarda el usuario del jugador al sentarse. Si después se vincula o desvincula un usuario
 * (elige su nick, lo asocia un administrador o abandona el grupo), se copia al asiento: así deja de
 * manejarlo un administrador, o pasa a manejarlo. Devuelve la versión nueva de la mesa si cambió algo.
 */
async function syncSeatUsers(tx: Tx, groupId: string): Promise<number | null> {
  const changed = await tx.update(schema.pokerSeats).set({ userId: sql`${schema.players.userId}` })
    .from(schema.players)
    .where(and(
      eq(schema.pokerSeats.groupId, groupId),
      eq(schema.players.groupId, schema.pokerSeats.groupId),
      eq(schema.players.id, schema.pokerSeats.playerId),
      sql`${schema.pokerSeats.userId} is distinct from ${schema.players.userId}`,
    ))
    .returning({ tableId: schema.pokerSeats.tableId });
  if (changed.length === 0) return null;
  const [table] = await tx.update(schema.pokerTables).set({ version: bump })
    .where(eq(schema.pokerTables.id, changed[0].tableId)).returning({ version: schema.pokerTables.version });
  return table.version;
}

/** Transacción que cambia a qué usuario pertenece un jugador; al confirmarse actualiza la mesa y avisa. */
export async function relinkPlayers<T>(app: FastifyInstance, groupId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { result, version } = await app.db.transaction(async tx => {
    const result = await fn(tx);
    return { result, version: await syncSeatUsers(tx, groupId) };
  });
  if (version !== null) app.tableHub.notify(groupId, version);
  return result;
}

/** Vencimiento del turno que sigue, o null si no hay turno o la mesa no tiene límite. */
function deadlineFor(table: Pick<TableRow, 'turnSeconds'>, state: HandState): Date | null {
  if (state.street === 'done' || state.toAct < 0 || table.turnSeconds <= 0) return null;
  return new Date(Date.now() + table.turnSeconds * 1000);
}

async function activeHand(tx: Conn, tableId: string): Promise<HandRow | null> {
  const row = await latestHand(tx, tableId);
  return row?.status === 'active' ? row : null;
}


/**
 * Aplica una jugada (de la persona o del temporizador), la registra, cierra la mano si
 * corresponde y arma el vencimiento del próximo turno. Corre con la mesa bloqueada.
 */
async function playAction(tx: Tx, table: TableRow, hand: HandRow, playerId: string, action: Action, auto: boolean): Promise<void> {
  const state = hand.state as HandState;
  const before = legalActions(state);
  const logged: LoggedAction = action.type === 'call' && before ? { type: 'call', amount: before.callAmount }
    : action.type === 'raise' ? { type: 'raise', to: action.to, amount: action.to }
      : action.type === 'allin' && before ? { type: 'allin', amount: before.canRaise ? before.maxRaiseTo : before.callAmount }
        : action;
  let next: HandState;
  try {
    next = applyAction(state, playerId, action);
  } catch (e) {
    if (e instanceof HoldemError) throw new ApiError(422, 'illegal_action', e.message);
    throw e;
  }
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.pokerActions)
    .where(eq(schema.pokerActions.handId, hand.id));
  await tx.insert(schema.pokerActions).values({
    handId: hand.id, seq: n + 1, playerId, action: auto ? { ...logged, auto: true } : logged,
  });
  await tx.update(schema.pokerHands).set({ state: next }).where(eq(schema.pokerHands.id, hand.id));
  if (next.street === 'done') await finishHand(tx, hand.id, next);

  const seat = and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId));
  if (auto) {
    // Dos turnos seguidos sin responder: se lo saca de las próximas manos (vuelve con "Volver a sentarme").
    await tx.update(schema.pokerSeats)
      .set({ timeouts: sql`${schema.pokerSeats.timeouts} + 1`, status: sql`case when ${schema.pokerSeats.timeouts} + 1 >= 2 then 'out' else ${schema.pokerSeats.status} end` })
      .where(seat);
  } else {
    await tx.update(schema.pokerSeats).set({ timeouts: 0 }).where(seat);
  }
  await tx.update(schema.pokerTables).set({ version: bump, turnDeadline: deadlineFor(table, next) })
    .where(eq(schema.pokerTables.id, table.id));
}

/**
 * Juega por quien se quedó sin tiempo: pasa si puede y, si no, se retira. Lo corre un
 * temporizador del servidor; como lee los vencimientos de la base, sobrevive a reinicios.
 * Devuelve los grupos cuya mesa cambió.
 */
export async function sweepTurns(app: FastifyInstance): Promise<string[]> {
  const due = await app.db.select({ id: schema.pokerTables.id }).from(schema.pokerTables).where(and(
    eq(schema.pokerTables.status, 'playing'), gt(schema.pokerTables.turnSeconds, 0), isNotNull(schema.pokerTables.turnDeadline), lte(schema.pokerTables.turnDeadline, new Date()),
  ));
  const changed: string[] = [];
  for (const { id } of due) {
    const done = await app.db.transaction(async tx => {
      const [table] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, id)).for('update', { skipLocked: true });
      // Otro proceso la tomó, o el jugador actuó justo antes: no hay nada que vencer.
      if (!table?.turnDeadline || table.turnSeconds <= 0 || table.turnDeadline.getTime() > Date.now()) return null;
      const hand = await activeHand(tx, table.id);
      const state = hand?.state as HandState | undefined;
      const legal = state ? legalActions(state) : null;
      if (!hand || !state || !legal) {
        await tx.update(schema.pokerTables).set({ turnDeadline: null }).where(eq(schema.pokerTables.id, table.id));
        return null;
      }
      await playAction(tx, table, hand, legal.playerId, legal.canCheck ? { type: 'check' } : { type: 'fold' }, true);
      const [fresh] = await tx.select({ version: schema.pokerTables.version }).from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return { groupId: table.groupId, version: fresh.version };
    });
    if (done) {
      changed.push(done.groupId);
      app.tableHub.notify(done.groupId, done.version);
    }
  }
  return changed;
}

/** Jugador existente y activo del grupo, con su usuario (si tiene). */
async function usablePlayer(tx: Tx, groupId: string, playerId: string) {
  const [p] = await tx.select({ id: schema.players.id, userId: schema.players.userId, archivedAt: schema.players.archivedAt })
    .from(schema.players).where(and(eq(schema.players.groupId, groupId), eq(schema.players.id, playerId)));
  if (!p) throw notFound('Jugador');
  if (p.archivedAt) throw new ApiError(409, 'player_archived', 'El jugador está archivado.');
  return p;
}

/**
 * Sienta a un jugador. Sin partida en curso solo ocupa un lugar; con la partida en curso entra con
 * una nueva compra de entrada (juega desde la próxima mano). `by` es el administrador que lo sienta
 * a mano (null si se sienta solo). Devuelve 'quiet' si no cambió nada visible (latido de presencia).
 */
async function sitPlayer(
  tx: Tx, table: TableRow, p: { id: string; userId: string | null }, by: string | null,
): Promise<void | 'quiet'> {
  const key = and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, p.id));
  const [seat] = await tx.select().from(schema.pokerSeats).where(key);
  if (seat) {
    // Volver tras estar afuera (levantado o sacado por inactividad) reinicia el contador.
    await tx.update(schema.pokerSeats)
      .set({ status: 'sitting', lastSeenAt: new Date(), ...(seat.status === 'out' ? { timeouts: 0 } : {}) })
      .where(key);
    return seat.status === 'sitting' ? 'quiet' : undefined;
  }
  let stack = 0;
  if (table.status === 'playing') {
    stack = table.buyIn;
    const [participant] = await tx.insert(schema.sessionParticipants)
      .values({ groupId: table.groupId, sessionId: table.sessionId as string, playerId: p.id }).onConflictDoNothing()
      .returning({ id: schema.sessionParticipants.id });
    if (participant) await tx.insert(schema.buys).values({ participantId: participant.id, amount: table.buyIn, occurredAt: new Date() });
  }
  await tx.insert(schema.pokerSeats).values({
    tableId: table.id, groupId: table.groupId, playerId: p.id, userId: p.userId, addedBy: by, stack,
  });
}

/** Levanta a un jugador: sin partida se libera el lugar; con partida sus fichas quedan en la mesa. */
async function standPlayer(tx: Tx, table: TableRow, playerId: string): Promise<void> {
  const key = and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId));
  const [seat] = await tx.select().from(schema.pokerSeats).where(key);
  if (!seat) return;
  if (table.status === 'waiting') {
    await tx.delete(schema.pokerSeats).where(key);
    return;
  }
  const hand = await activeHand(tx, table.id);
  const inHand = (hand?.state as HandState | undefined)?.players.find(p => p.id === playerId);
  if (inHand && !inHand.folded) throw new ApiError(409, 'in_hand', 'No se puede levantar a un jugador en medio de una mano.');
  await tx.update(schema.pokerSeats).set({ status: 'out' }).where(key);
}

/**
 * Recompra: solo sin fichas, y entre manos o tras haberse retirado de la que está en juego. Suma una
 * compra a la partida por `amount` fichas (hasta maxRebuy; por defecto la entrada o el tope si es menor).
 */
async function rebuyPlayer(tx: Tx, table: TableRow, playerId: string, amount?: number): Promise<void> {
  if (table.status !== 'playing') throw new ApiError(409, 'not_playing', 'No hay una partida en juego.');
  const seats = (await loadSeats(tx, table.id)).map(s => s.seat);
  const seat = seats.find(s => s.playerId === playerId);
  if (!seat) throw notFound('Asiento');
  const hand = await activeHand(tx, table.id);
  const state = hand?.state as HandState | undefined;
  const inHand = state?.players.find(p => p.id === playerId);
  if (inHand && !inHand.folded) throw new ApiError(409, 'in_hand', 'Esperá a que termine la mano.');
  if ((inHand ? inHand.stack : seat.stack) > 0) throw new ApiError(409, 'has_chips', 'Solo se puede recomprar sin fichas.');
  const max = maxRebuy(seats, state);
  if (max < 1) throw new ApiError(422, 'rebuy_unavailable', 'No hay fichas suficientes en la mesa para recomprar.');
  const chips = amount ?? Math.min(table.buyIn, max);
  if (chips > max) throw new ApiError(422, 'rebuy_too_high', `Podés recomprar hasta ${max} fichas (la mitad de quien más tiene).`);
  const [participant] = await tx.select({ id: schema.sessionParticipants.id }).from(schema.sessionParticipants)
    .where(and(eq(schema.sessionParticipants.sessionId, table.sessionId as string), eq(schema.sessionParticipants.playerId, playerId)));
  await tx.insert(schema.buys).values({ participantId: participant.id, amount: chips, occurredAt: new Date() });
  await tx.update(schema.pokerSeats).set({ stack: chips, status: 'sitting' })
    .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId)));
  if (hand && state && inHand) {
    // Retirado de la mano en juego: las fichas nuevas viajan en el estado, que se vuelca a la mesa al terminar.
    inHand.stack = chips;
    await tx.update(schema.pokerHands).set({ state }).where(eq(schema.pokerHands.id, hand.id));
  }
  await tx.update(schema.pokerTables).set({ version: bump }).where(eq(schema.pokerTables.id, table.id));
}

/** Muestra cartas de la última mano, ya terminada (con otra en juego ya no se puede). */
async function revealPlayer(tx: Tx, table: TableRow, playerId: string, cards?: number[]): Promise<void> {
  const row = await latestHand(tx, table.id);
  if (!row || row.status !== 'done') throw new ApiError(409, 'hand_in_progress', 'Podés mostrar tus cartas cuando termine la mano.');
  let next: HandState;
  try {
    next = revealCards(row.state as HandState, playerId, cards);
  } catch (e) {
    if (e instanceof HoldemError) throw new ApiError(422, 'illegal_reveal', e.message);
    throw e;
  }
  await tx.update(schema.pokerHands).set({ state: next }).where(eq(schema.pokerHands.id, row.id));
  await tx.update(schema.pokerTables).set({ version: bump }).where(eq(schema.pokerTables.id, table.id));
}

/** Jugador al que un administrador puede mover: sentado y sin usuario (nadie más puede jugar por él). */
async function managedPlayerId(tx: Tx, req: { role: Role }, table: TableRow, playerId: string): Promise<string> {
  if (!isEditor(req.role)) throw new ApiError(403, 'read_only', 'Solo un administrador puede jugar por otro jugador.');
  const [seat] = await tx.select().from(schema.pokerSeats)
    .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId)));
  if (!seat) throw notFound('Asiento');
  if (seat.userId !== null) throw new ApiError(403, 'not_managed', 'Ese jugador tiene usuario: juega él mismo.');
  return playerId;
}

// ─── Rutas ───────────────────────────────────────────────────────────────────

export async function tableRoutes(app: FastifyInstance) {
  const tags = ['table'];
  const err = { '4xx': ErrorResponse };
  const base = { tags, params: GroupParams };

  /** Corre fn con la mesa bloqueada y devuelve la vista resultante. */
  const mutate = async (
    req: { group: { id: string }; user: { sub: string }; role: Role },
    fn: (tx: Tx, table: TableRow) => Promise<void | 'quiet'>,
  ) => {
    let quiet = false;
    const view = await app.db.transaction(async tx => {
      const table = await ensureTable(tx, req.group.id, true);
      quiet = (await fn(tx, table)) === 'quiet';
      const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return buildView(tx, fresh, viewerOf(req));
    });
    // Después del commit, para que quien refresque ya vea el cambio. El latido de presencia no avisa.
    if (!quiet) app.tableHub.notify(req.group.id, view.version);
    return view;
  };

  /** Igual que mutate, para las rutas con Idempotency-Key (el aviso sale al confirmarse). */
  const announce = <T extends { version: number } | { table: { version: number } }>(groupId: string, result: T): T => {
    app.tableHub.notify(groupId, 'table' in result ? result.table.version : result.version);
    return result;
  };

  app.get<G>('/table', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => buildView(app.db, await ensureTable(app.db, req.group.id, false), viewerOf(req)));

  // Sentarse (y heartbeat de presencia: la web lo repite cada ~20 s).
  app.post<G>('/table/join', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    const playerId = await requirePlayer(tx, req.group.id, req.user.sub);
    await hostBeat(tx, table, req.user.sub);
    return sitPlayer(tx, table, { id: playerId, userId: req.user.sub }, null);
  }));

  // Latido de quien inició la partida aunque no esté sentado (p. ej. un administrador que solo reparte).
  app.post<G>('/table/ping', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    await hostBeat(tx, table, req.user.sub);
    return 'quiet';
  }));

  app.post<G>('/table/leave', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    await standPlayer(tx, table, await requirePlayer(tx, req.group.id, req.user.sub));
  }));

  // Administración manual: sentar, levantar y recomprar a cualquier jugador del grupo.
  type S = { Params: Static<typeof SeatParams> };
  const seatRoute = { tags, params: SeatParams, response: { 200: TableView, ...err } };

  app.post<S>('/table/seats/:playerId', { schema: seatRoute }, async req => {
    await requireEditor(req);
    return mutate(req, async (tx, table) => {
      const player = await usablePlayer(tx, req.group.id, req.params.playerId);
      return sitPlayer(tx, table, player, req.user.sub);
    });
  });

  app.delete<S>('/table/seats/:playerId', { schema: seatRoute }, async req => {
    await requireEditor(req);
    return mutate(req, async (tx, table) => standPlayer(tx, table, req.params.playerId));
  });

  app.post<S & { Body: Static<typeof RebuyBody> }>('/table/seats/:playerId/rebuy', {
    schema: { ...seatRoute, body: RebuyBody },
  }, async req => {
    await requireEditor(req);
    const groupId = req.group.id;
    return announce(groupId, await idempotent(req, async tx => {
      const table = await ensureTable(tx, groupId, true);
      await rebuyPlayer(tx, table, req.params.playerId, req.body.amount);
      const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return buildView(tx, fresh, viewerOf(req));
    }));
  });

  // Iniciar partida: crea una Session normal con los presentes y reparte la primera mano.
  app.post<G & { Body: Static<typeof StartTableBody> }>('/table/start', {
    schema: { ...base, body: StartTableBody, response: { 200: TableView, ...err } },
  }, async req => {
    const groupId = req.group.id;
    return announce(groupId, await idempotent(req, async tx => {
      const table = await ensureTable(tx, groupId, true);
      if (table.status !== 'waiting') throw new ApiError(409, 'already_playing', 'Ya hay una partida en juego.');
      // Un administrador puede iniciar sin estar sentado (ni tener jugador).
      const playerId = isEditor(req.role) ? null : await requirePlayer(tx, groupId, req.user.sub);
      const cfg = {
        smallBlind: req.body.smallBlind ?? table.smallBlind,
        bigBlind: req.body.bigBlind ?? table.bigBlind,
        buyIn: req.body.buyIn ?? table.buyIn,
        turnSeconds: req.body.turnSeconds ?? table.turnSeconds,
      };
      if (cfg.turnSeconds !== 0 && cfg.turnSeconds < 10) {
        throw new ApiError(422, 'invalid_turn_time', 'El tiempo por turno es 0 (sin límite) o entre 10 y 300 segundos.');
      }
      if (cfg.smallBlind > cfg.bigBlind) throw new ApiError(422, 'invalid_blinds', 'La ciega chica no puede superar a la grande.');
      if (cfg.buyIn < cfg.bigBlind * 2) throw new ApiError(422, 'invalid_buy_in', 'La entrada debe ser al menos el doble de la ciega grande.');

      const seats = (await loadSeats(tx, table.id)).map(s => s.seat);
      const present = seats.filter(s => isPresent(s));
      if (playerId && !present.some(s => s.playerId === playerId)) throw new ApiError(409, 'not_seated', 'Sentate en la mesa para iniciar la partida.');
      if (present.length < 2) throw new ApiError(422, 'not_enough_players', 'Hacen falta al menos 2 jugadores conectados.');

      const [season] = await tx.select({ id: schema.seasons.id }).from(schema.seasons)
        .where(and(eq(schema.seasons.groupId, groupId), eq(schema.seasons.status, 'active')));
      if (!season) throw new ApiError(409, 'no_active_season', 'No hay una temporada activa en el grupo.');
      const archived = await tx.select({ id: schema.players.id }).from(schema.players)
        .where(and(eq(schema.players.groupId, groupId), sql`${schema.players.archivedAt} is not null`));
      if (present.some(s => archived.some(a => a.id === s.playerId))) {
        throw new ApiError(409, 'player_archived', 'Hay un jugador archivado en la mesa.');
      }

      const sessionId = randomUUID();
      const now = new Date();
      await tx.insert(schema.sessions).values({
        id: sessionId, groupId, seasonId: season.id, name: `Mesa online · ${defaultSessionName(now, req.group.timezone)}`,
        status: 'active', createdAt: now,
      });
      for (const seat of present) {
        const [participant] = await tx.insert(schema.sessionParticipants)
          .values({ groupId, sessionId, playerId: seat.playerId }).returning({ id: schema.sessionParticipants.id });
        await tx.insert(schema.buys).values({ participantId: participant.id, amount: cfg.buyIn, occurredAt: now });
      }
      // Los que no están conectados quedan afuera de esta partida.
      for (const seat of seats.filter(s => !present.includes(s))) {
        await tx.delete(schema.pokerSeats)
          .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, seat.playerId)));
      }
      await tx.update(schema.pokerSeats).set({ stack: cfg.buyIn, status: 'sitting' }).where(eq(schema.pokerSeats.tableId, table.id));
      await tx.update(schema.pokerTables).set({ ...cfg, status: 'playing', sessionId, startedBy: req.user.sub, hostSeenAt: now, version: bump })
        .where(eq(schema.pokerTables.id, table.id));
      const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      await dealHand(tx, fresh);
      const [after] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return buildView(tx, after, viewerOf(req));
    }));
  });

  app.post<G>('/table/deal', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    if (table.status !== 'playing') throw new ApiError(409, 'not_playing', 'No hay una partida en juego.');
    const viewer = viewerOf(req);
    const me = viewer.canManage ? null : await requirePlayer(tx, req.group.id, req.user.sub);
    if (!mayHost(table, (await loadSeats(tx, table.id)).map(s => s.seat), viewer, me)) {
      throw new ApiError(403, 'not_host', 'Reparte quien inició la partida o un administrador.');
    }
    if (await activeHand(tx, table.id)) throw new ApiError(409, 'hand_in_progress', 'Hay una mano en juego.');
    await dealHand(tx, table);
  }));

  app.post<G & { Body: Static<typeof TableActionBody> }>('/table/action', {
    schema: { ...base, body: TableActionBody, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    // Un administrador puede jugar por un jugador sin usuario; el resto, solo por sí mismo.
    const playerId = req.body.playerId
      ? await managedPlayerId(tx, req, table, req.body.playerId)
      : await requirePlayer(tx, req.group.id, req.user.sub);
    if (req.body.version !== table.version) {
      throw new ApiError(409, 'stale_state', 'La mesa cambió. Actualizá y volvé a intentar.');
    }
    const hand = await activeHand(tx, table.id);
    if (!hand) throw new ApiError(409, 'no_hand', 'No hay una mano en juego.');
    await playAction(tx, table, hand, playerId, req.body.action, false);
  }));

  // Mostrar cartas: al terminar la mano; una sola carta, solo el único jugador que queda.
  app.post<G & { Body: Static<typeof RevealBody> }>('/table/reveal', {
    schema: { ...base, body: RevealBody, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    const playerId = req.body.playerId
      ? await managedPlayerId(tx, req, table, req.body.playerId)
      : await requirePlayer(tx, req.group.id, req.user.sub);
    await revealPlayer(tx, table, playerId, req.body.cards);
  }));

  // Recompra: solo con 0 fichas, entre manos o tras retirarse. Suma una compra a la partida.
  app.post<G & { Body: Static<typeof RebuyBody> }>('/table/rebuy', {
    schema: { ...base, body: RebuyBody, response: { 200: TableView, ...err } },
  }, async req => {
    const groupId = req.group.id;
    return announce(groupId, await idempotent(req, async tx => {
      const table = await ensureTable(tx, groupId, true);
      await rebuyPlayer(tx, table, await requirePlayer(tx, groupId, req.user.sub), req.body.amount);
      const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return buildView(tx, fresh, viewerOf(req));
    }));
  });

  // Cerrar: los stacks pasan a ser los resultados finales y se cierra la Session (deudas y ranking).
  app.post<G>('/table/close', {
    schema: { ...base, response: { 200: CloseTableResponse, ...err } },
  }, async req => {
    const groupId = req.group.id;
    return announce(groupId, await idempotent(req, async tx => {
      const table = await ensureTable(tx, groupId, true);
      if (table.status !== 'playing') throw new ApiError(409, 'not_playing', 'No hay una partida en juego.');
      const seats = (await loadSeats(tx, table.id)).map(s => s.seat);
      // Cierra quien inició la partida o un administrador (aunque no esté sentado).
      const viewer = viewerOf(req);
      const me = viewer.canManage ? null : await requirePlayer(tx, groupId, req.user.sub);
      if (!mayHost(table, seats, viewer, me)) {
        throw new ApiError(403, 'not_host', 'Cierra la partida quien la inició o un administrador.');
      }
      if (await activeHand(tx, table.id)) throw new ApiError(409, 'hand_in_progress', 'Esperá a que termine la mano.');
      const sessionId = table.sessionId as string;
      for (const seat of seats) {
        await tx.update(schema.sessionParticipants).set({ finalAmount: seat.stack })
          .where(and(eq(schema.sessionParticipants.sessionId, sessionId), eq(schema.sessionParticipants.playerId, seat.playerId)));
      }
      await closeSessionTx(tx, groupId, sessionId);
      await tx.delete(schema.pokerSeats).where(eq(schema.pokerSeats.tableId, table.id));
      await tx.update(schema.pokerTables).set({ status: 'waiting', sessionId: null, startedBy: null, hostSeenAt: null, version: bump })
        .where(eq(schema.pokerTables.id, table.id));
      const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return { sessionId, table: await buildView(tx, fresh, viewerOf(req)) };
    }));
  });
}
