import { calcDebts, calcParticipant } from './calc';
import type { DebtorGroup, Session } from './types';

export function formatDate(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString('es-AR', { timeZone });
}

export function buildWhatsAppSummary(session: Session, timeZone?: string): string {
  let text = `🃏 *${session.name}* — ${formatDate(session.createdAt, timeZone)}\n\n`;

  const sorted = [...session.participants].sort(
    (a, b) => calcParticipant(b).balance - calcParticipant(a).balance,
  );

  sorted.forEach(p => {
    const { balance } = calcParticipant(p);
    if (p.finalAmount === null) {
      text += `👤 ${p.name}: sin resultado\n`;
    } else {
      const emoji = balance > 0 ? '🏆' : balance < 0 ? '💸' : '🤝';
      const sign = balance > 0 ? '+' : '';
      text += `${emoji} ${p.name}: ${sign}${balance.toLocaleString('es-AR')}$\n`;
    }
  });

  const debts = calcDebts(session);
  if (debts.length > 0) {
    text += `\n💳 *Pagos pendientes:*\n`;
    debts.forEach(d => {
      text += `• ${d.from} le paga $${d.amount.toLocaleString('es-AR')} a ${d.to}\n`;
    });
  }

  const pot = session.participants.reduce((sum, p) => sum + p.buys.reduce((s, b) => s + b.amount, 0), 0);
  text += `\n📊 Pozo total: $${pot.toLocaleString('es-AR')}`;
  return text;
}

export function buildPendingDebtsText(groups: DebtorGroup[]): string {
  if (groups.length === 0) return '🤝 No hay deudas pendientes.';

  let text = `💳 RESUMEN DE PAGOS PENDIENTES\n`;
  groups.forEach(group => {
    text += `\n${group.player.name} paga: $${group.totalPending.toLocaleString('es-AR')}\n`;
    const byCreditor: Record<string, { name: string; total: number }> = {};
    group.debts.forEach(d => {
      const key = d.toPlayer.id;
      if (!byCreditor[key]) byCreditor[key] = { name: d.toPlayer.name, total: 0 };
      byCreditor[key].total += d.pendingAmount;
    });
    Object.values(byCreditor).forEach(creditor => {
      text += `•  A ${creditor.name}: $${creditor.total.toLocaleString('es-AR')}\n`;
    });
  });
  return text;
}
