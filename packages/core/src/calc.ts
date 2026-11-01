import type {
  DebtTransaction, Participant, ParticipantCalc, Session, SessionCalc,
} from './types';

/** Diferencia de pozo a partir de la cual se pide confirmación al cerrar. */
export const POT_TOLERANCE = 1;

export function calcParticipant(participant: Participant): ParticipantCalc {
  const totalBought = participant.buys.reduce((sum, b) => sum + b.amount, 0);
  const finalAmount = participant.finalAmount ?? 0;
  const balance = finalAmount - totalBought;
  return { totalBought, finalAmount, balance };
}

export function calcSession(session: Pick<Session, 'participants'>): SessionCalc {
  const totalPot = session.participants.reduce((sum, p) =>
    sum + p.buys.reduce((s, b) => s + b.amount, 0), 0);
  const totalOut = session.participants.reduce((sum, p) =>
    sum + (p.finalAmount ?? 0), 0);
  const diff = totalOut - totalPot;
  const status = diff === 0 ? 'ok' : diff < 0 ? 'faltan' : 'sobran';
  return { totalPot, totalOut, diff, status };
}

/** Participantes sin resultado cargado: quedan fuera de las deudas al cerrar. */
export function missingResults(session: Pick<Session, 'participants'>): string[] {
  return session.participants.filter(p => p.finalAmount === null).map(p => p.playerId);
}

/** Transferencias mínimas (greedy) para saldar los balances de una partida. */
export function calcDebts(session: Pick<Session, 'participants'>): DebtTransaction[] {
  const balances = session.participants
    .filter(p => p.finalAmount !== null)
    .map(p => {
      const totalBought = p.buys.reduce((sum, b) => sum + b.amount, 0);
      const balance = (p.finalAmount ?? 0) - totalBought;
      return { id: p.playerId, name: p.name, balance };
    });

  if (balances.length === 0) return [];

  const debtors = balances
    .filter(b => b.balance < 0)
    .map(b => ({ ...b, balance: Math.abs(b.balance) }));
  const creditors = balances
    .filter(b => b.balance > 0)
    .map(b => ({ ...b }));

  const transactions: DebtTransaction[] = [];
  let i = 0, j = 0;

  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].balance, creditors[j].balance);
    if (amount > 0.5) {
      transactions.push({
        from: debtors[i].name,
        fromId: debtors[i].id,
        to: creditors[j].name,
        toId: creditors[j].id,
        amount: Math.round(amount),
      });
    }
    debtors[i].balance -= amount;
    creditors[j].balance -= amount;
    if (debtors[i].balance < 0.5) i++;
    if (creditors[j].balance < 0.5) j++;
  }
  return transactions;
}
