import { randomUUID } from 'node:crypto';
import {
  AdjustmentBody, AdjustmentParams, ClaimPlayerBody, CreatePlayerBody, Deleted, DeletePlayerResponse, ErrorResponse,
  GroupParams, IdParams, LinkPlayerBody, Player, PlayerDebts, PlayerReportResponse, PlayersQuery, PlayerStatsResponse,
  RankingEntry, SeasonQuery, UpdatePlayerBody,
} from '@pokercontrol/contracts';
import { buildPlayerReport, debtsForPlayer, globalRanking, playerStats, round2, type Player as CorePlayer } from '@pokercontrol/core';
import { Type, type Static } from '@sinclair/typebox';
import { and, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError, notFound } from '../errors';
import { loadDebts, loadPlayers, loadSessions, lockGroup, toApiDebt, type Conn } from '../repo';

type G = { Params: Static<typeof GroupParams> };
type I = { Params: Static<typeof IdParams> };
type A = { Params: Static<typeof AdjustmentParams> };

const toApi = (p: CorePlayer, linked: boolean) => ({
  id: p.id, name: p.name, createdAt: p.createdAt, archivedAt: p.archivedAt ?? null, linked, adjustments: p.adjustments ?? [],
});

/** Aparte de loadPlayers, porque esos modelos se exportan al backup: no llevan usuarios. */
async function linkedPlayerIds(db: Conn, groupId: string): Promise<Set<string>> {
  const rows = await db.select({ id: schema.players.id }).from(schema.players)
    .where(and(eq(schema.players.groupId, groupId), isNotNull(schema.players.userId)));
  return new Set(rows.map(r => r.id));
}

async function apiPlayer(db: Conn, groupId: string, id: string) {
  const player = await findPlayer(db, groupId, id);
  return toApi(player, (await linkedPlayerIds(db, groupId)).has(id));
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ApiError(422, 'invalid_name', 'El nombre no puede estar vacío.');
  return name;
}

function assertAmount(amount: number): void {
  if (round2(amount) !== amount) throw new ApiError(422, 'invalid_amount', 'El monto admite hasta 2 decimales.');
}

async function findPlayer(db: Conn, groupId: string, id: string): Promise<CorePlayer> {
  const player = (await loadPlayers(db, groupId)).find(p => p.id === id);
  if (!player) throw notFound('Jugador');
  return player;
}

/** Historial: participante, deuda, ajuste o aparición en el snapshot de deshacer. */
async function hasHistory(db: Conn, groupId: string, playerId: string): Promise<boolean> {
  // Secuencial: puede correr dentro de una transacción, que usa una sola conexión.
  const queries = [
    () => db.select({ id: schema.sessionParticipants.id }).from(schema.sessionParticipants)
      .where(eq(schema.sessionParticipants.playerId, playerId)).limit(1),
    () => db.select({ id: schema.debts.id }).from(schema.debts)
      .where(or(eq(schema.debts.fromPlayerId, playerId), eq(schema.debts.toPlayerId, playerId))).limit(1),
    () => db.select({ id: schema.playerAdjustments.id }).from(schema.playerAdjustments)
      .where(eq(schema.playerAdjustments.playerId, playerId)).limit(1),
    () => db.select({ groupId: schema.debtBackups.groupId }).from(schema.debtBackups)
      .where(and(
        eq(schema.debtBackups.groupId, groupId),
        sql`${schema.debtBackups.snapshot}::text like ${`%"${playerId}"%`}`,
      )).limit(1),
  ];
  for (const query of queries) {
    if ((await query()).length > 0) return true;
  }
  return false;
}

export async function claimPlayerRoutes(app: FastifyInstance) {
  app.post<G & { Body: Static<typeof ClaimPlayerBody> }>('/me/player', {
    schema: { tags: ['players'], params: GroupParams, body: ClaimPlayerBody, response: { 200: Player, '4xx': ErrorResponse } },
  }, async req => app.db.transaction(async tx => {
    const groupId = req.group.id;
    const { playerId, name } = req.body;
    if ((playerId === undefined) === (name === undefined)) {
      throw new ApiError(422, 'invalid_claim', 'Elegí un jugador o ingresá un nick nuevo.');
    }
    await lockGroup(tx, groupId);
    const rows = await tx.select().from(schema.players).where(eq(schema.players.groupId, groupId));
    if (rows.some(p => p.userId === req.user.sub)) {
      throw new ApiError(409, 'already_linked', 'Ya tenés un jugador en este grupo.');
    }
    if (playerId !== undefined) {
      const player = rows.find(p => p.id === playerId);
      if (!player) throw notFound('Jugador');
      if (player.archivedAt) throw new ApiError(409, 'player_archived', 'El jugador está archivado.');
      if (player.userId) throw new ApiError(409, 'player_taken', 'Ese jugador ya está asociado a otro usuario.');
      await tx.update(schema.players).set({ userId: req.user.sub }).where(eq(schema.players.id, playerId));
      return apiPlayer(tx, groupId, playerId);
    }
    const nick = cleanName(name as string);
    const same = rows.find(p => !p.archivedAt && p.name.toLowerCase() === nick.toLowerCase());
    if (same) {
      throw new ApiError(409, 'player_name_taken', `Ya existe un jugador "${same.name}". Si sos vos y está libre, elegilo de la lista.`);
    }
    const id = randomUUID();
    await tx.insert(schema.players).values({ id, groupId, name: nick, userId: req.user.sub });
    return apiPlayer(tx, groupId, id);
  }));
}

export async function playerRoutes(app: FastifyInstance) {
  const err = { '4xx': ErrorResponse };
  const tags = ['players'];

  app.get<G & { Querystring: Static<typeof PlayersQuery> }>('/players', {
    schema: { tags, params: GroupParams, querystring: PlayersQuery, response: { 200: Type.Array(Player), ...err } },
  }, async req => {
    const players = await loadPlayers(app.db, req.group.id);
    const linked = await linkedPlayerIds(app.db, req.group.id);
    return (req.query.includeArchived ? players : players.filter(p => !p.archivedAt)).map(p => toApi(p, linked.has(p.id)));
  });

  app.post<I & { Body: Static<typeof LinkPlayerBody> }>('/players/:id/user', {
    schema: { tags, params: IdParams, body: LinkPlayerBody, response: { 200: Player, ...err } },
  }, async req => app.db.transaction(async tx => {
    const groupId = req.group.id;
    const { userId } = req.body;
    await lockGroup(tx, groupId);
    const player = await findPlayer(tx, groupId, req.params.id);
    if (userId !== null) {
      if (player.archivedAt) throw new ApiError(409, 'player_archived', 'El jugador está archivado.');
      const [user] = await tx.select({ role: schema.users.role, member: schema.groupMembers.userId }).from(schema.users)
        .leftJoin(schema.groupMembers, and(
          eq(schema.groupMembers.groupId, groupId),
          eq(schema.groupMembers.userId, schema.users.id),
        ))
        .where(eq(schema.users.id, userId));
      if (!user || (!user.member && user.role === 'reader')) {
        throw new ApiError(422, 'invalid_user', 'Ese usuario no pertenece al grupo.');
      }
      await tx.update(schema.players).set({ userId: null }).where(and(
        eq(schema.players.groupId, groupId), eq(schema.players.userId, userId), ne(schema.players.id, player.id),
      ));
    }
    await tx.update(schema.players).set({ userId }).where(eq(schema.players.id, player.id));
    return apiPlayer(tx, groupId, player.id);
  }));

  app.post<G & { Body: Static<typeof CreatePlayerBody> }>('/players', {
    schema: { tags, params: GroupParams, body: CreatePlayerBody, response: { 200: Player, ...err } },
  }, async req => {
    const id = randomUUID();
    await app.db.insert(schema.players).values({ id, groupId: req.group.id, name: cleanName(req.body.name) });
    return apiPlayer(app.db, req.group.id, id);
  });

  app.patch<I & { Body: Static<typeof UpdatePlayerBody> }>('/players/:id', {
    schema: { tags, params: IdParams, body: UpdatePlayerBody, response: { 200: Player, ...err } },
  }, async req => {
    await findPlayer(app.db, req.group.id, req.params.id);
    await app.db.update(schema.players).set({ name: cleanName(req.body.name) }).where(eq(schema.players.id, req.params.id));
    return apiPlayer(app.db, req.group.id, req.params.id);
  });

  app.delete<I>('/players/:id', {
    schema: { tags, params: IdParams, response: { 200: DeletePlayerResponse, ...err } },
  }, async req => app.db.transaction(async tx => {
    await findPlayer(tx, req.group.id, req.params.id);
    if (await hasHistory(tx, req.group.id, req.params.id)) {
      await tx.update(schema.players).set({ archivedAt: new Date() }).where(eq(schema.players.id, req.params.id));
      return { archived: true };
    }
    await tx.delete(schema.players).where(eq(schema.players.id, req.params.id));
    return { archived: false };
  }));

  app.post<I>('/players/:id/unarchive', {
    schema: { tags, params: IdParams, response: { 200: Player, ...err } },
  }, async req => {
    await findPlayer(app.db, req.group.id, req.params.id);
    await app.db.update(schema.players).set({ archivedAt: null }).where(eq(schema.players.id, req.params.id));
    return apiPlayer(app.db, req.group.id, req.params.id);
  });

  app.post<I & { Body: Static<typeof AdjustmentBody> }>('/players/:id/adjustments', {
    schema: { tags, params: IdParams, body: AdjustmentBody, response: { 200: Player, ...err } },
  }, async req => {
    assertAmount(req.body.amount);
    await findPlayer(app.db, req.group.id, req.params.id);
    await app.db.insert(schema.playerAdjustments).values({
      id: randomUUID(),
      groupId: req.group.id,
      playerId: req.params.id,
      description: req.body.description.trim(),
      amount: req.body.amount,
      occurredAt: new Date(),
    });
    return apiPlayer(app.db, req.group.id, req.params.id);
  });

  const adjustmentWhere = (req: { group: { id: string }; params: A['Params'] }) => and(
    eq(schema.playerAdjustments.id, req.params.adjustmentId),
    eq(schema.playerAdjustments.playerId, req.params.id),
    eq(schema.playerAdjustments.groupId, req.group.id),
  );

  app.patch<A & { Body: Static<typeof AdjustmentBody> }>('/players/:id/adjustments/:adjustmentId', {
    schema: { tags, params: AdjustmentParams, body: AdjustmentBody, response: { 200: Player, ...err } },
  }, async req => {
    assertAmount(req.body.amount);
    const updated = await app.db.update(schema.playerAdjustments)
      .set({ description: req.body.description.trim(), amount: req.body.amount })
      .where(adjustmentWhere(req)).returning({ id: schema.playerAdjustments.id });
    if (updated.length === 0) throw notFound('Ajuste');
    return apiPlayer(app.db, req.group.id, req.params.id);
  });

  app.delete<A>('/players/:id/adjustments/:adjustmentId', {
    schema: { tags, params: AdjustmentParams, response: { 200: Deleted, ...err } },
  }, async req => {
    const deleted = await app.db.delete(schema.playerAdjustments)
      .where(adjustmentWhere(req)).returning({ id: schema.playerAdjustments.id });
    if (deleted.length === 0) throw notFound('Ajuste');
    return { deleted: true };
  });

  app.get<I & { Querystring: Static<typeof SeasonQuery> }>('/players/:id/stats', {
    schema: { tags, params: IdParams, querystring: SeasonQuery, response: { 200: PlayerStatsResponse, ...err } },
  }, async req => {
    const player = await findPlayer(app.db, req.group.id, req.params.id);
    const [sessions, debts] = await Promise.all([loadSessions(app.db, req.group.id), loadDebts(app.db, req.group.id)]);
    return playerStats(player, player.id, sessions, debts, req.query.seasonId);
  });

  app.get<I & { Querystring: Static<typeof SeasonQuery> }>('/players/:id/report', {
    schema: { tags, params: IdParams, querystring: SeasonQuery, response: { 200: PlayerReportResponse, ...err } },
  }, async req => {
    const player = await findPlayer(app.db, req.group.id, req.params.id);
    return buildPlayerReport(player.id, await loadSessions(app.db, req.group.id), req.query.seasonId);
  });

  app.get<I>('/players/:id/debts', {
    schema: { tags, params: IdParams, response: { 200: PlayerDebts, ...err } },
  }, async req => {
    const player = await findPlayer(app.db, req.group.id, req.params.id);
    const { owes, owed } = debtsForPlayer(await loadDebts(app.db, req.group.id), player.id);
    return { owes: owes.map(toApiDebt), owed: owed.map(toApiDebt) };
  });

  app.get<G & { Querystring: Static<typeof SeasonQuery> }>('/ranking', {
    schema: { tags: ['ranking'], params: GroupParams, querystring: SeasonQuery, response: { 200: Type.Array(RankingEntry), ...err } },
  }, async req => {
    const [players, sessions, debts] = await Promise.all([
      loadPlayers(app.db, req.group.id), loadSessions(app.db, req.group.id), loadDebts(app.db, req.group.id),
    ]);
    return globalRanking(players, sessions, debts, req.query.seasonId);
  });
}
