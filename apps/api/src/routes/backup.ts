import { BackupFile, ErrorResponse, GroupParams, ImportQuery, ImportResult } from '@pokercontrol/contracts';
import { Type, type Static } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { planImport, type BackupData } from '../backup';
import * as schema from '../db/schema';
import { clearBackup, insertDebts, loadDebts, loadPlayers, loadSeasons, loadSessions, lockGroup } from '../repo';

type G = { Params: Static<typeof GroupParams> };

export async function backupRoutes(app: FastifyInstance) {
  const tags = ['backup'];

  app.get<G>('/backup/export', {
    schema: { tags, params: GroupParams, response: { 200: Type.Any(), '4xx': ErrorResponse } },
  }, async req => {
    const groupId = req.group.id;
    const [poker_players, poker_sessions, poker_debts, poker_seasons] = await Promise.all([
      loadPlayers(app.db, groupId), loadSessions(app.db, groupId), loadDebts(app.db, groupId), loadSeasons(app.db, groupId),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      appVersion: 'web-1.0.0',
      data: { poker_players, poker_sessions, poker_debts, poker_seasons },
    };
  });

  app.post<G & { Body: Static<typeof BackupFile>; Querystring: Static<typeof ImportQuery> }>('/backup/import', {
    bodyLimit: 25 * 1024 * 1024,
    schema: { tags, params: GroupParams, querystring: ImportQuery, body: BackupFile, response: { 200: ImportResult, '4xx': ErrorResponse } },
  }, async req => {
    const groupId = req.group.id;
    const plan = planImport(req.body.data as BackupData);
    const dryRun = req.query.dryRun === true;

    if (!dryRun) {
      await app.db.transaction(async tx => {
        await lockGroup(tx, groupId);
        await tx.delete(schema.debts).where(eq(schema.debts.groupId, groupId));
        await clearBackup(tx, groupId);
        await tx.delete(schema.sessions).where(eq(schema.sessions.groupId, groupId));
        await tx.delete(schema.seasons).where(eq(schema.seasons.groupId, groupId));
        await tx.delete(schema.players).where(eq(schema.players.groupId, groupId));

        for (const p of plan.players) {
          await tx.insert(schema.players).values({
            id: p.id, groupId, name: p.name, createdAt: new Date(p.createdAt),
            archivedAt: p.archivedAt ? new Date(p.archivedAt) : null,
          });
          for (const a of p.adjustments ?? []) {
            await tx.insert(schema.playerAdjustments).values({
              id: a.id, groupId, playerId: p.id, description: a.description, amount: a.amount, occurredAt: new Date(a.date),
            });
          }
        }
        for (const s of plan.seasons) {
          await tx.insert(schema.seasons).values({
            id: s.id, groupId, name: s.name, status: s.status, createdAt: new Date(s.createdAt),
            closedAt: s.closedAt ? new Date(s.closedAt) : null,
          });
        }
        for (const s of plan.sessions) {
          await tx.insert(schema.sessions).values({
            id: s.id, groupId, seasonId: s.seasonId as string, name: s.name, status: s.status,
            createdAt: new Date(s.createdAt), closedAt: s.closedAt ? new Date(s.closedAt) : null,
          });
          for (const p of s.participants) {
            const [row] = await tx.insert(schema.sessionParticipants)
              .values({ groupId, sessionId: s.id, playerId: p.playerId, finalAmount: p.finalAmount })
              .returning({ id: schema.sessionParticipants.id });
            if (p.buys.length > 0) {
              await tx.insert(schema.buys).values(p.buys.map(b => ({
                participantId: row.id, amount: b.amount, occurredAt: new Date(b.timestamp),
              })));
            }
          }
        }
        await insertDebts(tx, groupId, plan.debts);
      });
    }

    return {
      dryRun,
      warnings: plan.warnings,
      counts: {
        players: plan.players.length,
        archivedPlayers: plan.archivedPlayers,
        adjustments: plan.adjustments,
        seasons: plan.seasons.length,
        sessions: plan.sessions.length,
        debts: plan.debts.length,
      },
    };
  });
}
