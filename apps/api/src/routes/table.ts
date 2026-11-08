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
  HoldemError, applyAction, blindLevel, buyInHand, describeAction, legalActions, publicView, revealCards, shownCards, startHand, winDetails, type Action, type HandState,
} from '@pokercontrol/core';
import { type Static } from '@sinclair/typebox';
import { and, asc, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import type { LoggedAction } from '../db/schema';
import { ApiError, notFound } from '../errors';
import { recordBoughtInHand, recordHandResult, recordHandStart } from '../hand-history';
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

/** Ciegas que corresponden ahora: las base, duplicadas según el tiempo que lleva la partida. */
function currentBlinds(table: TableRow, now = Date.now()) {
  return blindLevel({
    smallBlind: table.smallBlind, bigBlind: table.bigBlind, buyIn: table.buyIn, minutes: table.blindMinutes,
    elapsedMs: table.status === 'playing' && table.blindsStartedAt ? now - table.blindsStartedAt.getTime() : 0,
  });
}

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
  const blinds = currentBlinds(table, now);
  // Jugadores sin usuario que este administrador maneja: ve sus cartas y juega sus turnos.
  const managedIds = new Set(viewer.canManage ? seats.filter(({ seat }) => seat.userId === null).map(({ seat }) => seat.playerId) : []);
  const [last] = row
    ? await db.select().from(schema.pokerActions).where(eq(schema.pokerActions.handId, row.id))
      .orderBy(desc(schema.pokerActions.seq)).limit(1)
    : [];

  // Lo comprado por cada uno en esta partida: la primera compra es la entrada; las demás, recompras.
  const purchases = new Map<string, { count: number; total: number }>();
  if (table.sessionId) {
    const rows = await db.select({ playerId: schema.sessionParticipants.playerId, amount: schema.buys.amount }).from(schema.buys)
      .innerJoin(schema.sessionParticipants, eq(schema.sessionParticipants.id, schema.buys.participantId))
      .where(eq(schema.sessionParticipants.sessionId, table.sessionId));
    for (const r of rows) {
      const cur = purchases.get(r.playerId) ?? { count: 0, total: 0 };
      purchases.set(r.playerId, { count: cur.count + 1, total: cur.total + r.amount });
    }
  }

  let hand: ApiTableView['hand'] = null;
  if (row && state) {
    const v = publicView(state, [...(myId ? [myId] : []), ...managedIds]);
    const actor = live && state.toAct >= 0 ? state.players[state.toAct].id : null;
    const actingFor = actor && (actor === myId || managedIds.has(actor)) ? actor : null;
    const legal = actingFor ? legalActions(state) : null;
    const wins = winDetails(state);
    hand = {
      handNo: row.handNo,
      gameHandNo: row.handNo - table.sessionHandBase,
      street: v.street,
      board: v.board,
      pot: v.players.reduce((sum, p) => sum + p.totalBet, 0),
      currentBet: v.currentBet,
      minRaise: v.minRaise,
      button: v.button,
      toActPlayerId: v.toAct >= 0 ? v.players[v.toAct].id : null,
      players: v.players.map(p => ({
        playerId: p.id, stack: p.stack, bet: p.bet, totalBet: p.totalBet, folded: p.folded, allIn: p.allIn, hole: p.hole,
        shown: shownCards(state, p.id), pending: !!p.pending,
      })),
      actingPlayerId: legal ? actingFor : null,
      legal: legal
        ? {
          toCall: legal.toCall, canCheck: legal.canCheck, canCall: legal.canCall, callAmount: legal.callAmount,
          canRaise: legal.canRaise, minRaiseTo: legal.minRaiseTo, maxRaiseTo: legal.maxRaiseTo, mustBuy: legal.mustBuy,
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
    // Las de la mano en curso; sin mano, las que se usarán en la próxima.
    smallBlind: live?.smallBlind ?? blinds.small,
    bigBlind: live?.bigBlind ?? blinds.big,
    buyIn: table.buyIn,
    blinds: {
      minutes: table.blindMinutes, level: blinds.level, small: blinds.small, big: blinds.big, atCap: blinds.atCap,
      nextAt: table.status === 'playing' && table.blindsStartedAt && blinds.nextAtMs !== null
        ? new Date(table.blindsStartedAt.getTime() + blinds.nextAtMs).toISOString() : null,
    },
    version: table.version,
    turnSeconds: table.turnSeconds,
    showAllCards: table.showAllCards,
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
      rebuys: Math.max(0, (purchases.get(seat.playerId)?.count ?? 0) - 1),
      bought: purchases.get(seat.playerId)?.total ?? 0,
      // Con las fichas de la mesa (sin contar lo que está en juego en la mano) menos lo comprado.
      net: purchases.has(seat.playerId) ? seat.stack - (purchases.get(seat.playerId)?.total ?? 0) : 0,
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
  const funded = seats.filter(s => s.status === 'sitting' && s.stack > 0);
  if (funded.length < 2) throw new ApiError(422, 'not_enough_players', 'Hacen falta al menos 2 jugadores con fichas.');
  // Sentados, conectados y sin fichas: se les reparte igual, pero no ven sus cartas ni juegan hasta recomprar.
  const pending = seats.filter(s => s.status === 'sitting' && s.stack === 0 && isPresent(s));
  const inHand = seats.filter(s => funded.includes(s) || pending.includes(s));
  const prev = await latestHand(tx, table.id);
  const prevState = prev?.state as HandState | undefined;
  const prevButton = prevState ? prevState.players[prevState.button]?.id ?? null : null;
  const fundedIds = funded.map(s => s.playerId);
  // El botón rota solo entre quienes tienen fichas; el índice es el del orden de la mano.
  const buttonId = fundedIds[pickButton(seats.map(s => s.playerId), fundedIds, prevButton)];
  const button = inHand.findIndex(s => s.playerId === buttonId);

  const blinds = currentBlinds(table);
  const state = startHand(inHand.map(s => ({ id: s.playerId, stack: s.stack, ...(pending.includes(s) ? { pending: true } : {}) })), {
    // Las ciegas se fijan al repartir: no cambian en medio de la mano.
    button, smallBlind: blinds.small, bigBlind: blinds.big, randomInt,
  });
  const handNo = table.handCount + 1;
  const [row] = await tx.insert(schema.pokerHands).values({
    tableId: table.id, handNo, state, sessionId: table.sessionId, smallBlind: state.smallBlind, bigBlind: state.bigBlind,
  }).returning();
  await recordHandStart(tx, table.groupId, row.id, state);
  await tx.update(schema.pokerTables)
    .set({ handCount: handNo, button, version: bump, turnDeadline: await armDeadline(tx, table, state) })
    .where(eq(schema.pokerTables.id, table.id));
  // Si todos quedaron all-in por las ciegas, la mano ya puede estar terminada.
  if (state.street === 'done') await finishHand(tx, row.id, state);
}

/** Cierra la mano: devuelve los stacks a los asientos y borra el mazo guardado. */
async function finishHand(tx: Tx, handId: number, state: HandState): Promise<void> {
  const [hand] = await tx.select({ tableId: schema.pokerHands.tableId, groupId: schema.pokerTables.groupId, showAll: schema.pokerTables.showAllCards }).from(schema.pokerHands)
    .innerJoin(schema.pokerTables, eq(schema.pokerTables.id, schema.pokerHands.tableId))
    .where(eq(schema.pokerHands.id, handId));
  for (const p of state.players) {
    await tx.update(schema.pokerSeats).set({ stack: p.stack })
      .where(and(eq(schema.pokerSeats.tableId, hand.tableId), eq(schema.pokerSeats.playerId, p.id)));
  }
  // Con la opción de la mesa, al terminar la mano todos muestran sus cartas (también quienes se retiraron). Quien no
  // recompró (pendiente) no ve las suyas y tampoco las muestra.
  const revealed = hand.showAll
    ? Object.fromEntries(state.players.filter(p => !p.pending && p.hole.length === 2).map(p => [p.id, [0, 1]]))
    : state.revealed;
  await tx.update(schema.pokerHands)
    .set({
      status: 'done', finishedAt: new Date(), state: { ...state, deck: [], ...(revealed ? { revealed } : {}) },
      // Las cartas que habrían salido, para el análisis "y si no te retirabas" (solo se muestran con la partida cerrada).
      fullBoard: [...state.board, ...state.deck.slice(0, 5 - state.board.length)],
    })
    .where(eq(schema.pokerHands.id, handId));
  await recordHandResult(tx, hand.groupId, handId, state);
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

/**
 * Vencimiento del turno que sigue. Quien debe recomprar siempre tiene uno (aunque la mesa no tenga límite) y, si no
 * está conectado, vence ya: no hay a quién esperar.
 */
async function armDeadline(tx: Tx, table: TableRow, state: HandState): Promise<Date | null> {
  const actor = state.street !== 'done' && state.toAct >= 0 ? state.players[state.toAct] : null;
  // Quien se levantó de la mesa en medio de la mano se retira apenas le toca.
  if (actor) {
    const [out] = await tx.select({ s: schema.pokerSeats.status }).from(schema.pokerSeats)
      .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, actor.id)));
    if (out?.s === 'out') return new Date();
  }
  if (!actor?.pending) return deadlineFor(table, state);
  const [seat] = await tx.select().from(schema.pokerSeats)
    .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, actor.id)));
  if (!seat || !isPresent(seat)) return new Date();
  return new Date(Date.now() + (table.turnSeconds > 0 ? table.turnSeconds : 45) * 1000);
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
  // Quien no recompró no cuenta para la expulsión por turnos perdidos (se queda en la mesa).
  const wasPending = !!state.players.find(p => p.id === playerId)?.pending;
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
  // La situación en que se jugó, para analizar el juego después (calle, pozo, fichas, rivales).
  const spot = describeAction(state, action);
  const mine = state.players.findIndex(x => x.id === playerId);
  const wentAllIn = mine >= 0 && next.players[mine].allIn && !state.players[mine].allIn;
  // Cuánto tardó en decidir: desde que le tocó (el vencimiento menos el tiempo por turno), si la mesa tiene límite.
  const thinkMs = table.turnDeadline && table.turnSeconds > 0
    ? Math.max(0, Date.now() - (table.turnDeadline.getTime() - table.turnSeconds * 1000)) : null;
  await tx.insert(schema.pokerActions).values({
    handId: hand.id, seq: n + 1, playerId, action: auto ? { ...logged, auto: true } : logged,
    street: spot?.street, kind: spot?.kind, amount: spot?.amount, potBefore: spot?.potBefore, toCall: spot?.toCall,
    stackBefore: spot?.stackBefore, playersLeft: spot?.playersLeft, auto, allIn: wentAllIn, thinkMs,
  });
  await tx.update(schema.pokerHands).set({ state: next }).where(eq(schema.pokerHands.id, hand.id));
  if (next.street === 'done') await finishHand(tx, hand.id, next);

  const seat = and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId));
  if (auto && wasPending) {
    // Sin fichas y sin responder: se retira de la mano, pero sigue sentado.
  } else if (auto) {
    // Dos turnos seguidos sin responder: se lo saca de las próximas manos (vuelve con "Volver a sentarme").
    await tx.update(schema.pokerSeats)
      .set({ timeouts: sql`${schema.pokerSeats.timeouts} + 1`, status: sql`case when ${schema.pokerSeats.timeouts} + 1 >= 2 then 'out' else ${schema.pokerSeats.status} end` })
      .where(seat);
  } else {
    await tx.update(schema.pokerSeats).set({ timeouts: 0 }).where(seat);
  }
  await tx.update(schema.pokerTables).set({ version: bump, turnDeadline: await armDeadline(tx, table, next) })
    .where(eq(schema.pokerTables.id, table.id));
}

/**
 * Juega por quien se quedó sin tiempo: pasa si puede y, si no, se retira. Lo corre un
 * temporizador del servidor; como lee los vencimientos de la base, sobrevive a reinicios.
 * Devuelve los grupos cuya mesa cambió.
 */
export async function sweepTurns(app: FastifyInstance): Promise<string[]> {
  const due = await app.db.select({ id: schema.pokerTables.id }).from(schema.pokerTables).where(and(
    eq(schema.pokerTables.status, 'playing'), isNotNull(schema.pokerTables.turnDeadline), lte(schema.pokerTables.turnDeadline, new Date()),
  ));
  const changed: string[] = [];
  for (const { id } of due) {
    const done = await app.db.transaction(async tx => {
      const [table] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, id)).for('update', { skipLocked: true });
      // Otro proceso la tomó, o el jugador actuó justo antes: no hay nada que vencer.
      if (!table?.turnDeadline || table.turnDeadline.getTime() > Date.now()) return null;
      const hand = await activeHand(tx, table.id);
      const state = hand?.state as HandState | undefined;
      const legal = state ? legalActions(state) : null;
      if (!hand || !state || !legal) {
        await tx.update(schema.pokerTables).set({ turnDeadline: null }).where(eq(schema.pokerTables.id, table.id));
        return null;
      }
      const [actorSeat] = await tx.select({ s: schema.pokerSeats.status }).from(schema.pokerSeats)
        .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, legal.playerId)));
      const left = actorSeat?.s === 'out'; // se levantó en medio de la mano: se retira sin esperar
      // Sin límite de turno solo vencen los pendientes de recompra (que siempre tienen un tiempo para pagar).
      if (table.turnSeconds <= 0 && !legal.mustBuy && !left) return null;
      await playAction(tx, table, hand, legal.playerId, legal.canCheck && !left ? { type: 'check' } : { type: 'fold' }, true);
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
/**
 * Levanta a un jugador. En la sala de espera libera el asiento; con la partida en juego lo deja "afuera" (sus fichas
 * siguen en la mesa y cuentan al cerrar). Quien se levanta por su cuenta (`self`) puede hacerlo en medio de una mano:
 * se retira solo cuando le toca (enseguida, si ya le tocaba). Si con eso no queda ningún jugador real sentado, la
 * partida se cancela y no se registra (ver cancelGame). Un administrador no levanta a nadie en medio de una mano.
 */
async function standPlayer(tx: Tx, table: TableRow, playerId: string, self = false): Promise<void> {
  const key = and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId));
  const [seat] = await tx.select().from(schema.pokerSeats).where(key);
  if (!seat) return;
  if (table.status === 'waiting') {
    await tx.delete(schema.pokerSeats).where(key);
    return;
  }
  const hand = await activeHand(tx, table.id);
  const state = hand?.state as HandState | undefined;
  const inHand = state?.players.find(p => p.id === playerId);
  const playing = !!inHand && !inHand.folded;
  if (playing && !self) throw new ApiError(409, 'in_hand', 'No se puede levantar a un jugador en medio de una mano.');
  await tx.update(schema.pokerSeats).set({ status: 'out' }).where(key);
  // Le tocaba a él: se retira ya, sin esperar el tiempo del turno.
  if (playing && state && state.street !== 'done' && state.players[state.toAct]?.id === playerId) {
    await tx.update(schema.pokerTables).set({ turnDeadline: new Date() }).where(eq(schema.pokerTables.id, table.id));
  }
  // Se fue una persona (no un jugador manejado por un administrador): ¿queda alguna?
  if (seat.userId !== null) {
    const seats = (await loadSeats(tx, table.id)).map(x => x.seat);
    if (!seats.some(x => x.userId !== null && x.status === 'sitting')) await cancelGame(tx, table);
  }
}

/**
 * Cancela la partida en juego porque no quedó ningún jugador real: se borra la partida con sus participantes, compras y
 * manos, así que no suma a saldos, ranking ni historial. La mesa vuelve a la sala de espera.
 */
async function cancelGame(tx: Tx, table: TableRow): Promise<void> {
  const sessionId = table.sessionId as string;
  await tx.delete(schema.pokerHands).where(and(eq(schema.pokerHands.tableId, table.id), eq(schema.pokerHands.sessionId, sessionId)));
  await tx.delete(schema.pokerSeats).where(eq(schema.pokerSeats.tableId, table.id));
  await tx.update(schema.pokerTables)
    .set({ status: 'waiting', sessionId: null, startedBy: null, hostSeenAt: null, turnDeadline: null, version: bump })
    .where(eq(schema.pokerTables.id, table.id));
  await tx.delete(schema.sessions).where(and(eq(schema.sessions.groupId, table.groupId), eq(schema.sessions.id, sessionId)));
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
  // Quien debe recomprar (pendiente) puede hacerlo con la mano en juego: ve sus cartas y juega.
  if (inHand && !inHand.folded && !inHand.pending) throw new ApiError(409, 'in_hand', 'Esperá a que termine la mano.');
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
    // Las fichas nuevas viajan en el estado de la mano, que se vuelca a la mesa al terminar. Si estaba pendiente
    // (sin retirarse) pasa a jugar y ve sus cartas; si ya se había retirado, juega la próxima.
    let next = state;
    if (inHand.pending && !inHand.folded) {
      next = buyInHand(state, playerId, chips);
      await recordBoughtInHand(tx, hand.id, playerId, chips);
    } else {
      inHand.stack = chips;
    }
    await tx.update(schema.pokerHands).set({ state: next }).where(eq(schema.pokerHands.id, hand.id));
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
    await standPlayer(tx, table, await requirePlayer(tx, req.group.id, req.user.sub), true);
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
        blindMinutes: req.body.blindMinutes ?? table.blindMinutes,
        showAllCards: req.body.showAllCards ?? table.showAllCards,
      };
      if (cfg.blindMinutes !== 0 && cfg.blindMinutes < 5) {
        throw new ApiError(422, 'invalid_blind_time', 'Las ciegas se duplican cada 0 (nunca) o entre 5 y 120 minutos.');
      }
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
      await tx.update(schema.pokerTables).set({ ...cfg, status: 'playing', sessionId, sessionHandBase: table.handCount, startedBy: req.user.sub, hostSeenAt: now, blindsStartedAt: now, version: bump })
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
