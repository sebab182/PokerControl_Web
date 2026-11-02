import { randomUUID } from 'node:crypto';
import {
  BalancePayment, CreatePaymentBody, Deleted, ErrorResponse, GroupParams, PaymentParams, PlayerBalance, UpdateBalancesBody,
} from '@pokercontrol/contracts';
import { round2, validatePayment } from '@pokercontrol/core';
import { Type, type Static } from '@sinclair/typebox';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError, notFound } from '../errors';
import { idempotent } from '../idempotency';
import { loadPlayerBalances, lockGroup, setBalances, type Conn, type Tx } from '../repo';
import { isEditor } from './groups';

/** Un usuario común solo puede operar pagos cuyo pagador es su propio jugador. */
async function assertCanActFor(tx: Tx, req: { role: string; user: { sub: string } }, groupId: string, fromPlayerId: string) {
  if (isEditor(req.role as never)) return;
  const [own] = await tx.select({ id: schema.players.id }).from(schema.players).where(and(
    eq(schema.players.groupId, groupId), eq(schema.players.id, fromPlayerId), eq(schema.players.userId, req.user.sub),
  ));
  if (!own) throw new ApiError(403, 'not_your_payment', 'Solo podés registrar pagos a tu nombre.');
}

async function loadPayments(db: Conn, groupId: string, onlyId?: string) {
  const rows = await db.select().from(schema.balanceEntries)
    .where(and(
      eq(schema.balanceEntries.groupId, groupId),
      eq(schema.balanceEntries.kind, 'payment'),
      isNotNull(schema.balanceEntries.paymentId),
      ...(onlyId ? [eq(schema.balanceEntries.paymentId, onlyId)] : []),
    ))
    .orderBy(asc(schema.balanceEntries.id));
  const names = new Map((await db.select({ id: schema.players.id, name: schema.players.name })
    .from(schema.players).where(eq(schema.players.groupId, groupId))).map(p => [p.id, p.name]));
  // El pagador es la fila con monto positivo (su deuda sube hacia cero).
  return rows.filter(r => r.amount > 0).map(r => ({
    id: r.paymentId as string,
    fromPlayer: { id: r.playerId, name: names.get(r.playerId) ?? '' },
    toPlayer: { id: r.counterpartPlayerId as string, name: names.get(r.counterpartPlayerId as string) ?? '' },
    amount: r.amount,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  })).reverse();
}

export async function balanceRoutes(app: FastifyInstance) {
  const err = { '4xx': ErrorResponse };
  const tags = ['balances'];

  app.get<{ Params: Static<typeof GroupParams> }>('/balances', {
    schema: { tags, params: GroupParams, response: { 200: Type.Array(PlayerBalance), ...err } },
  }, async req => loadPlayerBalances(app.db, req.group.id));

  /** Fija el saldo real de los jugadores indicados; guarda la diferencia como ajuste. */
  app.put<{ Params: Static<typeof GroupParams>; Body: Static<typeof UpdateBalancesBody> }>('/balances', {
    schema: { tags, params: GroupParams, body: UpdateBalancesBody, response: { 200: Type.Array(PlayerBalance), ...err } },
  }, async req => app.db.transaction(async tx => {
    const { id: groupId } = req.group;
    const { balances, note } = req.body;
    if (balances.some(b => round2(b.amount) !== b.amount)) {
      throw new ApiError(422, 'invalid_amount', 'El monto admite hasta 2 decimales.');
    }
    await lockGroup(tx, groupId);
    const known = new Map((await loadPlayerBalances(tx, groupId)).map(b => [b.playerId, b]));
    for (const b of balances) {
      const player = known.get(b.playerId);
      if (!player) throw notFound('Jugador');
      if (player.archived) throw new ApiError(409, 'player_archived', 'El jugador está archivado.');
    }
    await setBalances(tx, groupId, null, note?.trim() || 'actualización manual', balances);
    return loadPlayerBalances(tx, groupId);
  }));

  app.get<{ Params: Static<typeof GroupParams> }>('/payments', {
    schema: { tags, params: GroupParams, response: { 200: Type.Array(BalancePayment), ...err } },
  }, async req => loadPayments(app.db, req.group.id));
}

/**
 * Registrar y deshacer pagos: los editores operan sobre cualquiera; un usuario común,
 * solo sobre pagos hechos A SU NOMBRE (el pagador es su jugador).
 */
export async function paymentRoutes(app: FastifyInstance) {
  const err = { '4xx': ErrorResponse };
  const tags = ['balances'];

  app.post<{ Params: Static<typeof GroupParams>; Body: Static<typeof CreatePaymentBody> }>('/payments', {
    schema: { tags, params: GroupParams, body: CreatePaymentBody, response: { 200: BalancePayment, ...err } },
  }, async req => idempotent(req, async tx => {
    const { id: groupId } = req.group;
    const { fromPlayerId, toPlayerId, amount, note } = req.body;
    await assertCanActFor(tx, req, groupId, fromPlayerId);
    if (round2(amount) !== amount) throw new ApiError(422, 'invalid_amount', 'El monto admite hasta 2 decimales.');
    if (fromPlayerId === toPlayerId) throw new ApiError(422, 'invalid_payment', 'Elegí dos jugadores distintos.');
    await lockGroup(tx, groupId);
    const balances = await loadPlayerBalances(tx, groupId);
    const from = balances.find(b => b.playerId === fromPlayerId);
    const to = balances.find(b => b.playerId === toPlayerId);
    if (!from || !to) throw notFound('Jugador');
    const problem = validatePayment(from.balance, to.balance, amount);
    if (problem) throw new ApiError(422, 'invalid_payment', problem);

    const paymentId = randomUUID();
    const base = { groupId, kind: 'payment' as const, paymentId, note: note?.trim() ?? '' };
    await tx.insert(schema.balanceEntries).values([
      { ...base, playerId: fromPlayerId, counterpartPlayerId: toPlayerId, amount },
      { ...base, playerId: toPlayerId, counterpartPlayerId: fromPlayerId, amount: -amount },
    ]);
    return (await loadPayments(tx, groupId, paymentId))[0];
  }));

  app.delete<{ Params: Static<typeof PaymentParams> }>('/payments/:paymentId', {
    schema: { tags, params: PaymentParams, response: { 200: Deleted, ...err } },
  }, async req => app.db.transaction(async tx => {
    const { id: groupId } = req.group;
    await lockGroup(tx, groupId);
    const [payment] = await loadPayments(tx, groupId, req.params.paymentId);
    if (!payment) throw notFound('Pago');
    await assertCanActFor(tx, req, groupId, payment.fromPlayer.id);
    await tx.delete(schema.balanceEntries).where(and(
      eq(schema.balanceEntries.groupId, groupId), eq(schema.balanceEntries.paymentId, req.params.paymentId),
    ));
    return { deleted: true };
  }));
}
