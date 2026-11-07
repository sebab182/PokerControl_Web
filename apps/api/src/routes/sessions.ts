import { randomUUID } from 'node:crypto';
import {
  AddBuyBody, AddParticipantBody, BuyParams, CloseSessionBody, CloseSessionResponse, CreateSessionBody, Deleted,
  ErrorResponse, IdParams, ParticipantParams, SeasonParams, Session, SessionAnalysis, SessionDebtsView, SessionSummary,
  SetFinalAmountBody,
} from '@pokercontrol/contracts';
import {
  POT_TOLERANCE, calcParticipant, calcSession, missingResults, round2,
  type Session as CoreSession,
} from '@pokercontrol/core';
import { Type, type Static } from '@sinclair/typebox';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError, notFound, sessionClosed } from '../errors';
import { sessionInsights } from '../hand-history';
import { idempotent } from '../idempotency';
import {
  insertEntries, loadSessions, lockGroup, lockSession, setBalances, toApiSession, type Conn, type Tx,
} from '../repo';

type I = { Params: Static<typeof IdParams> };

function assertAmount(amount: number): void {
  if (round2(amount) !== amount) throw new ApiError(422, 'invalid_amount', 'El monto admite hasta 2 decimales.');
}

export function defaultSessionName(date: Date, timeZone: string): string {
  const part = (options: Intl.DateTimeFormatOptions) => date.toLocaleDateString('es-AR', { timeZone, ...options });
  return `Party ${part({ day: '2-digit' })}${part({ month: '2-digit' })}${part({ year: '2-digit' })}`;
}

async function findSession(db: Conn, groupId: string, id: string): Promise<CoreSession> {
  const [session] = await loadSessions(db, groupId, { sessionId: id });
  if (!session) throw notFound('Partida');
  return session;
}

/** Bloquea la partida y exige que siga abierta, antes de cualquier cambio. */
async function lockOpen(tx: Tx, groupId: string, id: string): Promise<void> {
  if (!(await lockSession(tx, groupId, id))) throw notFound('Partida');
  const [row] = await tx.select({ status: schema.sessions.status }).from(schema.sessions).where(eq(schema.sessions.id, id));
  if (row.status === 'closed') throw sessionClosed();
}

async function assertUsablePlayers(tx: Tx, groupId: string, ids: string[]): Promise<void> {
  const rows = await tx.select({ id: schema.players.id, archivedAt: schema.players.archivedAt })
    .from(schema.players).where(eq(schema.players.groupId, groupId));
  for (const id of ids) {
    const player = rows.find(p => p.id === id);
    if (!player) throw notFound('Jugador');
    if (player.archivedAt) throw new ApiError(409, 'player_archived', 'El jugador está archivado.');
  }
}

async function findParticipant(tx: Tx, sessionId: string, playerId: string) {
  const [row] = await tx.select({ id: schema.sessionParticipants.id }).from(schema.sessionParticipants)
    .where(and(eq(schema.sessionParticipants.sessionId, sessionId), eq(schema.sessionParticipants.playerId, playerId)));
  if (!row) throw notFound('Participante');
  return row;
}

/**
 * Cierra una partida y genera sus deudas. Compartido con el cierre de la mesa online.
 * Si el pozo no cuadra o faltan resultados exige `confirmedDiff` (409 pot_mismatch).
 */
export async function closeSessionTx(
  tx: Tx, groupId: string, id: string, confirmedDiff?: number, typedBalances: { playerId: string; amount: number }[] = [],
) {
  await lockOpen(tx, groupId, id);
  const session = await findSession(tx, groupId, id);
  const { diff, status } = calcSession(session);
  const missing = missingResults(session);

  const needsConfirmation = Math.abs(diff) > POT_TOLERANCE || missing.length > 0;
  const confirmed = confirmedDiff !== undefined && round2(confirmedDiff) === round2(diff);
  if (needsConfirmation && !confirmed) {
    throw new ApiError(409, 'pot_mismatch', 'El pozo no cuadra o faltan resultados.', {
      diff, status, missingResults: missing,
    });
  }

  await tx.update(schema.sessions).set({ status: 'closed', closedAt: new Date() }).where(eq(schema.sessions.id, id));
  await lockGroup(tx, groupId);
  // El resultado de cada participante con resultado se suma a su saldo; el resto queda igual.
  await insertEntries(tx, groupId, session.participants
    .filter(p => p.finalAmount !== null)
    .map(p => ({ playerId: p.playerId, kind: 'session' as const, sessionId: id, amount: round2(calcParticipant(p).balance) })));
  for (const b of typedBalances) assertAmount(b.amount);
  if (typedBalances.some(b => !session.participants.some(p => p.playerId === b.playerId))) throw notFound('Jugador');
  await setBalances(tx, groupId, id, 'cierre', typedBalances);
  return { session: toApiSession(await findSession(tx, groupId, id)) };
}

export async function sessionRoutes(app: FastifyInstance) {
  const err = { '4xx': ErrorResponse };
  const tags = ['sessions'];

  const fresh = async (conn: Conn, groupId: string, id: string) => toApiSession(await findSession(conn, groupId, id));

  app.get<{ Params: Static<typeof SeasonParams> }>('/seasons/:seasonId/sessions', {
    schema: { tags, params: SeasonParams, response: { 200: Type.Array(SessionSummary), ...err } },
  }, async req => {
    const list = await loadSessions(app.db, req.group.id, { seasonId: req.params.seasonId });
    return list.map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      status: s.status,
      pot: calcSession(s).totalPot,
      playerCount: s.participants.length,
    }));
  });

  app.post<{ Params: Static<typeof SeasonParams>; Body: Static<typeof CreateSessionBody> }>('/seasons/:seasonId/sessions', {
    schema: { tags, params: SeasonParams, body: CreateSessionBody, response: { 200: Session, ...err } },
  }, async req => idempotent(req, async tx => {
    const groupId = req.group.id;
    const { playerIds, initialBuyIn, balances } = req.body;
    const [season] = await tx.select({ id: schema.seasons.id }).from(schema.seasons)
      .where(and(eq(schema.seasons.id, req.params.seasonId), eq(schema.seasons.groupId, groupId)));
    if (!season) throw notFound('Temporada');

    const unique = [...new Set(playerIds)];
    if (unique.length > 0) {
      if (initialBuyIn === undefined) throw new ApiError(422, 'invalid_amount', 'Falta el monto inicial.');
      assertAmount(initialBuyIn);
      await assertUsablePlayers(tx, groupId, unique);
    }

    const id = randomUUID();
    const now = new Date();
    await tx.insert(schema.sessions).values({
      id,
      groupId,
      seasonId: season.id,
      name: req.body.name?.trim() || defaultSessionName(now, req.group.timezone),
      status: 'active',
      createdAt: now,
    });
    for (const playerId of unique) {
      const [participant] = await tx.insert(schema.sessionParticipants)
        .values({ groupId, sessionId: id, playerId }).returning({ id: schema.sessionParticipants.id });
      await tx.insert(schema.buys).values({ participantId: participant.id, amount: initialBuyIn as number, occurredAt: now });
    }
    if (balances && balances.length > 0) {
      for (const b of balances) assertAmount(b.amount);
      if (balances.some(b => !unique.includes(b.playerId))) throw notFound('Jugador');
      await lockGroup(tx, groupId);
      await setBalances(tx, groupId, id, 'inicio', balances);
    }
    return fresh(tx, groupId, id);
  }));

  app.get<I>('/sessions/:id', {
    schema: { tags, params: IdParams, response: { 200: Session, ...err } },
  }, async req => fresh(app.db, req.group.id, req.params.id));

  app.delete<I>('/sessions/:id', {
    schema: { tags, params: IdParams, response: { 200: Deleted, ...err } },
  }, async req => app.db.transaction(async tx => {
    const { id: groupId } = req.group;
    const { id } = req.params;
    if (!(await lockSession(tx, groupId, id))) throw notFound('Partida');
    const [table] = await tx.select({ id: schema.pokerTables.id }).from(schema.pokerTables)
      .where(eq(schema.pokerTables.sessionId, id));
    if (table) throw new ApiError(409, 'session_in_table', 'La partida está en juego en la mesa online. Cerrala desde la mesa.');
    await lockGroup(tx, groupId);
    // Sus movimientos de saldo se borran en cascada: el saldo de cada jugador se recalcula solo.
    await tx.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return { deleted: true };
  }));

  app.post<I & { Body: Static<typeof AddParticipantBody> }>('/sessions/:id/participants', {
    schema: { tags, params: IdParams, body: AddParticipantBody, response: { 200: Session, ...err } },
  }, async req => app.db.transaction(async tx => {
    await lockOpen(tx, req.group.id, req.params.id);
    await assertUsablePlayers(tx, req.group.id, [req.body.playerId]);
    await tx.insert(schema.sessionParticipants)
      .values({ groupId: req.group.id, sessionId: req.params.id, playerId: req.body.playerId })
      .onConflictDoNothing();
    return fresh(tx, req.group.id, req.params.id);
  }));

  app.delete<{ Params: Static<typeof ParticipantParams> }>('/sessions/:id/participants/:playerId', {
    schema: { tags, params: ParticipantParams, response: { 200: Session, ...err } },
  }, async req => app.db.transaction(async tx => {
    await lockOpen(tx, req.group.id, req.params.id);
    const participant = await findParticipant(tx, req.params.id, req.params.playerId);
    await tx.delete(schema.sessionParticipants).where(eq(schema.sessionParticipants.id, participant.id));
    return fresh(tx, req.group.id, req.params.id);
  }));

  app.patch<{ Params: Static<typeof ParticipantParams>; Body: Static<typeof SetFinalAmountBody> }>('/sessions/:id/participants/:playerId', {
    schema: { tags, params: ParticipantParams, body: SetFinalAmountBody, response: { 200: Session, ...err } },
  }, async req => app.db.transaction(async tx => {
    assertAmount(req.body.finalAmount);
    await lockOpen(tx, req.group.id, req.params.id);
    const participant = await findParticipant(tx, req.params.id, req.params.playerId);
    await tx.update(schema.sessionParticipants).set({ finalAmount: req.body.finalAmount })
      .where(eq(schema.sessionParticipants.id, participant.id));
    return fresh(tx, req.group.id, req.params.id);
  }));

  app.post<I & { Body: Static<typeof AddBuyBody> }>('/sessions/:id/buys', {
    schema: { tags, params: IdParams, body: AddBuyBody, response: { 200: Session, ...err } },
  }, async req => idempotent(req, async tx => {
    assertAmount(req.body.amount);
    await lockOpen(tx, req.group.id, req.params.id);
    const participant = await findParticipant(tx, req.params.id, req.body.playerId);
    await tx.insert(schema.buys).values({ participantId: participant.id, amount: req.body.amount, occurredAt: new Date() });
    return fresh(tx, req.group.id, req.params.id);
  }));

  app.delete<{ Params: Static<typeof BuyParams> }>('/sessions/:id/buys/:buyId', {
    schema: { tags, params: BuyParams, response: { 200: Session, ...err } },
  }, async req => app.db.transaction(async tx => {
    await lockOpen(tx, req.group.id, req.params.id);
    const buyId = Number(req.params.buyId);
    if (!Number.isSafeInteger(buyId)) throw notFound('Compra');
    const [buy] = await tx.select({ id: schema.buys.id }).from(schema.buys)
      .innerJoin(schema.sessionParticipants, eq(schema.sessionParticipants.id, schema.buys.participantId))
      .where(and(eq(schema.buys.id, buyId), eq(schema.sessionParticipants.sessionId, req.params.id)));
    if (!buy) throw notFound('Compra');
    await tx.delete(schema.buys).where(eq(schema.buys.id, buyId));
    return fresh(tx, req.group.id, req.params.id);
  }));

  app.post<I & { Body: Static<typeof CloseSessionBody> }>('/sessions/:id/close', {
    schema: { tags, params: IdParams, body: CloseSessionBody, response: { 200: CloseSessionResponse, ...err } },
  }, async req => idempotent(req, tx => closeSessionTx(tx, req.group.id, req.params.id, req.body.confirmedDiff, req.body.balances)));

  app.get<I>('/sessions/:id/debts', {
    schema: { tags, params: IdParams, response: { 200: SessionDebtsView, ...err } },
  }, async req => {
    const session = await findSession(app.db, req.group.id, req.params.id);
    const entries = session.status === 'closed'
      ? await app.db.select().from(schema.balanceEntries)
        .where(eq(schema.balanceEntries.groupId, req.group.id)).orderBy(asc(schema.balanceEntries.id))
      : [];
    const balances = session.participants.map(p => {
      const result = p.finalAmount === null ? null : round2(calcParticipant(p).balance);
      if (session.status !== 'closed') return { playerId: p.playerId, name: p.name, result, before: null, after: null };
      const mine = entries.filter(e => e.playerId === p.playerId);
      const last = Math.max(-1, ...mine.filter(e => e.sessionId === session.id).map(e => e.id));
      if (last < 0) return { playerId: p.playerId, name: p.name, result, before: null, after: null };
      const after = round2(mine.filter(e => e.id <= last).reduce((sum, e) => sum + e.amount, 0));
      // Saldo de partida: lo previo más el ajuste de inicio; el ajuste de cierre va después.
      const closing = mine.filter(e => e.sessionId === session.id && e.note === 'cierre').reduce((sum, e) => sum + e.amount, 0);
      return { playerId: p.playerId, name: p.name, result, before: round2(after - (result ?? 0) - closing), after };
    });
    return {
      sessionStatus: session.status,
      allHaveResult: session.participants.length > 0 && missingResults(session).length === 0,
      balances: balances.sort((a, b) => (b.after ?? b.result ?? -1e12) - (a.after ?? a.result ?? -1e12)),
    };
  });

  // Indicadores y "qué hubiese pasado" de las manos jugadas en la mesa online. Muestra las cartas de todos, así que
  // solo se habilita con la partida cerrada.
  app.get<I>('/sessions/:id/analysis', {
    schema: { tags, params: IdParams, response: { 200: SessionAnalysis, ...err } },
  }, async req => {
    const session = await findSession(app.db, req.group.id, req.params.id);
    if (session.status !== 'closed') {
      throw new ApiError(409, 'analysis_locked', 'El análisis se habilita al cerrar la partida: muestra las cartas de todos.');
    }
    const rows = await app.db.select({ id: schema.players.id, name: schema.players.name }).from(schema.players)
      .where(eq(schema.players.groupId, req.group.id));
    return { names: Object.fromEntries(rows.map(r => [r.id, r.name])), ...(await sessionInsights(app.db, session.id)) };
  });
}
