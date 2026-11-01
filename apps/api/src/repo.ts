/**
 * Traducción entre filas de Postgres y modelos del core, más los bloqueos.
 * Todo se ejecuta dentro de la transacción de cada operación.
 */

import { randomUUID } from 'node:crypto';
import {
  CONSOLIDATED_SESSION_ID, MANUAL_DEBT_SESSION_ID, calcSession, missingResults,
  type Debt, type DomainContext, type Player, type Season, type Session,
} from '@pokercontrol/core';
import type { ApiDebt, ApiSession } from '@pokercontrol/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './db/schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Conn = Db | Tx;

export const ctx: DomainContext = {
  newId: () => randomUUID(),
  now: () => new Date().toISOString(),
};

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/** Serializa las mutaciones de deudas de un grupo. No bloquea inserts con FK a groups. */
export async function lockGroup(tx: Tx, groupId: string): Promise<void> {
  await tx.execute(sql`select id from groups where id = ${groupId} for no key update`);
}

/** Serializa compras, resultados, participantes, cierre y borrado de una partida. */
export async function lockSession(tx: Tx, groupId: string, sessionId: string): Promise<boolean> {
  const r = await tx.execute(
    sql`select id from sessions where id = ${sessionId} and group_id = ${groupId} for no key update`,
  );
  return r.rows.length > 0;
}

export async function loadPlayers(db: Conn, groupId: string): Promise<Player[]> {
  const rows = await db.select().from(schema.players)
    .where(eq(schema.players.groupId, groupId))
    .orderBy(asc(schema.players.createdAt), asc(schema.players.id));
  const adjustments = await db.select().from(schema.playerAdjustments)
    .where(eq(schema.playerAdjustments.groupId, groupId));
  return rows.map(p => ({
    id: p.id,
    name: p.name,
    createdAt: iso(p.createdAt),
    archivedAt: isoOrNull(p.archivedAt),
    adjustments: adjustments.filter(a => a.playerId === p.id).map(a => ({
      id: a.id, description: a.description, amount: a.amount, date: iso(a.occurredAt),
    })),
  }));
}

export async function loadSeasons(db: Conn, groupId: string): Promise<Season[]> {
  const rows = await db.select().from(schema.seasons)
    .where(eq(schema.seasons.groupId, groupId))
    .orderBy(desc(schema.seasons.createdAt), desc(schema.seasons.id));
  return rows.map(s => ({
    id: s.id, name: s.name, createdAt: iso(s.createdAt), closedAt: isoOrNull(s.closedAt), status: s.status,
  }));
}

/** Partidas completas, de la más nueva a la más vieja. */
export async function loadSessions(
  db: Conn, groupId: string, filter: { seasonId?: string; sessionId?: string } = {},
): Promise<Session[]> {
  const where = [eq(schema.sessions.groupId, groupId)];
  if (filter.seasonId) where.push(eq(schema.sessions.seasonId, filter.seasonId));
  if (filter.sessionId) where.push(eq(schema.sessions.id, filter.sessionId));
  const rows = await db.select().from(schema.sessions).where(and(...where))
    .orderBy(desc(schema.sessions.createdAt), desc(schema.sessions.id));
  if (rows.length === 0) return [];

  const sessionIds = rows.map(r => r.id);
  const participants = await db.select({
    id: schema.sessionParticipants.id,
    sessionId: schema.sessionParticipants.sessionId,
    playerId: schema.sessionParticipants.playerId,
    finalAmount: schema.sessionParticipants.finalAmount,
    name: schema.players.name,
  }).from(schema.sessionParticipants)
    .innerJoin(schema.players, eq(schema.players.id, schema.sessionParticipants.playerId))
    .where(inArray(schema.sessionParticipants.sessionId, sessionIds))
    .orderBy(asc(schema.sessionParticipants.id));
  const participantIds = participants.map(p => p.id);
  const buyRows = participantIds.length === 0 ? [] : await db.select().from(schema.buys)
    .where(inArray(schema.buys.participantId, participantIds))
    .orderBy(asc(schema.buys.occurredAt), asc(schema.buys.id));

  return rows.map(s => ({
    id: s.id,
    name: s.name,
    createdAt: iso(s.createdAt),
    closedAt: isoOrNull(s.closedAt),
    status: s.status,
    seasonId: s.seasonId,
    participants: participants.filter(p => p.sessionId === s.id).map(p => ({
      playerId: p.playerId,
      name: p.name,
      finalAmount: p.finalAmount,
      buys: buyRows.filter(b => b.participantId === p.id).map(b => ({
        id: String(b.id), amount: b.amount, timestamp: iso(b.occurredAt),
      })),
    })),
  }));
}

export async function loadDebts(db: Conn, groupId: string): Promise<Debt[]> {
  const rows = await db.select().from(schema.debts)
    .where(eq(schema.debts.groupId, groupId))
    .orderBy(asc(schema.debts.createdAt), asc(schema.debts.id));
  if (rows.length === 0) return [];
  const names = await db.select({ id: schema.players.id, name: schema.players.name })
    .from(schema.players).where(eq(schema.players.groupId, groupId));
  const nameOf = new Map(names.map(n => [n.id, n.name]));
  const payments = await db.select().from(schema.debtPayments)
    .where(inArray(schema.debtPayments.debtId, rows.map(r => r.id)))
    .orderBy(asc(schema.debtPayments.paidAt), asc(schema.debtPayments.id));

  return rows.map(d => ({
    id: d.id,
    fromPlayer: { id: d.fromPlayerId, name: nameOf.get(d.fromPlayerId) ?? '' },
    toPlayer: { id: d.toPlayerId, name: nameOf.get(d.toPlayerId) ?? '' },
    sessionId: d.sourceType === 'manual' ? MANUAL_DEBT_SESSION_ID
      : d.sourceType === 'consolidated' ? CONSOLIDATED_SESSION_ID
        : d.sessionId as string,
    sessionName: d.label,
    originalAmount: d.originalAmount,
    pendingAmount: d.pendingAmount,
    manualAmount: d.manualAmount,
    status: d.status,
    isConsolidated: d.isConsolidated,
    createdAt: iso(d.createdAt),
    payments: payments.filter(p => p.debtId === d.id).map(p => ({
      amount: p.amount, date: iso(p.paidAt), note: p.note,
    })),
  }));
}

export async function insertDebts(tx: Tx, groupId: string, list: Debt[]): Promise<void> {
  for (const d of list) {
    const manual = d.sessionId === MANUAL_DEBT_SESSION_ID;
    const consolidated = d.sessionId === CONSOLIDATED_SESSION_ID;
    await tx.insert(schema.debts).values({
      id: d.id,
      groupId,
      fromPlayerId: d.fromPlayer.id,
      toPlayerId: d.toPlayer.id,
      sessionId: manual || consolidated ? null : d.sessionId,
      sourceType: manual ? 'manual' : consolidated ? 'consolidated' : 'session',
      label: d.sessionName,
      originalAmount: d.originalAmount,
      pendingAmount: d.pendingAmount,
      manualAmount: d.manualAmount,
      status: d.status,
      isConsolidated: d.isConsolidated,
      createdAt: new Date(d.createdAt),
    });
    if (d.payments.length > 0) {
      await tx.insert(schema.debtPayments).values(d.payments.map(p => ({
        debtId: d.id, amount: p.amount, paidAt: new Date(p.date), note: p.note,
      })));
    }
  }
}

/** Aplica la diferencia entre dos listas de deudas: las transiciones solo agregan o quitan filas. */
export async function saveDebtDiff(tx: Tx, groupId: string, before: Debt[], after: Debt[]): Promise<void> {
  const beforeIds = new Set(before.map(d => d.id));
  const afterIds = new Set(after.map(d => d.id));
  const removed = before.filter(d => !afterIds.has(d.id)).map(d => d.id);
  if (removed.length > 0) await tx.delete(schema.debts).where(inArray(schema.debts.id, removed));
  await insertDebts(tx, groupId, after.filter(d => !beforeIds.has(d.id)));
}

/** Persiste una deuda tras un pago: actualiza saldo y agrega los pagos nuevos. */
export async function saveDebtPayment(tx: Tx, before: Debt, after: Debt): Promise<void> {
  await tx.update(schema.debts)
    .set({ pendingAmount: after.pendingAmount, status: after.status })
    .where(eq(schema.debts.id, after.id));
  const added = after.payments.slice(before.payments.length);
  if (added.length > 0) {
    await tx.insert(schema.debtPayments).values(added.map(p => ({
      debtId: after.id, amount: p.amount, paidAt: new Date(p.date), note: p.note,
    })));
  }
}

export async function clearBackup(tx: Tx, groupId: string): Promise<void> {
  await tx.delete(schema.debtBackups).where(eq(schema.debtBackups.groupId, groupId));
}

export function toApiDebt(d: Debt): ApiDebt {
  const manual = d.sessionId === MANUAL_DEBT_SESSION_ID;
  const consolidated = d.sessionId === CONSOLIDATED_SESSION_ID;
  return {
    id: d.id,
    fromPlayer: d.fromPlayer,
    toPlayer: d.toPlayer,
    sessionId: manual || consolidated ? null : d.sessionId,
    sourceType: manual ? 'manual' : consolidated ? 'consolidated' : 'session',
    label: d.sessionName,
    originalAmount: d.originalAmount,
    pendingAmount: d.pendingAmount,
    status: d.status,
    payments: d.payments,
    createdAt: d.createdAt,
    isConsolidated: d.isConsolidated,
    manualAmount: d.manualAmount,
  };
}

export function toApiSession(s: Session): ApiSession {
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    closedAt: s.closedAt ?? null,
    status: s.status,
    seasonId: s.seasonId as string,
    participants: s.participants.map(p => ({
      playerId: p.playerId,
      name: p.name,
      finalAmount: p.finalAmount,
      buys: p.buys.map(b => ({ id: b.id as string, amount: b.amount, timestamp: b.timestamp })),
    })),
    calc: calcSession(s),
    missingResults: missingResults(s),
  };
}
