import {
  Debt, DebtorGroup, DebtsQuery, Deleted, ErrorResponse, GroupParams, IdParams, ManualDebtBody, MarkPaidManyBody,
  PaymentBody, ReorganizeStatus,
} from '@pokercontrol/contracts';
import {
  addManualDebt, applyMarkPaid, applyPayment, canDeleteManualDebt, groupPendingByDebtor, hasDebtsToReorganize,
  netDebts, round2, type Debt as CoreDebt,
} from '@pokercontrol/core';
import { Type, type Static } from '@sinclair/typebox';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError, notFound } from '../errors';
import { idempotent } from '../idempotency';
import {
  clearBackup, ctx, insertDebts, loadDebts, lockGroup, saveDebtDiff, saveDebtPayment, toApiDebt, type Conn, type Tx,
} from '../repo';

type G = { Params: Static<typeof GroupParams> };
type I = { Params: Static<typeof IdParams> };

async function reorganizeStatus(db: Conn, groupId: string) {
  const [backup] = await db.select({ reason: schema.debtBackups.invalidatedReason })
    .from(schema.debtBackups).where(eq(schema.debtBackups.groupId, groupId));
  const canReorganize = hasDebtsToReorganize(await loadDebts(db, groupId));
  if (!backup) return { canReorganize, canUndo: false, reason: 'no_backup' as const };
  if (backup.reason) return { canReorganize, canUndo: false, reason: 'has_payments' as const };
  return { canReorganize, canUndo: true, reason: null };
}

/** Un pago hace irreversible la reorganización: deshacer lo pisaría. */
async function invalidateBackup(tx: Tx, groupId: string): Promise<void> {
  await tx.update(schema.debtBackups).set({ invalidatedReason: 'has_payments' })
    .where(and(eq(schema.debtBackups.groupId, groupId), isNull(schema.debtBackups.invalidatedReason)));
}

export async function debtRoutes(app: FastifyInstance) {
  const err = { '4xx': ErrorResponse };
  const tags = ['debts'];
  const debtList = Type.Array(Debt);

  app.get<G & { Querystring: Static<typeof DebtsQuery> }>('/debts', {
    schema: { tags, params: GroupParams, querystring: DebtsQuery, response: { 200: debtList, ...err } },
  }, async req => {
    const { sessionId, status } = req.query;
    return (await loadDebts(app.db, req.group.id))
      .filter(d => (!sessionId || d.sessionId === sessionId) && (!status || d.status === status))
      .map(toApiDebt);
  });

  app.get<G>('/debts/pending-by-debtor', {
    schema: { tags, params: GroupParams, response: { 200: Type.Array(DebtorGroup), ...err } },
  }, async req => groupPendingByDebtor(await loadDebts(app.db, req.group.id))
    .map(g => ({ player: g.player, totalPending: g.totalPending, debts: g.debts.map(toApiDebt) })));

  app.get<G>('/debts/reorganize-status', {
    schema: { tags, params: GroupParams, response: { 200: ReorganizeStatus, ...err } },
  }, async req => reorganizeStatus(app.db, req.group.id));

  const findDebt = (list: CoreDebt[], id: string) => {
    const debt = list.find(d => d.id === id);
    if (!debt) throw notFound('Deuda');
    return debt;
  };

  app.post<I & { Body: Static<typeof PaymentBody> }>('/debts/:id/payments', {
    schema: { tags, params: IdParams, body: PaymentBody, response: { 200: Debt, ...err } },
  }, async req => idempotent(req, async tx => {
    const { amount, note } = req.body;
    if (round2(amount) !== amount) throw new ApiError(422, 'invalid_amount', 'El monto admite hasta 2 decimales.');
    await lockGroup(tx, req.group.id);
    const debt = findDebt(await loadDebts(tx, req.group.id), req.params.id);
    if (debt.status === 'paid') throw new ApiError(409, 'debt_paid', 'La deuda ya está saldada.');
    if (amount > debt.pendingAmount) {
      throw new ApiError(422, 'amount_exceeds_pending', 'El monto supera lo pendiente.', { max: debt.pendingAmount });
    }
    const updated = applyPayment(debt, amount, note ?? '', ctx.now());
    await saveDebtPayment(tx, debt, updated);
    await invalidateBackup(tx, req.group.id);
    return toApiDebt(updated);
  }));

  app.post<I>('/debts/:id/mark-paid', {
    schema: { tags, params: IdParams, response: { 200: Debt, ...err } },
  }, async req => idempotent(req, async tx => {
    await lockGroup(tx, req.group.id);
    const debt = findDebt(await loadDebts(tx, req.group.id), req.params.id);
    const updated = applyMarkPaid(debt, ctx.now());
    await saveDebtPayment(tx, debt, updated);
    await invalidateBackup(tx, req.group.id);
    return toApiDebt(updated);
  }));

  app.post<G & { Body: Static<typeof MarkPaidManyBody> }>('/debts/mark-paid', {
    schema: { tags, params: GroupParams, body: MarkPaidManyBody, response: { 200: debtList, ...err } },
  }, async req => idempotent(req, async tx => {
    await lockGroup(tx, req.group.id);
    const debts = await loadDebts(tx, req.group.id);
    const result: CoreDebt[] = [];
    for (const id of new Set(req.body.debtIds)) {
      const debt = findDebt(debts, id);
      const updated = applyMarkPaid(debt, ctx.now());
      await saveDebtPayment(tx, debt, updated);
      result.push(updated);
    }
    await invalidateBackup(tx, req.group.id);
    return result.map(toApiDebt);
  }));

  app.post<G & { Body: Static<typeof ManualDebtBody> }>('/debts/manual', {
    schema: { tags, params: GroupParams, body: ManualDebtBody, response: { 200: debtList, ...err } },
  }, async req => app.db.transaction(async tx => {
    const { fromPlayerId, toPlayerId, amount, description } = req.body;
    if (round2(amount) !== amount) throw new ApiError(422, 'invalid_amount', 'El monto admite hasta 2 decimales.');
    if (fromPlayerId === toPlayerId) throw new ApiError(422, 'same_player', 'La deuda debe ser entre dos jugadores distintos.');
    await lockGroup(tx, req.group.id);
    const rows = await tx.select().from(schema.players)
      .where(and(eq(schema.players.groupId, req.group.id), inArray(schema.players.id, [fromPlayerId, toPlayerId])));
    const ref = (id: string) => {
      const player = rows.find(p => p.id === id);
      if (!player) throw notFound('Jugador');
      if (player.archivedAt) throw new ApiError(409, 'player_archived', 'El jugador está archivado.');
      return { id: player.id, name: player.name };
    };
    const input = { fromPlayer: ref(fromPlayerId), toPlayer: ref(toPlayerId), amount, description };
    const before = await loadDebts(tx, req.group.id);
    const after = addManualDebt(before, input, ctx);
    await saveDebtDiff(tx, req.group.id, before, after);
    await clearBackup(tx, req.group.id);
    return (await loadDebts(tx, req.group.id)).map(toApiDebt);
  }));

  app.delete<I>('/debts/manual/:id', {
    schema: { tags, params: IdParams, response: { 200: Deleted, ...err } },
  }, async req => app.db.transaction(async tx => {
    await lockGroup(tx, req.group.id);
    const debt = findDebt(await loadDebts(tx, req.group.id), req.params.id);
    if (!canDeleteManualDebt(debt)) {
      throw new ApiError(409, 'debt_not_deletable', 'No se puede borrar: ya se combinó con otra deuda entre estos jugadores.');
    }
    await tx.delete(schema.debts).where(eq(schema.debts.id, debt.id));
    await clearBackup(tx, req.group.id);
    return { deleted: true };
  }));

  app.post<G>('/debts/renet', {
    schema: { tags, params: GroupParams, response: { 200: debtList, ...err } },
  }, async req => app.db.transaction(async tx => {
    await lockGroup(tx, req.group.id);
    const before = await loadDebts(tx, req.group.id);
    await tx.insert(schema.debtBackups)
      .values({ groupId: req.group.id, snapshot: before, savedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.debtBackups.groupId,
        set: { snapshot: before, savedAt: new Date(), invalidatedReason: null },
      });
    await saveDebtDiff(tx, req.group.id, before, netDebts(before, ctx));
    return (await loadDebts(tx, req.group.id)).map(toApiDebt);
  }));

  app.post<G>('/debts/renet/undo', {
    schema: { tags, params: GroupParams, response: { 200: debtList, ...err } },
  }, async req => app.db.transaction(async tx => {
    await lockGroup(tx, req.group.id);
    const status = await reorganizeStatus(tx, req.group.id);
    if (!status.canUndo) {
      throw new ApiError(
        409, 'cannot_undo',
        status.reason === 'has_payments'
          ? 'No se puede deshacer: ya hay pagos registrados sobre las deudas reorganizadas.'
          : 'No hay reorganización para deshacer.',
        { reason: status.reason },
      );
    }
    const [backup] = await tx.select().from(schema.debtBackups).where(eq(schema.debtBackups.groupId, req.group.id));
    await tx.delete(schema.debts).where(eq(schema.debts.groupId, req.group.id));
    await insertDebts(tx, req.group.id, backup.snapshot as CoreDebt[]);
    await clearBackup(tx, req.group.id);
    return (await loadDebts(tx, req.group.id)).map(toApiDebt);
  }));
}
