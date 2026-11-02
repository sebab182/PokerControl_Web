/**
 * Mesa online de Texas Hold'em: una por grupo. Cualquier miembro con jugador puede sentarse,
 * iniciar la partida (se crea una Session normal) y jugar. Al cerrar, los stacks son los
 * resultados finales y se reutiliza el cierre de partidas (deudas y ranking).
 *
 * Servidor autoritativo: el mazo y las cartas ajenas nunca salen de acá (ver publicView).
 */

import { randomInt, randomUUID } from 'node:crypto';
import {
  CloseTableResponse, ErrorResponse, GroupParams, StartTableBody, TableActionBody, TableView,
  type ApiTableView,
} from '@pokercontrol/contracts';
import { HoldemError, applyAction, legalActions, publicView, startHand, type HandState } from '@pokercontrol/core';
import { type Static } from '@sinclair/typebox';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError, notFound } from '../errors';
import { idempotent } from '../idempotency';
import type { Conn, Tx } from '../repo';
import { closeSessionTx, defaultSessionName } from './sessions';

const ONLINE_MS = 45_000;

type TableRow = typeof schema.pokerTables.$inferSelect;
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

async function buildView(db: Conn, table: TableRow, userId: string): Promise<ApiTableView> {
  const me = await myPlayer(db, table.groupId, userId);
  const myId = me?.id ?? null;
  const seats = await loadSeats(db, table.id);
  const row = await latestHand(db, table.id);
  const state = row?.state as HandState | undefined;
  const live = row?.status === 'active' ? state : undefined;
  const now = Date.now();

  let hand: ApiTableView['hand'] = null;
  if (row && state) {
    const v = publicView(state, myId);
    const legal = myId && live ? legalActions(state) : null;
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
      })),
      legal: legal && legal.playerId === myId
        ? {
          toCall: legal.toCall, canCheck: legal.canCheck, canCall: legal.canCall, callAmount: legal.callAmount,
          canRaise: legal.canRaise, minRaiseTo: legal.minRaiseTo, maxRaiseTo: legal.maxRaiseTo,
        }
        : null,
      payouts: v.payouts,
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
    myPlayerId: myId,
    hand,
    seats: seats.map(({ seat, name }) => ({
      playerId: seat.playerId,
      name,
      // Durante una mano, el stack real de quien juega está en el estado de la mano.
      stack: live?.players.find(p => p.id === seat.playerId)?.stack ?? seat.stack,
      status: seat.status,
      online: now - seat.lastSeenAt.getTime() < ONLINE_MS,
      isYou: seat.playerId === myId,
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
  await tx.update(schema.pokerTables).set({ handCount: handNo, button, version: sql`${schema.pokerTables.version} + 1` })
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

async function activeHand(tx: Conn, tableId: string): Promise<HandRow | null> {
  const row = await latestHand(tx, tableId);
  return row?.status === 'active' ? row : null;
}

const bump = sql`${schema.pokerTables.version} + 1`;

// ─── Rutas ───────────────────────────────────────────────────────────────────

export async function tableRoutes(app: FastifyInstance) {
  const tags = ['table'];
  const err = { '4xx': ErrorResponse };
  const base = { tags, params: GroupParams };

  /** Corre fn con la mesa bloqueada y devuelve la vista resultante. */
  const mutate = async (
    req: { group: { id: string }; user: { sub: string } },
    fn: (tx: Tx, table: TableRow) => Promise<void>,
  ) => app.db.transaction(async tx => {
    const table = await ensureTable(tx, req.group.id, true);
    await fn(tx, table);
    const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
    return buildView(tx, fresh, req.user.sub);
  });

  app.get<G>('/table', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => buildView(app.db, await ensureTable(app.db, req.group.id, false), req.user.sub));

  // Sentarse (y heartbeat de presencia: la web lo repite cada ~20 s).
  app.post<G>('/table/join', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    const groupId = req.group.id;
    const playerId = await requirePlayer(tx, groupId, req.user.sub);
    const [seat] = await tx.select().from(schema.pokerSeats)
      .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId)));
    if (seat) {
      await tx.update(schema.pokerSeats).set({ status: 'sitting', lastSeenAt: new Date() })
        .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId)));
      return;
    }
    let stack = 0;
    if (table.status === 'playing') {
      // Se suma con partida en curso: nueva compra de entrada, juega desde la próxima mano.
      stack = table.buyIn;
      const [participant] = await tx.insert(schema.sessionParticipants)
        .values({ groupId, sessionId: table.sessionId as string, playerId }).onConflictDoNothing()
        .returning({ id: schema.sessionParticipants.id });
      if (participant) await tx.insert(schema.buys).values({ participantId: participant.id, amount: table.buyIn, occurredAt: new Date() });
    }
    await tx.insert(schema.pokerSeats).values({ tableId: table.id, groupId, playerId, userId: req.user.sub, stack });
  }));

  app.post<G>('/table/leave', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    const playerId = await requirePlayer(tx, req.group.id, req.user.sub);
    const key = and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId));
    const [seat] = await tx.select().from(schema.pokerSeats).where(key);
    if (!seat) return;
    if (table.status === 'waiting') {
      await tx.delete(schema.pokerSeats).where(key);
      return;
    }
    const hand = await activeHand(tx, table.id);
    const inHand = (hand?.state as HandState | undefined)?.players.find(p => p.id === playerId);
    if (inHand && !inHand.folded) throw new ApiError(409, 'in_hand', 'No podés levantarte en medio de una mano.');
    // Sus fichas quedan en la mesa y cuentan en el resultado final.
    await tx.update(schema.pokerSeats).set({ status: 'out' }).where(key);
  }));

  // Iniciar partida: crea una Session normal con los presentes y reparte la primera mano.
  app.post<G & { Body: Static<typeof StartTableBody> }>('/table/start', {
    schema: { ...base, body: StartTableBody, response: { 200: TableView, ...err } },
  }, async req => {
    const groupId = req.group.id;
    return idempotent(req, async tx => {
      const table = await ensureTable(tx, groupId, true);
      if (table.status !== 'waiting') throw new ApiError(409, 'already_playing', 'Ya hay una partida en juego.');
      const playerId = await requirePlayer(tx, groupId, req.user.sub);
      const cfg = {
        smallBlind: req.body.smallBlind ?? table.smallBlind,
        bigBlind: req.body.bigBlind ?? table.bigBlind,
        buyIn: req.body.buyIn ?? table.buyIn,
      };
      if (cfg.smallBlind > cfg.bigBlind) throw new ApiError(422, 'invalid_blinds', 'La ciega chica no puede superar a la grande.');
      if (cfg.buyIn < cfg.bigBlind * 2) throw new ApiError(422, 'invalid_buy_in', 'La entrada debe ser al menos el doble de la ciega grande.');

      const cutoff = Date.now() - ONLINE_MS;
      const seats = (await loadSeats(tx, table.id)).map(s => s.seat);
      const present = seats.filter(s => s.lastSeenAt.getTime() >= cutoff);
      if (!present.some(s => s.playerId === playerId)) throw new ApiError(409, 'not_seated', 'Sentate en la mesa para iniciar la partida.');
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
      await tx.update(schema.pokerTables).set({ ...cfg, status: 'playing', sessionId, version: bump })
        .where(eq(schema.pokerTables.id, table.id));
      const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      await dealHand(tx, fresh);
      const [after] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return buildView(tx, after, req.user.sub);
    });
  });

  app.post<G>('/table/deal', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    if (table.status !== 'playing') throw new ApiError(409, 'not_playing', 'No hay una partida en juego.');
    await requirePlayer(tx, req.group.id, req.user.sub);
    if (await activeHand(tx, table.id)) throw new ApiError(409, 'hand_in_progress', 'Hay una mano en juego.');
    await dealHand(tx, table);
  }));

  app.post<G & { Body: Static<typeof TableActionBody> }>('/table/action', {
    schema: { ...base, body: TableActionBody, response: { 200: TableView, ...err } },
  }, async req => mutate(req, async (tx, table) => {
    const playerId = await requirePlayer(tx, req.group.id, req.user.sub);
    if (req.body.version !== table.version) {
      throw new ApiError(409, 'stale_state', 'La mesa cambió. Actualizá y volvé a intentar.');
    }
    const hand = await activeHand(tx, table.id);
    if (!hand) throw new ApiError(409, 'no_hand', 'No hay una mano en juego.');
    let next: HandState;
    try {
      next = applyAction(hand.state as HandState, playerId, req.body.action);
    } catch (e) {
      if (e instanceof HoldemError) throw new ApiError(422, 'illegal_action', e.message);
      throw e;
    }
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.pokerActions)
      .where(eq(schema.pokerActions.handId, hand.id));
    await tx.insert(schema.pokerActions).values({ handId: hand.id, seq: n + 1, playerId, action: req.body.action });
    await tx.update(schema.pokerHands).set({ state: next }).where(eq(schema.pokerHands.id, hand.id));
    if (next.street === 'done') await finishHand(tx, hand.id, next);
    await tx.update(schema.pokerTables).set({ version: bump }).where(eq(schema.pokerTables.id, table.id));
  }));

  // Recompra: solo con 0 fichas y fuera de una mano. Suma una compra a la partida.
  app.post<G>('/table/rebuy', {
    schema: { ...base, response: { 200: TableView, ...err } },
  }, async req => {
    const groupId = req.group.id;
    return idempotent(req, async tx => {
      const table = await ensureTable(tx, groupId, true);
      if (table.status !== 'playing') throw new ApiError(409, 'not_playing', 'No hay una partida en juego.');
      const playerId = await requirePlayer(tx, groupId, req.user.sub);
      const seat = (await loadSeats(tx, table.id)).map(s => s.seat).find(s => s.playerId === playerId);
      if (!seat) throw notFound('Asiento');
      const hand = await activeHand(tx, table.id);
      if ((hand?.state as HandState | undefined)?.players.some(p => p.id === playerId)) {
        throw new ApiError(409, 'in_hand', 'Esperá a que termine la mano.');
      }
      if (seat.stack > 0) throw new ApiError(409, 'has_chips', 'Solo podés recomprar sin fichas.');
      const [participant] = await tx.select({ id: schema.sessionParticipants.id }).from(schema.sessionParticipants)
        .where(and(eq(schema.sessionParticipants.sessionId, table.sessionId as string), eq(schema.sessionParticipants.playerId, playerId)));
      await tx.insert(schema.buys).values({ participantId: participant.id, amount: table.buyIn, occurredAt: new Date() });
      await tx.update(schema.pokerSeats).set({ stack: table.buyIn, status: 'sitting' })
        .where(and(eq(schema.pokerSeats.tableId, table.id), eq(schema.pokerSeats.playerId, playerId)));
      await tx.update(schema.pokerTables).set({ version: bump }).where(eq(schema.pokerTables.id, table.id));
      const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return buildView(tx, fresh, req.user.sub);
    });
  });

  // Cerrar: los stacks pasan a ser los resultados finales y se cierra la Session (deudas y ranking).
  app.post<G>('/table/close', {
    schema: { ...base, response: { 200: CloseTableResponse, ...err } },
  }, async req => {
    const groupId = req.group.id;
    return idempotent(req, async tx => {
      const table = await ensureTable(tx, groupId, true);
      if (table.status !== 'playing') throw new ApiError(409, 'not_playing', 'No hay una partida en juego.');
      const playerId = await requirePlayer(tx, groupId, req.user.sub);
      const seats = (await loadSeats(tx, table.id)).map(s => s.seat);
      if (!seats.some(s => s.playerId === playerId)) throw new ApiError(409, 'not_seated', 'Solo quienes están en la mesa pueden cerrarla.');
      if (await activeHand(tx, table.id)) throw new ApiError(409, 'hand_in_progress', 'Esperá a que termine la mano.');
      const sessionId = table.sessionId as string;
      for (const seat of seats) {
        await tx.update(schema.sessionParticipants).set({ finalAmount: seat.stack })
          .where(and(eq(schema.sessionParticipants.sessionId, sessionId), eq(schema.sessionParticipants.playerId, seat.playerId)));
      }
      await closeSessionTx(tx, groupId, sessionId);
      await tx.delete(schema.pokerSeats).where(eq(schema.pokerSeats.tableId, table.id));
      await tx.update(schema.pokerTables).set({ status: 'waiting', sessionId: null, version: bump })
        .where(eq(schema.pokerTables.id, table.id));
      const [fresh] = await tx.select().from(schema.pokerTables).where(eq(schema.pokerTables.id, table.id));
      return { sessionId, table: await buildView(tx, fresh, req.user.sub) };
    });
  });
}
