import {
  CreateSeasonBody, Deleted, ErrorResponse, GroupParams, IdParams, RenameSeasonBody, Season,
} from '@pokercontrol/contracts';
import {
  closeSeason, createSeason, globalRanking, reopenSeason, SeasonRuleError,
  type Season as CoreSeason,
} from '@pokercontrol/core';
import { Type, type Static } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError, notFound } from '../errors';
import { ctx, loadDebts, loadPlayers, loadSeasons, loadSessions, lockGroup, type Conn, type Tx } from '../repo';

type G = { Params: Static<typeof GroupParams> };
type I = { Params: Static<typeof IdParams> };

async function toApiSeasons(db: Conn, groupId: string, list: CoreSeason[]) {
  const [players, sessions, debts] = await Promise.all([
    loadPlayers(db, groupId), loadSessions(db, groupId), loadDebts(db, groupId),
  ]);
  return list.map(season => {
    const own = sessions.filter(s => s.seasonId === season.id);
    const top = own.length > 0 ? globalRanking(players, sessions, debts, season.id)[0] : undefined;
    return {
      ...season,
      sessionCount: own.length,
      openSessionCount: own.filter(s => s.status === 'active').length,
      leader: top ? { playerId: top.playerId, name: top.name, sessionBalance: top.sessionBalance } : null,
    };
  });
}

/** Primero cierra y después activa: el índice único admite una sola activa por grupo. */
async function persistStatuses(tx: Tx, before: CoreSeason[], after: CoreSeason[]): Promise<void> {
  const changed = after.filter(s => {
    const prev = before.find(b => b.id === s.id);
    return prev && prev.status !== s.status;
  });
  for (const s of [...changed].sort(a => (a.status === 'closed' ? -1 : 1))) {
    await tx.update(schema.seasons)
      .set({ status: s.status, closedAt: s.closedAt ? new Date(s.closedAt) : null })
      .where(eq(schema.seasons.id, s.id));
  }
}

function mapRule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SeasonRuleError) {
      throw new ApiError(e.code === 'season_not_found' ? 404 : 409, e.code, e.message);
    }
    throw e;
  }
}

export async function seasonRoutes(app: FastifyInstance) {
  const err = { '4xx': ErrorResponse };
  const tags = ['seasons'];

  const respond = async (groupId: string, id: string) => {
    const [season] = await toApiSeasons(
      app.db, groupId, (await loadSeasons(app.db, groupId)).filter(s => s.id === id),
    );
    return season;
  };

  app.get<G>('/seasons', {
    schema: { tags, params: GroupParams, response: { 200: Type.Array(Season), ...err } },
  }, async req => toApiSeasons(app.db, req.group.id, await loadSeasons(app.db, req.group.id)));

  app.post<G & { Body: Static<typeof CreateSeasonBody> }>('/seasons', {
    schema: { tags, params: GroupParams, body: CreateSeasonBody, response: { 200: Season, ...err } },
  }, async req => {
    const id = await app.db.transaction(async tx => {
      await lockGroup(tx, req.group.id);
      const before = await loadSeasons(tx, req.group.id);
      const { seasons, created } = createSeason(before, req.body.name ?? '', ctx);
      await persistStatuses(tx, before, seasons);
      await tx.insert(schema.seasons).values({
        id: created.id, groupId: req.group.id, name: created.name, status: 'active', createdAt: new Date(created.createdAt),
      });
      return created.id;
    });
    return respond(req.group.id, id);
  });

  const findIn = (list: CoreSeason[], id: string) => {
    if (!list.some(s => s.id === id)) throw notFound('Temporada');
  };

  app.patch<I & { Body: Static<typeof RenameSeasonBody> }>('/seasons/:id', {
    schema: { tags, params: IdParams, body: RenameSeasonBody, response: { 200: Season, ...err } },
  }, async req => {
    const name = req.body.name.trim();
    if (!name) throw new ApiError(422, 'invalid_name', 'El nombre no puede estar vacío.');
    findIn(await loadSeasons(app.db, req.group.id), req.params.id);
    await app.db.update(schema.seasons).set({ name }).where(eq(schema.seasons.id, req.params.id));
    return respond(req.group.id, req.params.id);
  });

  app.post<I>('/seasons/:id/close', {
    schema: { tags, params: IdParams, response: { 200: Season, ...err } },
  }, async req => {
    await app.db.transaction(async tx => {
      await lockGroup(tx, req.group.id);
      const before = await loadSeasons(tx, req.group.id);
      await persistStatuses(tx, before, mapRule(() => closeSeason(before, req.params.id, ctx.now())));
    });
    return respond(req.group.id, req.params.id);
  });

  app.post<I>('/seasons/:id/reopen', {
    schema: { tags, params: IdParams, response: { 200: Season, ...err } },
  }, async req => {
    await app.db.transaction(async tx => {
      await lockGroup(tx, req.group.id);
      const before = await loadSeasons(tx, req.group.id);
      await persistStatuses(tx, before, mapRule(() => reopenSeason(before, req.params.id, ctx.now())));
    });
    return respond(req.group.id, req.params.id);
  });

  app.delete<I>('/seasons/:id', {
    schema: { tags, params: IdParams, response: { 200: Deleted, ...err } },
  }, async req => app.db.transaction(async tx => {
    await lockGroup(tx, req.group.id);
    findIn(await loadSeasons(tx, req.group.id), req.params.id);
    const own = await tx.select({ id: schema.sessions.id }).from(schema.sessions)
      .where(eq(schema.sessions.seasonId, req.params.id)).limit(1);
    if (own.length > 0) {
      throw new ApiError(409, 'season_has_sessions', 'No se puede borrar: esta temporada tiene partidas.');
    }
    await tx.delete(schema.seasons).where(eq(schema.seasons.id, req.params.id));
    return { deleted: true };
  }));
}
