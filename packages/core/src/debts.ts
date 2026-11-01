/**
 * Ciclo de vida de deudas como transiciones puras: reciben la lista actual y
 * devuelven la nueva. Portado de PokerControl/src/storage/debts.ts; la
 * persistencia y la atomicidad quedan en la capa de servicio.
 */

import { round2 } from './money';
import type {
  Debt, DebtPlayerRef, DebtStatus, DebtTransaction, DebtorGroup, DomainContext, Session,
} from './types';

export const MANUAL_DEBT_SESSION_ID = 'ajuste_previo';
export const CONSOLIDATED_SESSION_ID = 'neteado';

/** Parte manual vigente de una deuda: nunca mayor que lo pendiente. */
export function effectiveManualAmount(debt: Debt): number {
  return Math.min(debt.manualAmount, debt.pendingAmount);
}

interface NetEntry {
  playerA: DebtPlayerRef;
  playerB: DebtPlayerRef;
  net: number;
  manualNet: number;
  payments: Debt['payments'];
  sourceDebts: Debt[];
}

export function netDebts(allDebts: Debt[], ctx: DomainContext): Debt[] {
  const paidDebts = allDebts.filter(d => d.status === 'paid');
  const pendingDebts = allDebts.filter(d => d.status !== 'paid');

  if (pendingDebts.length === 0) return allDebts;

  const netMap: Record<string, NetEntry> = {};

  pendingDebts.forEach(d => {
    const idA = d.fromPlayer.id;
    const idB = d.toPlayer.id;
    const [keyA, keyB] = idA < idB
      ? [d.fromPlayer, d.toPlayer]
      : [d.toPlayer, d.fromPlayer];
    const key = `${keyA.id}|${keyB.id}`;
    const sign = idA === keyA.id ? 1 : -1;

    if (!netMap[key]) {
      netMap[key] = { playerA: keyA, playerB: keyB, net: 0, manualNet: 0, payments: [], sourceDebts: [] };
    }
    netMap[key].net += sign * d.pendingAmount;
    netMap[key].manualNet += sign * effectiveManualAmount(d);
    netMap[key].payments.push(...d.payments);
    netMap[key].sourceDebts.push(d);
  });

  const now = ctx.now();
  const consolidatedDebts: Debt[] = [];

  Object.values(netMap).forEach(({ playerA, playerB, net, manualNet, payments, sourceDebts }) => {
    if (Math.abs(net) < 1) return;

    // Una sola deuda pendiente entre el par: se conserva tal cual, con su partida real.
    if (sourceDebts.length === 1) {
      consolidatedDebts.push(sourceDebts[0]);
      return;
    }

    const fromPlayer = net > 0 ? playerA : playerB;
    const toPlayer = net > 0 ? playerB : playerA;
    const amount = Math.round(Math.abs(net));
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const hasManualSource = sourceDebts.some(d => d.sessionId === MANUAL_DEBT_SESSION_ID);

    consolidatedDebts.push({
      id: ctx.newId(),
      fromPlayer,
      toPlayer,
      sessionId: hasManualSource ? MANUAL_DEBT_SESSION_ID : CONSOLIDATED_SESSION_ID,
      sessionName: hasManualSource ? 'Deuda consolidada (incluye ajuste previo)' : 'Deuda consolidada',
      originalAmount: round2(amount + totalPaid),
      pendingAmount: amount,
      status: payments.length > 0 ? 'partial' : 'pending',
      payments,
      createdAt: now,
      isConsolidated: true,
      manualAmount: round2(net > 0 ? manualNet : -manualNet),
    });
  });

  return [...paidDebts, ...consolidatedDebts];
}

export function generateDebtsFromSession(
  allDebts: Debt[],
  session: Pick<Session, 'id' | 'name'>,
  transactions: DebtTransaction[],
  ctx: DomainContext,
): Debt[] {
  const now = ctx.now();
  const newDebts: Debt[] = transactions.map(t => ({
    id: ctx.newId(),
    fromPlayer: { id: t.fromId, name: t.from },
    toPlayer: { id: t.toId, name: t.to },
    sessionId: session.id,
    sessionName: session.name,
    originalAmount: t.amount,
    pendingAmount: t.amount,
    status: 'pending',
    payments: [],
    createdAt: now,
    isConsolidated: false,
    manualAmount: 0,
  }));
  return netDebts([...allDebts, ...newDebts], ctx);
}

export interface ManualDebtInput {
  fromPlayer: DebtPlayerRef;
  toPlayer: DebtPlayerRef;
  amount: number;
  description?: string;
}

export function addManualDebt(allDebts: Debt[], input: ManualDebtInput, ctx: DomainContext): Debt[] {
  const newDebt: Debt = {
    id: ctx.newId(),
    fromPlayer: input.fromPlayer,
    toPlayer: input.toPlayer,
    sessionId: MANUAL_DEBT_SESSION_ID,
    sessionName: (input.description || '').trim() || 'Ajuste previo',
    originalAmount: input.amount,
    pendingAmount: input.amount,
    status: 'pending',
    payments: [],
    createdAt: ctx.now(),
    isConsolidated: false,
    manualAmount: input.amount,
  };
  return netDebts([...allDebts, newDebt], ctx);
}

/** Solo se borra una manual suelta: una consolidada puede incluir plata de partidas. */
export function canDeleteManualDebt(debt: Debt): boolean {
  return debt.sessionId === MANUAL_DEBT_SESSION_ID && !debt.isConsolidated;
}

export function hasDebtsToReorganize(debts: Debt[]): boolean {
  const counts: Record<string, number> = {};
  debts.filter(d => d.status !== 'paid').forEach(d => {
    const idA = d.fromPlayer.id;
    const idB = d.toPlayer.id;
    const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.values(counts).some(n => n >= 2);
}

function statusFor(pending: number): DebtStatus {
  return pending <= 0 ? 'paid' : 'partial';
}

/** Registra un pago. Recorta a lo pendiente y elimina residuos de punto flotante. */
export function applyPayment(debt: Debt, amount: number, note: string, date: string): Debt {
  const paid = Math.min(amount, debt.pendingAmount);
  const pending = Math.max(0, round2(debt.pendingAmount - paid));
  return {
    ...debt,
    payments: [...debt.payments, { amount: paid, date, note: note.trim() }],
    pendingAmount: pending,
    status: statusFor(pending),
  };
}

export function applyMarkPaid(debt: Debt, date: string): Debt {
  return {
    ...debt,
    payments: debt.pendingAmount > 0
      ? [...debt.payments, { amount: debt.pendingAmount, date, note: 'Saldado' }]
      : debt.payments,
    pendingAmount: 0,
    status: 'paid',
  };
}

export function pendingDebts(debts: Debt[]): Debt[] {
  return debts.filter(d => d.status !== 'paid');
}

export function groupPendingByDebtor(debts: Debt[]): DebtorGroup[] {
  const map: Record<string, DebtorGroup> = {};
  pendingDebts(debts).forEach(d => {
    const key = d.fromPlayer.id;
    if (!map[key]) map[key] = { player: d.fromPlayer, debts: [], totalPending: 0 };
    map[key].debts.push(d);
    map[key].totalPending += d.pendingAmount;
  });
  return Object.values(map).sort((a, b) => b.totalPending - a.totalPending);
}

export function debtsForPlayer(debts: Debt[], playerId: string): { owes: Debt[]; owed: Debt[] } {
  return {
    owes: debts.filter(d => d.fromPlayer.id === playerId),
    owed: debts.filter(d => d.toPlayer.id === playerId),
  };
}

export function debtStatusLabel(status: DebtStatus): string {
  switch (status) {
    case 'paid': return 'Saldada';
    case 'partial': return 'Parcial';
    default: return 'Pendiente';
  }
}
