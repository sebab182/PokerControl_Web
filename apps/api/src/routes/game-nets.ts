/**
 * Lo común de los juegos «contra todos» (blackjack y ruleta): no hay compra inicial, el saldo de cada uno arranca en 0 y
 * puede quedar en negativo, y participa todo el grupo, esté o no conectado. El saldo es lo ganado menos lo perdido en las
 * manos o rondas de la partida; al cerrarla ese saldo es el resultado de cada uno y se generan las deudas.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Conn, Tx } from '../repo';

type SeatRow = typeof schema.pokerSeats.$inferSelect;

/** Nombres de los jugadores, por id (para el análisis de la partida). */
export async function playerNames(db: Conn, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: schema.players.id, name: schema.players.name }).from(schema.players).where(inArray(schema.players.id, ids));
  return new Map(rows.map(r => [r.id, r.name]));
}

export const ONLINE_MS = 45_000;

/** Tiene turno o puede apostar: sentado y conectado (o sentado a mano por un administrador). Los demás del grupo solo cubren. */
export const plays = (s: SeatRow, now = Date.now()): boolean =>
  s.status === 'sitting' && (s.addedBy !== null || now - s.lastSeenAt.getTime() < ONLINE_MS);

/** Saldo de cada participante de una partida de blackjack o ruleta: lo ganado menos lo perdido. Arranca en 0. */
export async function gameNets(db: Conn, sessionId: string | null): Promise<Map<string, number>> {
  if (!sessionId) return new Map();
  const parts = await db.select({ playerId: schema.sessionParticipants.playerId }).from(schema.sessionParticipants)
    .where(eq(schema.sessionParticipants.sessionId, sessionId));
  const nets = new Map(parts.map(p => [p.playerId, 0]));
  const add = (deltas: Record<string, number>) => { for (const [id, delta] of Object.entries(deltas)) nets.set(id, (nets.get(id) ?? 0) + delta); };
  const hands = await db.select({ state: schema.blackjackHands.state }).from(schema.blackjackHands)
    .where(and(eq(schema.blackjackHands.sessionId, sessionId), eq(schema.blackjackHands.status, 'done')));
  for (const h of hands) add(h.state.deltas);
  const rounds = await db.select({ deltas: schema.rouletteRounds.deltas }).from(schema.rouletteRounds)
    .where(and(eq(schema.rouletteRounds.sessionId, sessionId), eq(schema.rouletteRounds.status, 'done')));
  for (const r of rounds) add(r.deltas);
  return nets;
}

/** Los jugadores activos del grupo: la banca, estén o no conectados. */
export async function groupPlayers(db: Conn, groupId: string): Promise<{ id: string; userId: string | null }[]> {
  return db.select({ id: schema.players.id, userId: schema.players.userId }).from(schema.players)
    .where(and(eq(schema.players.groupId, groupId), isNull(schema.players.archivedAt)));
}

/** Deja como resultado de cada participante su saldo (para cerrar la partida). */
export async function finalizeNets(tx: Tx, sessionId: string): Promise<void> {
  for (const [playerId, net] of await gameNets(tx, sessionId)) {
    await tx.update(schema.sessionParticipants).set({ finalAmount: net })
      .where(and(eq(schema.sessionParticipants.sessionId, sessionId), eq(schema.sessionParticipants.playerId, playerId)));
  }
}
